/**
 * Cloudflare API client for Glide.
 *
 * Ported from switchflare's `web/worker/cf-api.ts`: retry/backoff on 429/5xx,
 * typed error classification, and a permission-recommendation map so failures
 * tell you which token permission is missing. Returns STRUCTURED results
 * (never throws on API errors) so the LLM tools can surface friendly messages.
 */

import { canonicalizeApiPath, canonicalizeDomainName } from "./api-path.ts";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

const PERMISSION_CF_CODES = new Set([9109, 10000]);
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES_GET = 3;
// Never blindly retry a write: the API may have committed it before a timeout or
// lost response. The approval layer records uncertain outcomes for verification.
const MAX_RETRIES_WRITE = 0;
const BACKOFF_FACTOR_MS = 1500;
const TIMEOUT_READ_MS = 25_000;
const TIMEOUT_WRITE_MS = 60_000;
export const MAX_CF_API_RESPONSE_BYTES = 2_000_000;
export const MAX_CF_API_PAGINATION_BYTES = 8_000_000;
export const MAX_CF_API_PAGES = 50;

export type ApiErrorCategory =
  | "auth"
  | "permission"
  | "not_found"
  | "conflict"
  | "rate_limit"
  | "validation"
  | "transient"
  | "network"
  | "unknown";

export interface CfError {
  status: number;
  category: ApiErrorCategory;
  message: string;
  /** Suggested token permission to add, when the failure looks permission-related. */
  hint?: string;
  cfErrors?: Array<{ code: number; message: string }>;
}

export type CfResult<T = unknown> =
  | { ok: true; result: T; resultInfo?: Record<string, unknown> }
  | ({ ok: false } & CfError);

/** A missing phase entrypoint is an empty baseline; every other read failure blocks its replacing PUT. */
export function resolveRulesetEntrypointBaseline(
  response: CfResult<{ rules?: Array<Record<string, unknown>> }>,
): CfResult<Array<Record<string, unknown>>> {
  if (!response.ok) return response.category === "not_found" ? { ok: true, result: [] } : response;
  if (
    !Array.isArray(response.result.rules) ||
    response.result.rules.some((rule) => !rule || typeof rule !== "object" || Array.isArray(rule))
  ) {
    return {
      ok: false,
      status: 502,
      category: "transient",
      message: "Cloudflare returned a malformed ruleset entrypoint.",
    };
  }
  return { ok: true, result: response.result.rules };
}

/** Project an API rule response onto the fields accepted by a ruleset PUT. */
export function rulesetRuleForPut(rule: Record<string, unknown>): Record<string, unknown> {
  const writable = [
    "id",
    "action",
    "action_parameters",
    "categories",
    "description",
    "enabled",
    "exposed_credential_check",
    "expression",
    "logging",
    "ratelimit",
    "ref",
  ] as const;
  return Object.fromEntries(
    writable.flatMap((field) => rule[field] === undefined ? [] : [[field, rule[field]]]),
  );
}

/** Map common API paths to likely read/write token permission groups. */
const PERMISSION_MAP: Array<[string, { read: string; write: string }]> = [
  ["/load_balancers/pools", { read: "Load Balancing: Monitors and Pools — Read (Account)", write: "Load Balancing: Monitors and Pools — Edit (Account)" }],
  ["/load_balancers", { read: "Load Balancers — Read (Zone)", write: "Load Balancers — Edit (Zone)" }],
  ["/rules/lists", { read: "Account Filter Lists — Read (Account)", write: "Account Filter Lists — Edit (Account)" }],
  ["/rulesets", { read: "Zone WAF — Read (Zone) or Account Rulesets — Read (Account)", write: "Zone WAF — Edit (Zone) or Account Rulesets — Edit (Account)" }],
  ["/settings/", { read: "Zone Settings — Read (Zone)", write: "Zone Settings — Edit (Zone)" }],
  ["/dns_records", { read: "DNS — Read (Zone)", write: "DNS — Edit (Zone)" }],
  ["/gateway/rules", { read: "Zero Trust: Gateway — Read (Account)", write: "Zero Trust: Gateway — Edit (Account)" }],
  ["/access/apps", { read: "Access: Apps and Policies — Read", write: "Access: Apps and Policies — Edit" }],
  ["/cfd_tunnel", { read: "Cloudflare Tunnel — Read (Account)", write: "Cloudflare Tunnel — Edit (Account)" }],
  ["/teamnet/routes", { read: "Cloudflare Tunnel: Routes — Read (Account)", write: "Cloudflare Tunnel: Routes — Edit (Account)" }],
  ["/workers/scripts", { read: "Workers Scripts — Read (Account)", write: "Workers Scripts — Edit (Account)" }],
];

export function permissionHint(path: string, method = "GET"): string | undefined {
  if (path === "/zones") {
    return method.toUpperCase() === "GET"
      ? "Zone > Zone > Read, scoped to the target zones"
      : "Zone > Zone > Edit, scoped to All zones/domains (Account API Tokens need a zone/domain-scoped policy; this permission is not shown under Entire Account)";
  }
  const access = method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD" ? "read" : "write";
  for (const [pattern, rec] of PERMISSION_MAP) {
    if (path.includes(pattern)) return rec[access];
  }
  return undefined;
}

export function classifyHttpError(status: number, cfErrorCode?: number): ApiErrorCategory {
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (cfErrorCode && PERMISSION_CF_CODES.has(cfErrorCode)) return "permission";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limit";
  if (status >= 400 && status < 500) return "validation";
  if (status >= 500) return "transient";
  return "unknown";
}

function headers(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface CfEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
  messages?: Array<{ code: number; message: string }>;
  result_info?: Record<string, unknown>;
}

type ResponseBodyFailure =
  | "missing_body"
  | "response_too_large"
  | "pagination_too_large"
  | "invalid_utf8"
  | "invalid_json"
  | "read_error";

type BoundedJsonResult =
  | { ok: true; value: unknown; bytes: number }
  | { ok: false; failure: ResponseBodyFailure };

interface InternalCfResult<T> {
  response: CfResult<T>;
  responseBytes: number;
}

function isCfEnvelope<T>(value: unknown): value is CfEnvelope<T> {
  if (!value || typeof value !== "object" || typeof (value as { success?: unknown }).success !== "boolean") {
    return false;
  }
  return !(value as { success: boolean }).success || "result" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort after rejecting or retrying a response.
  }
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
  limitFailure: "response_too_large" | "pagination_too_large",
): Promise<BoundedJsonResult> {
  if (!response.body) return { ok: false, failure: "missing_body" };

  const contentLength = response.headers.get("Content-Length");
  if (contentLength && /^\d+$/.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      await cancelResponseBody(response);
      return { ok: false, failure: limitFailure };
    }
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const textParts: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        await reader.cancel().catch(() => undefined);
        return { ok: false, failure: "read_error" };
      }
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, failure: limitFailure };
      }
      try {
        textParts.push(decoder.decode(chunk.value, { stream: true }));
      } catch {
        await reader.cancel().catch(() => undefined);
        return { ok: false, failure: "invalid_utf8" };
      }
    }

    try {
      textParts.push(decoder.decode());
    } catch {
      return { ok: false, failure: "invalid_utf8" };
    }

    try {
      return { ok: true, value: JSON.parse(textParts.join("")), bytes };
    } catch {
      return { ok: false, failure: "invalid_json" };
    }
  } finally {
    reader.releaseLock();
  }
}

function responseBodyFailureMessage(status: number, failure: ResponseBodyFailure): string {
  if (failure === "response_too_large") {
    return `Cloudflare API response exceeded ${MAX_CF_API_RESPONSE_BYTES} bytes.`;
  }
  if (failure === "pagination_too_large") {
    return `Cloudflare API pagination exceeded ${MAX_CF_API_PAGINATION_BYTES} bytes. Narrow the query.`;
  }
  if (failure === "missing_body") return `Cloudflare returned HTTP ${status} without a response body.`;
  if (failure === "invalid_utf8") return `Cloudflare returned HTTP ${status} with invalid UTF-8.`;
  if (failure === "invalid_json") return `Cloudflare returned HTTP ${status} with invalid JSON.`;
  return `Cloudflare returned HTTP ${status} with an unreadable response body.`;
}

function envelopeErrors(value: CfEnvelope<unknown> | null): Array<{ code: number; message: string }> {
  if (!Array.isArray(value?.errors)) return [];
  return value.errors.filter(
    (error): error is { code: number; message: string } =>
      isRecord(error) && Number.isFinite(error.code) && typeof error.message === "string",
  );
}

/**
 * Core request with retry/backoff. `path` is relative to the CF API base.
 */
export async function cfRequest<T = unknown>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<CfResult<T>> {
  return (await cfRequestInternal<T>(method, path, token, body)).response;
}

async function cfRequestInternal<T = unknown>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  responseLimit = MAX_CF_API_RESPONSE_BYTES,
  limitFailure: "response_too_large" | "pagination_too_large" = "response_too_large",
): Promise<InternalCfResult<T>> {
  if (!token) {
    return {
      response: {
        ok: false,
        status: 0,
        category: "auth",
        message: "No Cloudflare API token is configured. Add one in Connection > Set token.",
      },
      responseBytes: 0,
    };
  }

  const canonicalPath = canonicalizeApiPath(path);
  if (!canonicalPath) {
    return {
      response: {
        ok: false,
        status: 400,
        category: "validation",
        message: "Invalid Cloudflare API path.",
      },
      responseBytes: 0,
    };
  }

  const isGet = method.toUpperCase() === "GET";
  const maxRetries = isGet ? MAX_RETRIES_GET : MAX_RETRIES_WRITE;
  let lastNetworkError = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(BACKOFF_FACTOR_MS * attempt);

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      isGet ? TIMEOUT_READ_MS : TIMEOUT_WRITE_MS,
    );
    try {
      const init: RequestInit = { method, headers: headers(token), signal: controller.signal };
      if (body !== undefined && method.toUpperCase() !== "GET") {
        init.body = JSON.stringify(body);
      }
      const resp = await fetch(`${CF_API_BASE}${canonicalPath}`, init);
      const status = resp.status;

      // Retry only on transient/rate-limit statuses (and only while attempts remain)
      if (RETRYABLE_STATUSES.has(status) && attempt < maxRetries) {
        await cancelResponseBody(resp);
        continue;
      }

      const bodyResult = await readBoundedJson(resp, responseLimit, limitFailure);
      if (!bodyResult.ok) {
        const category = resp.ok
          ? (isGet ? "unknown" : "transient")
          : classifyHttpError(status);
        return {
          response: {
            ok: false,
            status,
            category,
            message: responseBodyFailureMessage(status, bodyResult.failure),
            hint: category === "permission" ? permissionHint(canonicalPath, method) : undefined,
            cfErrors: [],
          },
          responseBytes: 0,
        };
      }
      const data = isCfEnvelope<T>(bodyResult.value) ? bodyResult.value : null;

      if (resp.ok && data?.success) {
        return {
          response: {
            ok: true,
            result: data.result,
            resultInfo: isRecord(data.result_info) ? data.result_info : undefined,
          },
          responseBytes: bodyResult.bytes,
        };
      }

      if (resp.ok && !data) {
        return {
          response: {
            ok: false,
            status,
            category: isGet ? "unknown" : "transient",
            message: `Cloudflare returned HTTP ${status} without a valid API response envelope.`,
          },
          responseBytes: bodyResult.bytes,
        };
      }

      const cfErrors = envelopeErrors(data);
      const cfCode = cfErrors[0]?.code;
      const category = classifyHttpError(status, cfCode);
      const detail =
        cfErrors.map((e) => `${e.message}${e.code ? ` (code ${e.code})` : ""}`).join("; ") ||
        `HTTP ${status}`;
      return {
        response: {
          ok: false,
          status,
          category,
          message: detail,
          hint: category === "permission" ? permissionHint(canonicalPath, method) : undefined,
          cfErrors,
        },
        responseBytes: bodyResult.bytes,
      };
    } catch (err) {
      lastNetworkError = err instanceof Error ? err.message : String(err);
      if (attempt < maxRetries) continue;
      return {
        response: {
          ok: false,
          status: 0,
          category: "network",
          message: `Network error calling Cloudflare API: ${lastNetworkError}`,
        },
        responseBytes: 0,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    response: {
      ok: false,
      status: 0,
      category: "unknown",
      message: lastNetworkError || "Unknown error",
    },
    responseBytes: 0,
  };
}

export const cfGet = <T = unknown>(path: string, token: string) =>
  cfRequest<T>("GET", path, token);

/** Fetch every page of a paginated list endpoint. */
export async function cfGetAll<T = unknown>(
  path: string,
  token: string,
  perPage = 50,
): Promise<CfResult<T[]>> {
  const results: T[] = [];
  let responseBytes = 0;
  for (let page = 1; page <= MAX_CF_API_PAGES; page++) {
    const remainingBytes = MAX_CF_API_PAGINATION_BYTES - responseBytes;
    if (remainingBytes <= 0) {
      return {
        ok: false,
        status: 502,
        category: "transient",
        message: `Cloudflare API pagination exceeded ${MAX_CF_API_PAGINATION_BYTES} bytes. Narrow the query.`,
      };
    }
    const sep = path.includes("?") ? "&" : "?";
    const internal = await cfRequestInternal<T[]>(
      "GET",
      `${path}${sep}page=${page}&per_page=${perPage}`,
      token,
      undefined,
      Math.min(MAX_CF_API_RESPONSE_BYTES, remainingBytes),
      remainingBytes < MAX_CF_API_RESPONSE_BYTES ? "pagination_too_large" : "response_too_large",
    );
    const res = internal.response;
    if (!res.ok) return res;
    if (!Array.isArray(res.result)) {
      return {
        ok: false,
        status: 502,
        category: "transient",
        message: "Cloudflare returned a malformed paginated result.",
      };
    }
    responseBytes += internal.responseBytes;
    for (const item of res.result) results.push(item);
    const totalPages = res.resultInfo?.total_pages ?? 1;
    if (typeof totalPages !== "number" || !Number.isSafeInteger(totalPages) || totalPages < 1) {
      return {
        ok: false,
        status: 502,
        category: "transient",
        message: "Cloudflare returned malformed pagination metadata.",
      };
    }
    if (totalPages > MAX_CF_API_PAGES) {
      return {
        ok: false,
        status: 502,
        category: "transient",
        message: `Cloudflare API pagination exceeded ${MAX_CF_API_PAGES} pages. Narrow the query.`,
      };
    }
    if (page >= totalPages) break;
  }
  return { ok: true, result: results };
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

export interface TokenStatus {
  valid: boolean;
  status?: string;
  message: string;
}

export async function verifyToken(token: string): Promise<TokenStatus> {
  const res = await cfRequest<{ status: string }>("GET", "/user/tokens/verify", token);
  if (res.ok) {
    return { valid: res.result?.status === "active", status: res.result?.status, message: "Token verified" };
  }
  // `/user/tokens/verify` is a USER-scoped endpoint. Account-scoped API tokens —
  // the common case for onboarding — return 401/403 here even when they are
  // perfectly valid, so a failure on this endpoint is NOT proof the token is
  // bad. Fall back to a real authenticated read: if the token can list accounts
  // or zones, it authenticates fine and is usable. Only when it can't touch
  // either do we report it invalid.
  const accounts = await listAccounts(token);
  if (accounts.ok) {
    return { valid: true, status: "active", message: "Token verified via account access" };
  }
  const zones = await listZones(token);
  if (zones.ok) {
    return { valid: true, status: "active", message: "Token verified via zone access" };
  }
  return { valid: false, status: undefined, message: res.message };
}

export interface AccountSummary { id: string; name: string }
export interface ZoneSummary { id: string; name: string; status: string; account?: { id: string; name: string } }

/** Pick a zone-creation account without letting an unproven legacy zone fall through to a stale default. */
export function resolveTargetAccountId(input: {
  explicitAccountId?: string;
  selectedZoneMatches: boolean;
  selectedZoneAccountId?: string;
  defaultAccountId?: string;
}): string | undefined {
  const explicit = input.explicitAccountId?.trim();
  if (explicit) return explicit;
  if (input.selectedZoneMatches) return input.selectedZoneAccountId?.trim() || undefined;
  return input.defaultAccountId?.trim() || undefined;
}

export const listAccounts = (token: string) =>
  cfGetAll<AccountSummary>("/accounts", token);

export const listZones = (token: string, accountId?: string) =>
  cfGetAll<ZoneSummary>(accountId ? `/zones?account.id=${accountId}` : "/zones", token);

export async function findZoneByName(
  token: string,
  name: string,
  accountId?: string,
): Promise<CfResult<ZoneSummary>> {
  const domain = canonicalizeDomainName(name);
  if (!domain) {
    return { ok: false, status: 400, category: "validation", message: `"${name}" is not a valid bare domain.` };
  }
  const accountFilter = accountId ? `&account.id=${encodeURIComponent(accountId)}` : "";
  const res = await cfGet<ZoneSummary[]>(
    `/zones?name=${encodeURIComponent(domain)}${accountFilter}`,
    token,
  );
  if (!res.ok) return res;
  const zone = res.result?.[0];
  if (!zone) {
    return { ok: false, status: 404, category: "not_found", message: `No zone named "${domain}" found on this token.` };
  }
  return { ok: true, result: zone };
}

/** SSL/TLS encryption mode as reported by the zone settings endpoint. */
export type ZoneSslMode = "off" | "flexible" | "full" | "strict" | "unknown";

/**
 * Read the zone's current SSL/TLS encryption mode (GET /zones/{id}/settings/ssl).
 * Used to auto-tick the go-live "SSL" checklist step from the domain's real state
 * rather than only from actions queued inside the room.
 */
export async function getZoneSslMode(token: string, zoneId: string): Promise<CfResult<ZoneSslMode>> {
  const id = zoneId.trim();
  if (!id) {
    return { ok: false, status: 400, category: "validation", message: "A zone id is required to read the SSL mode." };
  }
  const res = await cfGet<{ value?: string }>(`/zones/${encodeURIComponent(id)}/settings/ssl`, token);
  if (!res.ok) return res;
  const value = typeof res.result?.value === "string" ? res.result.value : "";
  const mode: ZoneSslMode =
    value === "off" || value === "flexible" || value === "full" || value === "strict" ? value : "unknown";
  return { ok: true, result: mode };
}

/**
 * Report whether the zone has the Cloudflare Managed WAF deployed, by reading the
 * managed-firewall phase entrypoint and checking for an enabled `execute` rule
 * (GET /zones/{id}/rulesets/phases/http_request_firewall_managed/entrypoint).
 * A missing entrypoint (404) is a definitive "not deployed", not an error.
 */
export async function getZoneManagedWafDeployed(token: string, zoneId: string): Promise<CfResult<boolean>> {
  const id = zoneId.trim();
  if (!id) {
    return { ok: false, status: 400, category: "validation", message: "A zone id is required to read WAF status." };
  }
  const res = await cfGet<{ rules?: Array<Record<string, unknown>> }>(
    `/zones/${encodeURIComponent(id)}/rulesets/phases/http_request_firewall_managed/entrypoint`,
    token,
  );
  const baseline = resolveRulesetEntrypointBaseline(res);
  if (!baseline.ok) return baseline;
  const deployed = baseline.result.some((rule) => rule.action === "execute" && rule.enabled !== false);
  return { ok: true, result: deployed };
}

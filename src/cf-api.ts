/**
 * Cloudflare API client for Glide.
 *
 * Ported from switchflare's `web/worker/cf-api.ts`: retry/backoff on 429/5xx,
 * typed error classification, and a permission-recommendation map so failures
 * tell you which token permission is missing. Returns STRUCTURED results
 * (never throws on API errors) so the LLM tools can surface friendly messages.
 */

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

/** Map a CF API path to the human-readable token permission it needs. */
const PERMISSION_MAP: Array<[string, string]> = [
  ["/load_balancers/pools", "Load Balancing: Monitors and Pools — Edit (Account)"],
  ["/load_balancers", "Load Balancers — Edit (Zone)"],
  ["/rules/lists", "Account Filter Lists — Edit (Account)"],
  ["/rulesets", "Zone WAF — Edit (Zone) + Account Rulesets — Edit (Account)"],
  ["/settings/", "Zone Settings — Edit (Zone)"],
  ["/dns_records", "DNS — Edit (Zone)"],
  ["/gateway/rules", "Zero Trust: Gateway — Edit (Account)"],
  ["/access/apps", "Access: Apps and Policies — Edit (Account)"],
  ["/cfd_tunnel", "Cloudflare Tunnel — Edit (Account)"],
  ["/teamnet/routes", "Cloudflare Tunnel: Routes — Edit (Account)"],
  ["/workers/scripts", "Workers Scripts — Edit (Account)"],
];

export function permissionHint(path: string): string | undefined {
  for (const [pattern, rec] of PERMISSION_MAP) {
    if (path.includes(pattern)) return rec;
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

/**
 * Core request with retry/backoff. `path` is relative to the CF API base.
 */
export async function cfRequest<T = unknown>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<CfResult<T>> {
  if (!token) {
    return {
      ok: false,
      status: 0,
      category: "auth",
      message:
        "No Cloudflare API token is configured. Add one in Connection > Set token, or configure the CF_API_TOKEN Worker secret.",
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
      const resp = await fetch(`${CF_API_BASE}${path}`, init);
      const status = resp.status;

      // Retry only on transient/rate-limit statuses (and only while attempts remain)
      if (RETRYABLE_STATUSES.has(status) && attempt < maxRetries) {
        continue;
      }

      let data: CfEnvelope<T> | null = null;
      try {
        data = (await resp.json()) as CfEnvelope<T>;
      } catch {
        // Non-JSON response
      }

      if (resp.ok && data?.success) {
        return { ok: true, result: data.result, resultInfo: data.result_info };
      }

      const cfErrors = data?.errors ?? [];
      const cfCode = cfErrors[0]?.code;
      const category = classifyHttpError(status, cfCode);
      const detail =
        cfErrors.map((e) => `${e.message}${e.code ? ` (code ${e.code})` : ""}`).join("; ") ||
        `HTTP ${status}`;
      return {
        ok: false,
        status,
        category,
        message: detail,
        hint: category === "permission" ? permissionHint(path) : undefined,
        cfErrors,
      };
    } catch (err) {
      lastNetworkError = err instanceof Error ? err.message : String(err);
      if (attempt < maxRetries) continue;
      return {
        ok: false,
        status: 0,
        category: "network",
        message: `Network error calling Cloudflare API: ${lastNetworkError}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return { ok: false, status: 0, category: "unknown", message: lastNetworkError || "Unknown error" };
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
  let page = 1;
  // hard cap to protect Worker CPU
  for (; page <= 50; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await cfRequest<T[]>("GET", `${path}${sep}page=${page}&per_page=${perPage}`, token);
    if (!res.ok) return res;
    results.push(...(res.result ?? []));
    const totalPages = Number((res.resultInfo as { total_pages?: number })?.total_pages ?? 1);
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

export const listAccounts = (token: string) =>
  cfGetAll<AccountSummary>("/accounts", token);

export const listZones = (token: string, accountId?: string) =>
  cfGetAll<ZoneSummary>(accountId ? `/zones?account.id=${accountId}` : "/zones", token);

export async function findZoneByName(token: string, name: string): Promise<CfResult<ZoneSummary>> {
  const res = await cfGet<ZoneSummary[]>(`/zones?name=${encodeURIComponent(name)}`, token);
  if (!res.ok) return res;
  const zone = res.result?.[0];
  if (!zone) {
    return { ok: false, status: 404, category: "not_found", message: `No zone named "${name}" found on this token.` };
  }
  return { ok: true, result: zone };
}

/** Zone settings captured in a pre-change snapshot for rollback. */
const SNAPSHOT_SETTINGS = [
  "security_level", "ssl", "min_tls_version", "always_use_https",
  "automatic_https_rewrites", "tls_1_3", "browser_check", "brotli",
];

export interface ZoneSnapshot {
  zoneId: string;
  ts: number;
  settings: Record<string, unknown>;
  rulesets: unknown;
}

export async function snapshotZone(token: string, zoneId: string): Promise<CfResult<ZoneSnapshot>> {
  // These reads are independent. Running them serially could hold an Apply RPC
  // open through nine full timeout/retry windows before the write even started.
  const [settingResults, rs] = await Promise.all([
    Promise.all(
      SNAPSHOT_SETTINGS.map(async (key) => ({
        key,
        result: await cfGet<{ id: string; value: unknown }>(
          `/zones/${zoneId}/settings/${key}`,
          token,
        ),
      })),
    ),
    cfGet(`/zones/${zoneId}/rulesets`, token),
  ]);
  const settings: Record<string, unknown> = {};
  for (const { key, result } of settingResults) {
    if (result.ok) settings[key] = result.result?.value;
  }
  if (Object.keys(settings).length === 0 && !rs.ok) {
    return {
      ok: false,
      status: rs.status,
      category: rs.category,
      message: `Could not capture zone settings or rulesets: ${rs.message}`,
      hint: rs.hint,
      cfErrors: rs.cfErrors,
    };
  }
  return {
    ok: true,
    result: { zoneId, ts: Date.now(), settings, rulesets: rs.ok ? rs.result : null },
  };
}

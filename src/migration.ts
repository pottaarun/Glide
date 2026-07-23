/**
 * Read-only client for the Switchflare / migration tool Worker.
 *
 * Glide only ever calls the migration tool's SAFE, side-effect-free endpoints:
 *   - GET  /api/providers          → list supported providers + phases
 *   - POST /api/preview-rules      → translate an existing provider config into
 *                                    Cloudflare-equivalent rules (NO API calls,
 *                                    NO writes — pure local parsing on their side)
 *   - POST /api/generate-terraform → emit Terraform for the parsed config
 *
 * We deliberately NEVER call `/api/migrations/start` (which deploys directly to
 * Cloudflare): every real change must flow through Glide's queue → human Apply
 * contract. Preview output is converted into Glide pending actions in server.ts.
 *
 * Every function returns a STRUCTURED result and never throws, mirroring
 * `cf-api.ts`, so the LLM tools can surface friendly messages.
 */

const TIMEOUT_MS = 20_000;
/** Cap on a config fetched from a URL so a giant export can't blow Worker memory. */
const MAX_CONFIG_BYTES = 2_000_000;

export type MigrationConfigFormat = "json" | "xml" | "terraform" | "panos" | "auto";

export type MigrationResult<T> =
  | { ok: true; result: T }
  | { ok: false; message: string; status?: number };

export interface MigrationProvider {
  key: string;
  label: string;
  category: string;
  description: string;
  phases: Array<{ key: string; label: string }>;
}

export interface MigrationPreviewRuleDTO {
  name: string;
  type: string;
  phase: string;
  phaseLabel: string;
  action?: string;
  detail?: string;
  expression?: string;
}

export interface MigrationPreviewDTO {
  provider: string;
  providerLabel: string;
  totalRules: number;
  phases: Array<{ key: string; label: string; count: number }>;
  rules: MigrationPreviewRuleDTO[];
}

export interface TerraformFileDTO {
  filename: string;
  content: string;
}

export interface TerraformResultDTO {
  files: TerraformFileDTO[];
  provider?: string;
  totalRules?: number;
  rulesetCount?: number;
  ipListCount?: number;
  phases?: Array<{ key: string; label: string; count: number }>;
}

/**
 * How to reach the migration tool. Prefer the `fetcher` service binding (works
 * even when the tool's public hostname is behind Cloudflare Access); fall back
 * to a public `baseUrl`.
 */
export interface MigrationTransport {
  fetcher?: Fetcher;
  baseUrl?: string;
}

/** Whether the migration tool integration is configured (binding or URL). */
export function migrationConfigured(t: MigrationTransport | undefined): boolean {
  if (!t) return false;
  return Boolean(t.fetcher) || (typeof t.baseUrl === "string" && t.baseUrl.trim().length > 0);
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

const NOT_CONFIGURED =
  "The migration tool isn't connected. Bind the Switchflare Worker to Glide " +
  "(a `MIGRATION` service binding in wrangler.jsonc — recommended) or set MIGRATION_API_URL.";

async function call<T>(
  t: MigrationTransport,
  path: string,
  init: RequestInit,
): Promise<MigrationResult<T>> {
  if (!migrationConfigured(t)) {
    return { ok: false, message: NOT_CONFIGURED };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const reqInit: RequestInit = {
    ...init,
    signal: controller.signal,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  };
  // Prefer the service binding: invokes the Worker directly, bypassing the
  // public edge (and Cloudflare Access). The host in the URL is ignored by the
  // target Worker's path-based router.
  const via = t.fetcher ? "service binding" : `${normalizeBase(t.baseUrl as string)}`;
  try {
    const resp = t.fetcher
      ? await t.fetcher.fetch(`https://migration.internal${path}`, reqInit)
      : await fetch(`${normalizeBase(t.baseUrl as string)}${path}`, reqInit);

    let data: unknown = null;
    try {
      data = await resp.json();
    } catch {
      // non-JSON
    }
    if (!resp.ok) {
      const msg =
        (data as { error?: string } | null)?.error ??
        `Migration tool returned HTTP ${resp.status}`;
      return { ok: false, message: msg, status: resp.status };
    }
    return { ok: true, result: data as T };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `Couldn't reach the migration tool (${via}): ${reason}.`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** List the providers (Akamai, Fastly, Imperva, Zscaler, …) the tool can parse. */
export async function listMigrationProviders(
  transport: MigrationTransport,
): Promise<MigrationResult<{ providers: MigrationProvider[] }>> {
  return call<{ providers: MigrationProvider[] }>(transport, "/api/providers", { method: "GET" });
}

/**
 * Sniff a raw config string's format when the caller passes `auto`.
 * Mirrors the heuristics the migration tool's own parser dispatch uses.
 */
export function sniffFormat(config: string): Exclude<MigrationConfigFormat, "auto"> {
  const trimmed = config.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  if (/^\s*</.test(trimmed) || trimmed.includes("<?xml")) return "xml";
  if (/\bresource\s+"/.test(trimmed) || /\bterraform\s*\{/.test(trimmed)) return "terraform";
  // PAN-OS set-format / curly config
  if (/^set \S/m.test(trimmed) || /\bdeviceconfig\b/.test(trimmed) || /\brulebase\b/.test(trimmed)) {
    return "panos";
  }
  return "json";
}

/**
 * Wrap a raw config string into the payload shape the migration tool expects.
 * - json      → the parsed object
 * - xml       → { __raw_xml }
 * - terraform → { __raw_tf }
 * - panos     → { __raw_panos }
 */
export function buildConfigData(
  config: string,
  format: MigrationConfigFormat,
  filename?: string,
): { ok: true; data: unknown; format: Exclude<MigrationConfigFormat, "auto"> } | { ok: false; message: string } {
  const resolved = format === "auto" ? sniffFormat(config) : format;
  switch (resolved) {
    case "json": {
      try {
        return { ok: true, data: JSON.parse(config), format: "json" };
      } catch (err) {
        return {
          ok: false,
          message: `Config looked like JSON but failed to parse: ${
            err instanceof Error ? err.message : String(err)
          }. If it's XML/Terraform/PAN-OS, pass an explicit format.`,
        };
      }
    }
    case "xml":
      return { ok: true, data: { __raw_xml: config, __filename: filename }, format: "xml" };
    case "terraform":
      return { ok: true, data: { __raw_tf: config, __filename: filename }, format: "terraform" };
    case "panos":
      return { ok: true, data: { __raw_panos: config, __filename: filename }, format: "panos" };
  }
}

/** Fetch a config from a URL (read-only) so users needn't paste huge exports into chat. */
export async function fetchConfigFromUrl(
  url: string,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, message: `"${url}" is not a valid URL.` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, message: "Only http(s) config URLs are supported." };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(parsed.toString(), { signal: controller.signal });
    if (!resp.ok) {
      return { ok: false, message: `Fetching the config URL returned HTTP ${resp.status}.` };
    }
    const text = await resp.text();
    if (text.length > MAX_CONFIG_BYTES) {
      return {
        ok: false,
        message: `Config is too large (${text.length} bytes; max ${MAX_CONFIG_BYTES}). Trim it or split phases.`,
      };
    }
    return { ok: true, text };
  } catch (err) {
    return {
      ok: false,
      message: `Couldn't fetch the config URL: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Translate an existing provider config into Cloudflare-equivalent rules.
 * READ-ONLY on the migration tool's side (no CF API calls, no writes).
 */
export async function previewProviderMigration(
  transport: MigrationTransport,
  provider: string,
  configData: unknown,
): Promise<MigrationResult<MigrationPreviewDTO>> {
  return call<MigrationPreviewDTO>(transport, "/api/preview-rules", {
    method: "POST",
    body: JSON.stringify({ provider, configData }),
  });
}

/** Generate Terraform for the parsed config (no migration, no API calls). */
export async function generateMigrationTerraform(
  transport: MigrationTransport,
  input: {
    provider: string;
    configData: unknown;
    zoneId?: string;
    accountId?: string;
    zoneName?: string;
  },
): Promise<MigrationResult<TerraformResultDTO>> {
  return call<TerraformResultDTO>(transport, "/api/generate-terraform", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ---------------------------------------------------------------------------
// Pre-flight permission check, pre-migration diff, and CSV export.
// All read-only against Cloudflare (preflight/diff probe with the token but
// never create anything; CSV is pure local parsing).
// ---------------------------------------------------------------------------

export interface PreflightDTO {
  skipped: boolean;
  skipReason?: string;
  tokenValid: boolean;
  tokenDetail: string;
  checks: Array<{ name: string; description: string; status: string; detail: string }>;
  missing: string[];
  passed: string[];
  allPassed: boolean;
}

export interface DiffReportDTO {
  provider: string;
  zoneId: string;
  accountId: string;
  phases: Record<string, { label: string; existingTotal: number; existingMigration: number; existingManual: number }>;
  ipLists: { total: number; names: string[] };
  loadBalancers: { pools: number; poolNames: string[]; lbs: number; lbNames: string[] };
  timestamp: string;
}

export interface CsvResultDTO {
  provider: string;
  files: Array<{ filename: string; content: string }>;
}

/** Validate the token has the permissions the provider's migration phases need. */
export async function preflightPermissions(
  transport: MigrationTransport,
  input: { provider: string; accountId: string; zoneId?: string; apiToken: string },
): Promise<MigrationResult<PreflightDTO>> {
  return call<PreflightDTO>(transport, "/api/preflight", { method: "POST", body: JSON.stringify(input) });
}

/** Pre-migration diff: what already exists in the target zone (migration-owned vs manual). */
export async function diffReport(
  transport: MigrationTransport,
  input: { provider: string; accountId: string; zoneId: string; apiToken: string },
): Promise<MigrationResult<DiffReportDTO>> {
  return call<DiffReportDTO>(transport, "/api/diff-report", { method: "POST", body: JSON.stringify(input) });
}

/** Export the parsed config as CSV (pure local parsing; no API calls). */
export async function exportMigrationCsv(
  transport: MigrationTransport,
  input: { provider: string; configData: unknown },
): Promise<MigrationResult<CsvResultDTO>> {
  return call<CsvResultDTO>(transport, "/api/export-csv", { method: "POST", body: JSON.stringify(input) });
}

// ---------------------------------------------------------------------------
// Zone snapshots + restore (a recovery point before/after applying changes).
// Capture + list are read-only; restore is a destructive Cloudflare write that
// the server only ever runs from an explicit, human-confirmed action.
// ---------------------------------------------------------------------------

export interface SnapshotRowDTO {
  id: string;
  migration_id?: string | null;
  zone_id: string;
  zone_name: string;
  account_id: string;
  snapshot_version: number;
  created_at: string;
}

export interface SnapshotFullDTO extends SnapshotRowDTO {
  snapshot_data: string; // JSON blob of full zone state
}

/** Capture the current zone state into switchflare's snapshot store (read-only on CF). */
export async function captureZoneSnapshot(
  transport: MigrationTransport,
  input: { apiToken: string; accountId: string; zoneId: string; zoneName?: string; migrationId?: string },
): Promise<MigrationResult<{ snapshotId: string; status: string }>> {
  return call(transport, "/api/snapshots", { method: "POST", body: JSON.stringify(input) });
}

/** List stored snapshots (optionally for a single zone). */
export async function listZoneSnapshots(
  transport: MigrationTransport,
  zoneId?: string,
): Promise<MigrationResult<{ snapshots: SnapshotRowDTO[] }>> {
  const q = zoneId ? `?zoneId=${encodeURIComponent(zoneId)}` : "";
  return call(transport, `/api/snapshots${q}`, { method: "GET" });
}

/** Fetch one snapshot including its full `snapshot_data` blob. */
export async function getZoneSnapshot(
  transport: MigrationTransport,
  id: string,
): Promise<MigrationResult<{ snapshot: SnapshotFullDTO }>> {
  return call(transport, `/api/snapshots/${encodeURIComponent(id)}`, { method: "GET" });
}

/** Restore a zone to a captured snapshot. DESTRUCTIVE — removes changes made since. */
export async function restoreZoneSnapshot(
  transport: MigrationTransport,
  input: { apiToken: string; accountId: string; zoneId: string; snapshotData: unknown },
): Promise<MigrationResult<unknown>> {
  return call(transport, "/api/restore", { method: "POST", body: JSON.stringify(input) });
}

// ---------------------------------------------------------------------------
// Config-based post-migration validation: verifies the rules a config would
// produce actually exist in the target zone. Read-only on Cloudflare.
// ---------------------------------------------------------------------------

export interface ValidationReportDTO {
  zoneId: string;
  accountId: string;
  provider: string;
  totalIntended: number;
  verified: number;
  missing: number;
  details: Array<{ ruleName: string; ruleType: string; status: "VERIFIED" | "MISSING" }>;
  timestamp: string;
}

/** Validate that the parsed config's rules exist in the zone (optionally a subset of types). */
export async function validateConfig(
  transport: MigrationTransport,
  input: {
    provider: string;
    configData: unknown;
    accountId: string;
    zoneId: string;
    apiToken: string;
    ruleTypes?: string[];
  },
): Promise<MigrationResult<ValidationReportDTO>> {
  return call<ValidationReportDTO>(transport, "/api/validate-config", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

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
/** Workers SQLite rows hard-fail at 2 MB; leave headroom for row encoding. */
export const MAX_MIGRATION_SOURCE_BYTES = 1_800_000;
/** Worst-case JSON escaping stays below the single-row serialized-source limit. */
export const MAX_CONFIG_BYTES = 850_000;
/** Cap uploaded Terraform file fan-out as well as total content bytes. */
export const MAX_CONFIG_FILES = 50;
/** Keep file metadata from bypassing the aggregate upload bound. */
export const MAX_CONFIG_FILENAME_BYTES = 512;
/** Bound every migration-tool response before parsing or retaining it. */
export const MAX_MIGRATION_RESPONSE_BYTES = 8_000_000;
export const MAX_MIGRATION_ARTIFACT_NODES = 100_000;
export const MAX_MIGRATION_ARTIFACT_DEPTH = 80;
/** Bound parser output validation before Glide retains a smaller synced-state subset. */
export const MAX_MIGRATION_PREVIEW_RULES = 10_000;
/** Generated files are synchronized to browsers, unlike the raw SQL-only source. */
export const MAX_MIGRATION_OUTPUT_BYTES = 500_000;
export const SUPPORTED_MIGRATION_SNAPSHOT_VERSION = 2;
export const MIGRATION_SNAPSHOT_DISABLED =
  "Zone snapshot capture and restore are disabled because the migration service cannot guarantee complete, fail-safe recovery. Preview and export remain available.";
export const MIGRATION_VALIDATION_DISABLED =
  "Automated post-migration validation is disabled because the migration service does not compare complete live rule and setting values. Verify the reviewed Cloudflare configuration directly.";

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function configSizeError(config: string, label = "Config"): string | undefined {
  const bytes = new TextEncoder().encode(config).byteLength;
  return bytes > MAX_CONFIG_BYTES
    ? `${label} is too large (${bytes} bytes; max ${MAX_CONFIG_BYTES}). Trim it or split phases.`
    : undefined;
}

export function serializeMigrationSource(
  configData: unknown,
): { ok: true; data: string } | { ok: false; message: string } {
  try {
    const data = JSON.stringify(configData);
    if (data === undefined) return { ok: false, message: "Migration source is not valid JSON." };
    const bytes = new TextEncoder().encode(data).byteLength;
    return bytes <= MAX_MIGRATION_SOURCE_BYTES
      ? { ok: true, data }
      : {
          ok: false,
          message: `Serialized migration source is too large (${bytes} bytes; max ${MAX_MIGRATION_SOURCE_BYTES}). Trim it or split phases.`,
        };
  } catch {
    return { ok: false, message: "Migration source is not valid JSON." };
  }
}

export function configFilesSizeError(files: Array<{ filename: string; content: string }>): string | undefined {
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const file of files) {
    const filenameBytes = encoder.encode(file.filename).byteLength;
    if (filenameBytes > MAX_CONFIG_FILENAME_BYTES) {
      return `A config filename is too long (${filenameBytes} bytes; max ${MAX_CONFIG_FILENAME_BYTES}).`;
    }
    bytes += filenameBytes + encoder.encode(file.content).byteLength;
    if (bytes > MAX_CONFIG_BYTES) {
      return `Uploaded configs are too large (${bytes} bytes; max ${MAX_CONFIG_BYTES}). Trim them or split phases.`;
    }
  }
  return undefined;
}

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

export function boundedMigrationPreviewRules(
  rules: readonly MigrationPreviewRuleDTO[],
  maxRules: number,
): { rules: MigrationPreviewRuleDTO[]; truncated: boolean } {
  const limit = Number.isSafeInteger(maxRules) && maxRules > 0 ? maxRules : 0;
  const bounded = rules.slice(0, limit);
  return { rules: bounded, truncated: bounded.length < rules.length };
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** Fail closed when a parser returns a partial or malformed mapping. */
export function migrationPreviewValidationError(
  value: unknown,
  expectedProvider: string,
  maxRules: number,
): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Migration preview is not an object.";
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_MIGRATION_RESPONSE_BYTES) {
      return `Migration preview exceeds ${MAX_MIGRATION_RESPONSE_BYTES} bytes. Split the config or export Terraform.`;
    }
  } catch {
    return "Migration preview is not valid JSON.";
  }
  const dto = value as Record<string, unknown>;
  if (dto.provider !== expectedProvider || !boundedString(dto.providerLabel, 120)) {
    return "Migration preview provider metadata does not match the request.";
  }
  if (!Number.isSafeInteger(dto.totalRules) || (dto.totalRules as number) < 0) {
    return "Migration preview has an invalid rule count.";
  }
  if (!Array.isArray(dto.rules) || dto.rules.length !== dto.totalRules) {
    return "Migration preview is incomplete or has an inconsistent rule count.";
  }
  if (dto.rules.length > maxRules) {
    return `Migration preview has ${dto.rules.length} rules; Glide can safely queue at most ${maxRules} at once. Split the config or export Terraform.`;
  }
  if (!Array.isArray(dto.phases) || dto.phases.length > 100) return "Migration preview has invalid phases.";
  let phaseCount = 0;
  const phases = new Map<string, { label: string; count: number }>();
  for (const phase of dto.phases) {
    if (
      !phase ||
      typeof phase !== "object" ||
      !boundedString((phase as Record<string, unknown>).key, 128) ||
      !boundedString((phase as Record<string, unknown>).label, 120) ||
      !Number.isSafeInteger((phase as Record<string, unknown>).count) ||
      ((phase as Record<string, unknown>).count as number) < 0
    ) {
      return "Migration preview contains a malformed phase.";
    }
    const item = phase as Record<string, unknown>;
    const key = item.key as string;
    if (phases.has(key)) return "Migration preview contains a duplicate phase.";
    const count = item.count as number;
    phases.set(key, { label: item.label as string, count });
    phaseCount += count;
  }
  if (phaseCount !== dto.totalRules) return "Migration preview phase counts are inconsistent.";

  const actualPhaseCounts = new Map<string, number>();
  for (const rule of dto.rules) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return "Migration preview contains a malformed rule.";
    const item = rule as Record<string, unknown>;
    if (
      !boundedString(item.name, 512) ||
      !boundedString(item.type, 64) ||
      !boundedString(item.phase, 128) ||
      !boundedString(item.phaseLabel, 120)
    ) {
      return "Migration preview contains invalid rule metadata.";
    }
    const phase = phases.get(item.phase as string);
    if (!phase || phase.label !== item.phaseLabel) {
      return "Migration preview rule phases do not match the phase summary.";
    }
    actualPhaseCounts.set(item.phase as string, (actualPhaseCounts.get(item.phase as string) ?? 0) + 1);
    for (const [key, max] of [["action", 64], ["detail", 4_000], ["expression", 16_000]] as const) {
      if (item[key] !== undefined && (typeof item[key] !== "string" || item[key].length > max)) {
        return `Migration preview contains an invalid ${key}.`;
      }
    }
  }
  for (const [key, phase] of phases) {
    if ((actualPhaseCounts.get(key) ?? 0) !== phase.count) {
      return "Migration preview phase counts do not match its rules.";
    }
  }
  return undefined;
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

/** Bound generated Terraform/CSV before placing it in synced Durable Object state. */
export function migrationFilesValidationError(value: unknown): string | undefined {
  if (!Array.isArray(value)) return "Migration output did not contain a file list.";
  if (value.length > MAX_CONFIG_FILES) return `Migration output contains too many files (max ${MAX_CONFIG_FILES}).`;
  const files: Array<{ filename: string; content: string }> = [];
  const filenames = new Set<string>();
  for (const file of value) {
    if (!file || typeof file !== "object" || Array.isArray(file)) return "Migration output contains a malformed file.";
    const { filename, content } = file as Record<string, unknown>;
    if (
      typeof filename !== "string" ||
      !filename ||
      /[\u0000-\u001f\u007f/\\]/.test(filename) ||
      filename === "." ||
      filename === ".." ||
      typeof content !== "string"
    ) {
      return "Migration output contains an unsafe file name or non-text content.";
    }
    const normalizedFilename = filename.normalize("NFC").toLowerCase();
    if (filenames.has(normalizedFilename)) return "Migration output contains duplicate file names.";
    filenames.add(normalizedFilename);
    files.push({ filename, content });
  }
  const inputLimitError = configFilesSizeError(files);
  if (inputLimitError) return inputLimitError;
  const bytes = files.reduce(
    (total, file) => total + new TextEncoder().encode(file.filename).byteLength + new TextEncoder().encode(file.content).byteLength,
    0,
  );
  return bytes > MAX_MIGRATION_OUTPUT_BYTES
    ? `Migration output is too large (${bytes} bytes; max ${MAX_MIGRATION_OUTPUT_BYTES}). Split the export.`
    : undefined;
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
  return Boolean(t.fetcher) || (typeof t.baseUrl === "string" && normalizeMigrationBase(t.baseUrl) !== undefined);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/** Only HTTPS migration services are valid, except explicit loopback development. */
export function normalizeMigrationBase(baseUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    return undefined;
  }
  const loopbackDevelopment = parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname);
  if (parsed.protocol !== "https:" && !loopbackDevelopment) return undefined;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
  return parsed.toString().replace(/\/+$/, "");
}

/** Provider ids are sent to an external parser and must remain small opaque keys. */
export function validMigrationProviderKey(provider: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(provider);
}

interface SafeArtifactResult {
  ok: boolean;
  message?: string;
}

type MigrationArtifactValidator = (value: unknown) => string | undefined;

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedText(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= max && (allowEmpty || value.length > 0);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function boundedStringList(value: unknown, maxItems: number, maxChars: number): value is string[] {
  return Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => boundedText(item, maxChars, true));
}

function phaseListValidationError(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length > 100) return "Migration response contains invalid phases.";
  for (const phase of value) {
    const item = recordValue(phase);
    if (
      !item ||
      !boundedText(item.key, 128) ||
      !boundedText(item.label, 120) ||
      !nonNegativeInteger(item.count)
    ) {
      return "Migration response contains a malformed phase.";
    }
  }
  return undefined;
}

function providersValidationError(value: unknown): string | undefined {
  const root = recordValue(value);
  if (!root || !Array.isArray(root.providers) || root.providers.length > 100) {
    return "Migration provider response is malformed.";
  }
  for (const provider of root.providers) {
    const item = recordValue(provider);
    if (
      !item ||
      !boundedText(item.key, 64) ||
      !boundedText(item.label, 120) ||
      !boundedText(item.category, 120) ||
      !boundedText(item.description, 2_000, true) ||
      !Array.isArray(item.phases) ||
      item.phases.length > 100 ||
      item.phases.some((phase) => {
        const p = recordValue(phase);
        return !p || !boundedText(p.key, 128) || !boundedText(p.label, 120);
      })
    ) {
      return "Migration provider response contains malformed provider data.";
    }
  }
  return undefined;
}

function generatedFilesResponseValidationError(value: unknown): string | undefined {
  const root = recordValue(value);
  if (!root) return "Migration output response is malformed.";
  const filesError = migrationFilesValidationError(root.files);
  if (filesError) return filesError;
  for (const key of ["totalRules", "rulesetCount", "ipListCount"] as const) {
    if (root[key] !== undefined && !nonNegativeInteger(root[key])) {
      return `Migration output contains an invalid ${key}.`;
    }
  }
  if (root.provider !== undefined && !boundedText(root.provider, 64)) {
    return "Migration output contains an invalid provider.";
  }
  return root.phases === undefined ? undefined : phaseListValidationError(root.phases);
}

function preflightValidationError(value: unknown): string | undefined {
  const root = recordValue(value);
  if (
    !root ||
    typeof root.skipped !== "boolean" ||
    typeof root.tokenValid !== "boolean" ||
    typeof root.allPassed !== "boolean" ||
    !boundedText(root.tokenDetail, 2_000, true) ||
    (root.skipReason !== undefined && !boundedText(root.skipReason, 2_000, true)) ||
    !boundedStringList(root.missing, 200, 500) ||
    !boundedStringList(root.passed, 200, 500) ||
    !Array.isArray(root.checks) ||
    root.checks.length > 200
  ) {
    return "Migration pre-flight response is malformed.";
  }
  for (const check of root.checks) {
    const item = recordValue(check);
    if (
      !item ||
      !boundedText(item.name, 200) ||
      !boundedText(item.description, 1_000, true) ||
      (item.status !== "passed" && item.status !== "missing" && item.status !== "warning") ||
      !boundedText(item.detail, 2_000, true)
    ) {
      return "Migration pre-flight response contains a malformed check.";
    }
  }
  if (
    root.allPassed !== (root.missing.length === 0) ||
    (!root.tokenValid && root.allPassed) ||
    (root.skipped &&
      (!root.tokenValid || !root.allPassed || root.checks.length > 0 || root.missing.length > 0 || root.passed.length > 0))
  ) {
    return "Migration pre-flight response contains contradictory results.";
  }
  return undefined;
}

function diffValidationError(value: unknown): string | undefined {
  const root = recordValue(value);
  const phases = recordValue(root?.phases);
  const ipLists = recordValue(root?.ipLists);
  const loadBalancers = recordValue(root?.loadBalancers);
  if (
    !root ||
    !boundedText(root.provider, 64) ||
    !boundedText(root.zoneId, 128) ||
    !boundedText(root.accountId, 128) ||
    !boundedText(root.timestamp, 100) ||
    !phases ||
    Object.keys(phases).length > 100 ||
    !ipLists ||
    !nonNegativeInteger(ipLists.total) ||
    !boundedStringList(ipLists.names, 1_000, 500) ||
    !loadBalancers ||
    !nonNegativeInteger(loadBalancers.pools) ||
    !nonNegativeInteger(loadBalancers.lbs) ||
    !boundedStringList(loadBalancers.poolNames, 1_000, 500) ||
    !boundedStringList(loadBalancers.lbNames, 1_000, 500)
  ) {
    return "Migration diff response is malformed.";
  }
  for (const phase of Object.values(phases)) {
    const item = recordValue(phase);
    if (
      !item ||
      !boundedText(item.label, 120) ||
      !nonNegativeInteger(item.existingTotal) ||
      !nonNegativeInteger(item.existingMigration) ||
      !nonNegativeInteger(item.existingManual) ||
      item.existingMigration + item.existingManual !== item.existingTotal
    ) {
      return "Migration diff response contains a malformed phase.";
    }
  }
  return undefined;
}

export function validMigrationSnapshotId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

function snapshotRowValidationError(value: unknown, includeData = false): string | undefined {
  const row = recordValue(value);
  if (
    !row ||
    !validMigrationSnapshotId(row.id) ||
    !boundedText(row.zone_id, 128) ||
    !boundedText(row.zone_name, 253, true) ||
    !boundedText(row.account_id, 128) ||
    !nonNegativeInteger(row.snapshot_version) ||
    !boundedText(row.created_at, 100) ||
    (row.migration_id !== undefined && row.migration_id !== null && !boundedText(row.migration_id, 200)) ||
    (includeData && !boundedText(row.snapshot_data, MAX_MIGRATION_RESPONSE_BYTES, true))
  ) {
    return "Migration snapshot response is malformed.";
  }
  return undefined;
}

function validationReportError(value: unknown): string | undefined {
  const root = recordValue(value);
  if (
    !root ||
    !boundedText(root.zoneId, 128) ||
    !boundedText(root.accountId, 128) ||
    !boundedText(root.provider, 64) ||
    !nonNegativeInteger(root.totalIntended) ||
    !nonNegativeInteger(root.verified) ||
    !nonNegativeInteger(root.missing) ||
    !boundedText(root.timestamp, 100) ||
    !Array.isArray(root.details) ||
    root.details.length > 10_000
  ) {
    return "Migration validation response is malformed.";
  }
  if (root.verified + root.missing !== root.totalIntended) {
    return "Migration validation counts are inconsistent.";
  }
  let verifiedDetails = 0;
  let missingDetails = 0;
  for (const detail of root.details) {
    const item = recordValue(detail);
    if (
      !item ||
      !boundedText(item.ruleName, 512) ||
      !boundedText(item.ruleType, 64) ||
      (item.status !== "VERIFIED" && item.status !== "MISSING")
    ) {
      return "Migration validation response contains a malformed detail.";
    }
    if (item.status === "VERIFIED") verifiedDetails += 1;
    else missingDetails += 1;
  }
  if (
    root.details.length !== root.totalIntended ||
    verifiedDetails !== root.verified ||
    missingDetails !== root.missing
  ) {
    return "Migration validation details do not match its counts.";
  }
  return undefined;
}

/** Validate externally sourced JSON before it is copied into durable state. */
export function validateMigrationArtifact(value: unknown): SafeArtifactResult {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_MIGRATION_ARTIFACT_NODES) {
      return { ok: false, message: "Migration data contains too many values." };
    }
    if (current.depth > MAX_MIGRATION_ARTIFACT_DEPTH) {
      return { ok: false, message: "Migration data is nested too deeply." };
    }
    const item = current.value;
    if (item === null || typeof item === "string" || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return { ok: false, message: "Migration data contains an invalid number." };
      continue;
    }
    if (!item || typeof item !== "object") {
      return { ok: false, message: "Migration data contains a non-JSON value." };
    }
    if (seen.has(item)) return { ok: false, message: "Migration data contains a circular value." };
    seen.add(item);
    if (Array.isArray(item)) {
      if (nodes + stack.length + item.length > MAX_MIGRATION_ARTIFACT_NODES) {
        return { ok: false, message: "Migration data contains too many values." };
      }
      for (const child of item) stack.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) {
      return { ok: false, message: "Migration data contains an unsupported object." };
    }
    for (const key in item as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        return { ok: false, message: "Migration data contains an unsafe object key." };
      }
      if (nodes + stack.length + 1 > MAX_MIGRATION_ARTIFACT_NODES) {
        return { ok: false, message: "Migration data contains too many values." };
      }
      stack.push({ value: (item as Record<string, unknown>)[key], depth: current.depth + 1 });
    }
  }
  return { ok: true };
}

async function cancelResponseBody(resp: Response): Promise<void> {
  await resp.body?.cancel().catch(() => undefined);
}

async function readResponseText(resp: Response): Promise<string> {
  const contentLength = Number(resp.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_MIGRATION_RESPONSE_BYTES) {
    await cancelResponseBody(resp);
    throw new Error(`response exceeded ${MAX_MIGRATION_RESPONSE_BYTES} bytes`);
  }
  if (!resp.body) return "";
  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_MIGRATION_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`response exceeded ${MAX_MIGRATION_RESPONSE_BYTES} bytes`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

const NOT_CONFIGURED =
  "Migration import isn't configured. Bind the Switchflare Worker to Glide " +
  "(a `MIGRATION` service binding in wrangler.jsonc — recommended) or set MIGRATION_API_URL.";

async function call<T>(
  t: MigrationTransport,
  path: string,
  init: RequestInit,
  validate?: MigrationArtifactValidator,
  successStatuses?: readonly number[],
): Promise<MigrationResult<T>> {
  const pathname = path.split("?", 1)[0].replace(/\/+$/, "");
  if (
    pathname === "/api/snapshots" ||
    pathname.startsWith("/api/snapshots/") ||
    pathname === "/api/restore" ||
    pathname === "/api/rollback"
  ) {
    return { ok: false, message: MIGRATION_SNAPSHOT_DISABLED };
  }
  if (pathname === "/api/validate-config") {
    return { ok: false, message: MIGRATION_VALIDATION_DISABLED };
  }
  if (!migrationConfigured(t)) {
    return { ok: false, message: NOT_CONFIGURED };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const reqInit: RequestInit = {
    ...init,
    signal: controller.signal,
    redirect: "manual",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  };
  // Prefer the service binding: invokes the Worker directly, bypassing the
  // public edge (and Cloudflare Access). The host in the URL is ignored by the
  // target Worker's path-based router.
  const base = t.baseUrl ? normalizeMigrationBase(t.baseUrl) : undefined;
  const via = t.fetcher ? "service binding" : "configured HTTPS endpoint";
  try {
    const resp = t.fetcher
      ? await t.fetcher.fetch(`https://migration.internal${path}`, reqInit)
      : await fetch(`${base}${path}`, reqInit);

    if (resp.status >= 300 && resp.status < 400) {
      await cancelResponseBody(resp);
      return { ok: false, message: "The migration tool returned a redirect, which Glide will not follow.", status: 502 };
    }

    if (!resp.ok) {
      await cancelResponseBody(resp);
      return { ok: false, message: `Migration tool returned HTTP ${resp.status}`, status: resp.status };
    }

    if (successStatuses && !successStatuses.includes(resp.status)) {
      await cancelResponseBody(resp);
      return { ok: false, message: `Migration tool returned unexpected HTTP ${resp.status}`, status: 502 };
    }

    let data: unknown = null;
    try {
      data = JSON.parse(await readResponseText(resp));
    } catch {
      if (resp.ok) return { ok: false, message: "The migration tool returned invalid or oversized JSON.", status: 502 };
    }
    const artifact = validateMigrationArtifact(data);
    if (!artifact.ok) return { ok: false, message: artifact.message ?? "Invalid migration data.", status: 502 };
    const schemaError = validate?.(data);
    if (schemaError) return { ok: false, message: schemaError, status: 502 };
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
  return call<{ providers: MigrationProvider[] }>(transport, "/api/providers", { method: "GET" }, providersValidationError);
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
  const sizeError = configSizeError(config);
  if (sizeError) return { ok: false, message: sizeError };
  const resolved = format === "auto" ? sniffFormat(config) : format;
  switch (resolved) {
    case "json": {
      try {
        const data = JSON.parse(config);
        const artifact = validateMigrationArtifact(data);
        if (!artifact.ok) return { ok: false, message: artifact.message ?? "Invalid migration config." };
        return { ok: true, data, format: "json" };
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
  }, (value) => migrationPreviewValidationError(value, provider, MAX_MIGRATION_PREVIEW_RULES));
}

/** Generate Terraform for the parsed config (no migration, no API calls). */
export async function generateMigrationTerraform(
  transport: MigrationTransport,
  input: {
    provider: string;
    /** Expected display label returned by Switchflare; omitted from the request body. */
    providerLabel?: string;
    configData: unknown;
    zoneId?: string;
    accountId?: string;
    zoneName?: string;
  },
): Promise<MigrationResult<TerraformResultDTO>> {
  const { providerLabel, ...request } = input;
  return call<TerraformResultDTO>(
    transport,
    "/api/generate-terraform",
    {
      method: "POST",
      body: JSON.stringify(request),
    },
    (value) => {
      const error = generatedFilesResponseValidationError(value);
      if (error) return error;
      const provider = (value as TerraformResultDTO).provider;
      return provider === undefined || provider === input.provider || provider === providerLabel
        ? undefined
        : "Migration Terraform provider does not match the request.";
    },
  );
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
  return call<PreflightDTO>(
    transport,
    "/api/preflight",
    { method: "POST", body: JSON.stringify(input) },
    preflightValidationError,
  );
}

/** Pre-migration diff: what already exists in the target zone (migration-owned vs manual). */
export async function diffReport(
  transport: MigrationTransport,
  input: { provider: string; accountId: string; zoneId: string; apiToken: string },
): Promise<MigrationResult<DiffReportDTO>> {
  return call<DiffReportDTO>(
    transport,
    "/api/diff-report",
    { method: "POST", body: JSON.stringify(input) },
    (value) => {
      const error = diffValidationError(value);
      if (error) return error;
      const result = value as DiffReportDTO;
      return result.provider === input.provider && result.accountId === input.accountId && result.zoneId === input.zoneId
        ? undefined
        : "Migration diff response target does not match the request.";
    },
  );
}

/** Export the parsed config as CSV (pure local parsing; no API calls). */
export async function exportMigrationCsv(
  transport: MigrationTransport,
  input: { provider: string; providerLabel?: string; configData: unknown },
): Promise<MigrationResult<CsvResultDTO>> {
  const { providerLabel, ...request } = input;
  return call<CsvResultDTO>(
    transport,
    "/api/export-csv",
    { method: "POST", body: JSON.stringify(request) },
    (value) => {
      const error = generatedFilesResponseValidationError(value);
      if (error) return error;
      const provider = (value as CsvResultDTO).provider;
      return provider === input.provider || provider === providerLabel
        ? undefined
        : "Migration CSV provider does not match the request.";
    },
  );
}

// ---------------------------------------------------------------------------
// Legacy snapshot response validation retained behind fail-closed compatibility APIs.
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

export interface SnapshotRestoreDTO {
  restored: number;
  deleted: number;
  errors: string[];
}

export interface SnapshotDataExpectation {
  accountId: string;
  zoneId: string;
  zoneName: string;
  version: number;
}

/** Validate the exact v2 structure consumed destructively by Switchflare restore. */
export function migrationSnapshotDataValidationError(
  value: unknown,
  expected: SnapshotDataExpectation,
): string | undefined {
  if (expected.version !== SUPPORTED_MIGRATION_SNAPSHOT_VERSION) {
    return `Snapshot version ${expected.version} is unsupported.`;
  }
  const artifact = validateMigrationArtifact(value);
  if (!artifact.ok) return artifact.message ?? "Snapshot data is invalid.";
  const root = recordValue(value);
  const allowedKeys = new Set([
    "snapshot_version",
    "zone_id",
    "zone_name",
    "account_id",
    "timestamp",
    "ip_lists",
    "lb_pools",
    "load_balancers",
    "rulesets",
    "settings",
  ]);
  if (
    !root ||
    Object.keys(root).length !== allowedKeys.size ||
    Object.keys(root).some((key) => !allowedKeys.has(key)) ||
    root.snapshot_version !== expected.version ||
    root.zone_id !== expected.zoneId ||
    root.zone_name !== expected.zoneName ||
    root.account_id !== expected.accountId ||
    !boundedText(root.timestamp, 100) ||
    Number.isNaN(Date.parse(root.timestamp))
  ) {
    return "Migration snapshot data metadata is malformed or does not match its stored target.";
  }

  const resourceListError = (items: unknown, label: string): string | undefined => {
    if (!Array.isArray(items) || items.length > 10_000) return `Migration snapshot ${label} are malformed.`;
    for (const item of items) {
      const record = recordValue(item);
      if (!record || !boundedText(record.id, 200)) return `Migration snapshot ${label} contain malformed resources.`;
    }
    return undefined;
  };
  for (const [items, label] of [
    [root.ip_lists, "IP lists"],
    [root.lb_pools, "load-balancer pools"],
    [root.load_balancers, "load balancers"],
  ] as const) {
    const error = resourceListError(items, label);
    if (error) return error;
  }

  if (!Array.isArray(root.rulesets) || root.rulesets.length > 1_000) {
    return "Migration snapshot rulesets are malformed.";
  }
  for (const rulesetValue of root.rulesets) {
    const ruleset = recordValue(rulesetValue);
    if (
      !ruleset ||
      Object.keys(ruleset).some((key) => key !== "phase" && key !== "id" && key !== "rules") ||
      !boundedText(ruleset.phase, 128) ||
      !boundedText(ruleset.id, 200) ||
      !Array.isArray(ruleset.rules) ||
      ruleset.rules.length > 10_000 ||
      ruleset.rules.some((rule) => {
        const record = recordValue(rule);
        return !record || Object.keys(record).length === 0;
      })
    ) {
      return "Migration snapshot contains a malformed ruleset.";
    }
  }

  const settings = recordValue(root.settings);
  if (
    !settings ||
    Object.keys(settings).length > 100 ||
    Object.keys(settings).some((key) => !/^[a-z0-9_]{1,100}$/.test(key))
  ) {
    return "Migration snapshot settings are malformed.";
  }
  return undefined;
}

/** Bind a restore to the account and zone recorded with the snapshot. */
export function resolveSnapshotTarget(
  snapshot: Pick<SnapshotRowDTO, "account_id" | "zone_id">,
  activeAccountId: string,
):
  | { ok: true; accountId: string; zoneId: string }
  | { ok: false; message: string } {
  if (!snapshot.account_id || snapshot.account_id !== activeAccountId) {
    return { ok: false, message: "The snapshot does not belong to the active Cloudflare account." };
  }
  if (!/^[a-f0-9]{32}$/i.test(snapshot.zone_id)) {
    return { ok: false, message: "The snapshot contains an invalid zone id." };
  }
  return { ok: true, accountId: snapshot.account_id, zoneId: snapshot.zone_id };
}

/** Disabled compatibility API; returns before issuing any request. */
export async function captureZoneSnapshot(
  transport: MigrationTransport,
  input: { apiToken: string; accountId: string; zoneId: string; zoneName?: string; migrationId?: string },
): Promise<MigrationResult<{ snapshotId: string; status: "created" }>> {
  return call(
    transport,
    "/api/snapshots",
    { method: "POST", body: JSON.stringify(input) },
    (value) => {
      const root = recordValue(value);
      return root &&
        Object.keys(root).every((key) => key === "snapshotId" || key === "status") &&
        validMigrationSnapshotId(root.snapshotId) &&
        root.status === "created"
        ? undefined
        : "Migration snapshot capture response is malformed.";
    },
    [201],
  );
}

/** Disabled compatibility helper retained for older callers. */
export async function listZoneSnapshots(
  transport: MigrationTransport,
  zoneId?: string,
): Promise<MigrationResult<{ snapshots: SnapshotRowDTO[] }>> {
  const q = zoneId ? `?zoneId=${encodeURIComponent(zoneId)}` : "";
  return call(transport, `/api/snapshots${q}`, { method: "GET" }, (value) => {
    const root = recordValue(value);
    if (!root || !Array.isArray(root.snapshots) || root.snapshots.length > 1_000) {
      return "Migration snapshot list response is malformed.";
    }
    for (const snapshot of root.snapshots) {
      const error = snapshotRowValidationError(snapshot);
      if (error) return error;
      if (zoneId && (snapshot as SnapshotRowDTO).zone_id !== zoneId) {
        return "Migration snapshot list contains a different zone.";
      }
    }
    return undefined;
  });
}

/** Disabled compatibility helper retained for older callers. */
export async function getZoneSnapshot(
  transport: MigrationTransport,
  id: string,
): Promise<MigrationResult<{ snapshot: SnapshotFullDTO }>> {
  if (!validMigrationSnapshotId(id)) return { ok: false, message: "Snapshot id is invalid." };
  return call(transport, `/api/snapshots/${encodeURIComponent(id)}`, { method: "GET" }, (value) => {
    const root = recordValue(value);
    const error = snapshotRowValidationError(root?.snapshot, true);
    if (error) return error;
    return (root!.snapshot as SnapshotFullDTO).id === id
      ? undefined
      : "Migration snapshot response id does not match the request.";
  });
}

/** Disabled compatibility API; returns before issuing any request. */
export async function restoreZoneSnapshot(
  transport: MigrationTransport,
  input: {
    apiToken: string;
    accountId: string;
    zoneId: string;
    snapshotData: unknown;
    idempotencyKey: string;
  },
): Promise<MigrationResult<SnapshotRestoreDTO>> {
  const { idempotencyKey, ...body } = input;
  return call(
    transport,
    "/api/restore",
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body),
    },
    (value) => {
      const root = recordValue(value);
      return root &&
        Object.keys(root).every((key) => key === "restored" || key === "deleted" || key === "errors") &&
        nonNegativeInteger(root.restored) &&
        nonNegativeInteger(root.deleted) &&
        boundedStringList(root.errors, 1_000, 2_000)
        ? undefined
        : "Migration snapshot restore response is malformed.";
    },
    [200],
  );
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
  }, (value) => {
    const error = validationReportError(value);
    if (error) return error;
    const result = value as ValidationReportDTO;
    return result.provider === input.provider && result.accountId === input.accountId && result.zoneId === input.zoneId
      ? undefined
      : "Migration validation response target does not match the request.";
  });
}

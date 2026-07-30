import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTVerifyOptions,
} from "jose";

export const ACCESS_EMAIL_HEADER = "X-Glide-Access-Email";
export const ACCESS_SUBJECT_HEADER = "X-Glide-Access-Subject";
export const ACCESS_EXPIRY_HEADER = "X-Glide-Access-Expiry";

const ACCESS_ASSERTION_HEADER = "Cf-Access-Jwt-Assertion";
const MAX_ACCESS_TOKEN_CHARS = 16_384;
const MAX_ACCESS_SUBJECT_CHARS = 512;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const REMOTE_JWKS_HTTP_ERRORS = new Set([
  "Expected 200 OK from the JSON Web Key Set HTTP response",
  "Failed to parse the JSON Web Key Set HTTP response as JSON",
]);

export interface AccessIdentity {
  email: string;
  subject: string;
  expiresAt: number;
}

export interface AccessSession {
  email: string;
  isEmployee: boolean;
}

export type AccessAuthResult =
  | { ok: true; identity: AccessIdentity }
  | {
      ok: false;
      status: 401 | 403 | 503;
      code:
        | "access_not_configured"
        | "access_token_missing"
        | "access_token_invalid"
        | "access_keys_unavailable";
      message: string;
    };

type AccessVerificationKey = CryptoKey | Uint8Array | JWTVerifyGetKey;

let cachedRemoteJwks: { issuer: string; key: JWTVerifyGetKey } | undefined;

class AccessKeyServiceUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Cloudflare Access signing keys are unavailable.", { cause });
    this.name = "AccessKeyServiceUnavailableError";
  }
}

function remoteJwksForIssuer(issuer: string): JWTVerifyGetKey {
  if (cachedRemoteJwks?.issuer === issuer) return cachedRemoteJwks.key;
  const key = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  cachedRemoteJwks = { issuer, key };
  return key;
}

function isRemoteJwksFailure(error: unknown): boolean {
  if (!(error instanceof errors.JOSEError)) return true;
  if (
    error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSInvalid ||
    error instanceof errors.JWKInvalid
  ) return true;
  return error.code === "ERR_JOSE_GENERIC" && REMOTE_JWKS_HTTP_ERRORS.has(error.message);
}

export function canonicalizeEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return email.length > 0 && email.length <= 254 && EMAIL_RE.test(email) ? email : undefined;
}

export function isCloudflareEmployeeEmail(email: string): boolean {
  return canonicalizeEmail(email)?.endsWith("@cloudflare.com") === true;
}

function canonicalTeamDomain(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "") ||
      !url.hostname.endsWith(".cloudflareaccess.com")
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function isLoopbackRequest(request: Request): boolean {
  try {
    const hostname = new URL(request.url).hostname.toLowerCase();
    return hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "::1";
  } catch {
    return false;
  }
}

export async function verifyAccessToken(
  token: string,
  teamDomain: string,
  audience: string,
  verificationKey?: AccessVerificationKey,
): Promise<AccessIdentity> {
  const issuer = canonicalTeamDomain(teamDomain);
  if (!issuer || !audience.trim()) throw new Error("Cloudflare Access is not configured.");
  const key = verificationKey ?? remoteJwksForIssuer(issuer);
  const options: JWTVerifyOptions = {
    algorithms: ["RS256"],
    audience: audience.trim(),
    issuer,
  };
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    ({ payload } = typeof key === "function"
      ? await jwtVerify(token, key, options)
      : await jwtVerify(token, key, options));
  } catch (error) {
    if (!verificationKey && isRemoteJwksFailure(error)) {
      throw new AccessKeyServiceUnavailableError(error);
    }
    throw error;
  }
  const email = canonicalizeEmail(payload.email);
  const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
  const expiresAt = payload.exp;
  if (
    payload.type !== "app" ||
    !email ||
    !subject ||
    subject.length > MAX_ACCESS_SUBJECT_CHARS ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt! <= 0
  ) {
    throw new Error("Cloudflare Access identity claims are incomplete.");
  }
  return { email, subject, expiresAt: expiresAt! };
}

export async function authenticateAccessRequest(
  request: Request,
  env: Pick<Cloudflare.Env, "TEAM_DOMAIN" | "POLICY_AUD" | "GLIDE_DEV_ACCESS_EMAIL">,
): Promise<AccessAuthResult> {
  const localEmail = canonicalizeEmail(env.GLIDE_DEV_ACCESS_EMAIL);
  if (localEmail && isLoopbackRequest(request)) {
    return {
      ok: true,
      identity: {
        email: localEmail,
        subject: `local-dev:${localEmail}`,
        expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      },
    };
  }

  const teamDomain = canonicalTeamDomain(env.TEAM_DOMAIN);
  const audience = env.POLICY_AUD?.trim();
  if (!teamDomain || !audience) {
    return {
      ok: false,
      status: 503,
      code: "access_not_configured",
      message: "Glide authentication is not configured. Ask the operator to finish the Cloudflare Access setup.",
    };
  }

  const token = request.headers.get(ACCESS_ASSERTION_HEADER)?.trim();
  if (!token || token.length > MAX_ACCESS_TOKEN_CHARS) {
    return {
      ok: false,
      status: 401,
      code: "access_token_missing",
      message: "Authenticate with Cloudflare Access before opening Glide.",
    };
  }

  try {
    return {
      ok: true,
      identity: await verifyAccessToken(token, teamDomain, audience),
    };
  } catch (error) {
    if (error instanceof AccessKeyServiceUnavailableError) {
      console.error({ glideEvent: "access.jwks_unavailable" });
      return {
        ok: false,
        status: 503,
        code: "access_keys_unavailable",
        message: "Glide could not retrieve Cloudflare Access signing keys. Retry shortly.",
      };
    }
    return {
      ok: false,
      status: 403,
      code: "access_token_invalid",
      message: "Your Cloudflare Access session is invalid or expired. Sign in again and retry.",
    };
  }
}

export function accessAuthErrorResponse(result: Exclude<AccessAuthResult, { ok: true }>): Response {
  return Response.json(
    { code: result.code, message: result.message },
    {
      status: result.status,
      headers: {
        "Cache-Control": "no-store",
        ...(result.status === 401 ? { "WWW-Authenticate": 'Bearer realm="Cloudflare Access"' } : {}),
        ...(result.code === "access_keys_unavailable" ? { "Retry-After": "10" } : {}),
      },
    },
  );
}

export function requestWithAccessIdentity(request: Request, identity: AccessIdentity): Request {
  const headers = new Headers(request.headers);
  headers.set(ACCESS_EMAIL_HEADER, identity.email);
  headers.set(ACCESS_SUBJECT_HEADER, identity.subject);
  headers.set(ACCESS_EXPIRY_HEADER, String(identity.expiresAt));
  return new Request(request, { headers });
}

export function accessIdentityFromHeaders(headers: Headers): AccessIdentity | undefined {
  const email = canonicalizeEmail(headers.get(ACCESS_EMAIL_HEADER));
  const subject = headers.get(ACCESS_SUBJECT_HEADER)?.trim() ?? "";
  const expiresAt = Number(headers.get(ACCESS_EXPIRY_HEADER));
  if (
    !email ||
    !subject ||
    subject.length > MAX_ACCESS_SUBJECT_CHARS ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0
  ) {
    return undefined;
  }
  return { email, subject, expiresAt };
}

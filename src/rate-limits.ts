export const AGENT_RATE_LIMIT = { limit: 120, period: 60 } as const;
export const CHAT_RATE_LIMIT = { limit: 20, period: 60 } as const;
export const CLIENT_RATE_LIMIT_HEADER = "X-Glide-Client-Rate-Key";
export const RATE_LIMIT_RETRY_AFTER_SECONDS = AGENT_RATE_LIMIT.period;
export const RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SECONDS = 10;

export type RateLimitDecision = "allowed" | "limited" | "unavailable";

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export async function opaqueRateLimitKey(scope: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${scope}\0${value}`));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${scope}:${hex}`;
}

export async function clientRateLimitKey(request: Request): Promise<string> {
  const connectingIp = request.headers.get("CF-Connecting-IP")?.trim();
  const networkIdentity = connectingIp && connectingIp.length <= 128 ? connectingIp : "unidentified";
  return opaqueRateLimitKey("client", networkIdentity);
}

export function isClientRateLimitKey(value: string | null): value is string {
  return value !== null && /^client:[a-f0-9]{64}$/.test(value);
}

export async function consumeRateLimit(limiter: RateLimiter, key: string): Promise<RateLimitDecision> {
  try {
    return (await limiter.limit({ key })).success ? "allowed" : "limited";
  } catch {
    return "unavailable";
  }
}

export function rateLimitResponse(decision: Exclude<RateLimitDecision, "allowed">): Response {
  const limited = decision === "limited";
  const retryAfter = limited ? RATE_LIMIT_RETRY_AFTER_SECONDS : RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SECONDS;
  return Response.json(
    {
      code: limited ? "rate_limit_exceeded" : "rate_limit_unavailable",
      message: limited
        ? "Too many Glide requests. Wait about a minute and try again."
        : "Glide's abuse protection is temporarily unavailable. Retry shortly.",
    },
    {
      status: limited ? 429 : 503,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(retryAfter),
      },
    },
  );
}

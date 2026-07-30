import { exportJWK, generateKeyPair, SignJWT } from "jose";

export const TEST_ACCESS_ISSUER = "https://glide-test.cloudflareaccess.com";
export const TEST_ACCESS_AUDIENCE = "glide-test-audience";

const keyMaterial = (async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  return {
    privateKey,
    jwk: { ...await exportJWK(publicKey), alg: "RS256", kid: "glide-test-key", use: "sig" },
  };
})();

export async function accessToken(
  email: string,
  options: { expiresInSeconds?: number; audience?: string; issuer?: string } = {},
): Promise<string> {
  const { privateKey } = await keyMaterial;
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    email,
    type: "app",
  })
    .setProtectedHeader({ alg: "RS256", kid: "glide-test-key", typ: "JWT" })
    .setAudience(options.audience ?? TEST_ACCESS_AUDIENCE)
    .setExpirationTime(now + (options.expiresInSeconds ?? 300))
    .setIssuedAt(now)
    .setIssuer(options.issuer ?? TEST_ACCESS_ISSUER)
    .setNotBefore(now - 1)
    .setSubject(`subject:${email.toLowerCase()}`)
    .sign(privateKey);
}

export async function asAccessUser<T>(
  email: string,
  run: (headers: Headers) => Promise<T>,
  options: { expiresInSeconds?: number; audience?: string; issuer?: string } = {},
): Promise<T> {
  const [{ jwk }, token] = await Promise.all([keyMaterial, accessToken(email, options)]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === `${TEST_ACCESS_ISSUER}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [jwk] });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    return await run(new Headers({
      "Cf-Access-Jwt-Assertion": token,
      Origin: "https://example.com",
    }));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

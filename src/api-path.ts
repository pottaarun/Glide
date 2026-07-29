/**
 * Canonicalize a path relative to Cloudflare's `/client/v4` API root.
 * Ambiguous separators, fragments, and dot segments are rejected instead of
 * relying on URL/fetch normalization after an approval has been reviewed.
 */
export function canonicalizeApiPath(raw: string): string | undefined {
  const value = raw.trim();
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("#") ||
    value.includes("\\") ||
    /[\r\n\0]/.test(value)
  ) {
    return undefined;
  }

  const queryAt = value.indexOf("?");
  const pathname = queryAt === -1 ? value : value.slice(0, queryAt);
  if (pathname.includes("//") || /[^\x21-\x7e]/.test(pathname)) {
    return undefined;
  }

  let decoded = pathname;
  for (let pass = 0; pass < 3; pass++) {
    if (/%(?:2f|5c)/i.test(decoded)) return undefined;
    if (!/%[0-9a-f]{2}/i.test(decoded)) break;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return undefined;
    }
  }
  if (/%(?:2f|5c)/i.test(decoded)) return undefined;
  if (
    decoded.includes("\\") ||
    decoded.includes("//") ||
    decoded.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return undefined;
  }

  try {
    const url = new URL(`https://api.cloudflare.invalid${value}`);
    if (url.origin !== "https://api.cloudflare.invalid" || url.hash) return undefined;
    if (url.pathname !== pathname) return undefined;
    return `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}

/** Extract the authoritative zone id from a canonical zone-scoped API path. */
export function zoneIdFromApiPath(path: string): string | undefined {
  const match = /^\/zones\/([^/?]+)(?:[/?]|$)/.exec(path);
  return match && /^[a-f0-9]{32}$/i.test(match[1]) ? match[1] : undefined;
}

/** Convert a bare Unicode domain to the canonical ASCII hostname Cloudflare uses. */
export function canonicalizeDomainName(raw: string): string | undefined {
  const value = raw.trim().replace(/\.$/, "");
  if (!value || value.length > 253 || /[\s/\\?#@:%]/.test(value)) return undefined;
  try {
    const url = new URL(`https://${value}`);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    const labels = hostname.split(".");
    if (
      labels.length < 2 ||
      hostname.length > 253 ||
      labels.some(
        (label) =>
          !label ||
          label.length > 63 ||
          !/^[a-z0-9-]+$/.test(label) ||
          label.startsWith("-") ||
          label.endsWith("-"),
      ) ||
      /^\d+$/.test(labels[labels.length - 1])
    ) {
      return undefined;
    }
    return hostname;
  } catch {
    return undefined;
  }
}

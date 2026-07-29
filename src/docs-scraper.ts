/**
 * Cloudflare-docs RAG — scrape the *complete* Cloudflare developer documentation,
 * embed each page, and store it in the SHARED Vectorize index under a single
 * GLOBAL namespace so every room's chat can retrieve grounding excerpts.
 *
 * This module is deliberately PURE plumbing: it parses the docs' `llms.txt`
 * index files, fetches + cleans page Markdown, chunks it, and upserts/queries
 * Vectorize. It owns no scheduling or persistence — the Durable Object
 * (server.ts) drives the resumable work queue and progress state, calling in
 * here one bounded batch at a time.
 *
 * Design contract (mirrors guidance-rag.ts so it can never break chat):
 *  - **Global, not per-room.** Docs are the same for everyone, so vectors live
 *    under {@link CFDOCS_NAMESPACE} (distinct from the per-room `r…` keys). Any
 *    room retrieves from this one namespace.
 *  - **Deterministic ids.** A page's chunk ids derive from its URL, so re-runs
 *    UPSERT (never duplicate) and two rooms indexing at once are idempotent.
 *  - **Safe + best-effort.** Every network/embc call is guarded; a page that
 *    fails to fetch or embed is skipped, not fatal. Retrieval returns [] on any
 *    hiccup so callers simply omit the docs section from the prompt.
 *
 * The embedding model (GLIDE_EMBED_MODEL) and index dimensions are shared with
 * guidance RAG and immutable — see wrangler.jsonc.
 */
import { isCloudflareDocsUrl, type DocChunk } from "./shared.ts";
import { embedTexts } from "./guidance-rag.ts";

/** Top-level index listing every Cloudflare product and its per-product index. */
export const DOCS_ROOT_INDEX = "https://developers.cloudflare.com/llms.txt";
/** Global Vectorize namespace holding all Cloudflare-docs vectors (shared by all rooms). */
export const CFDOCS_NAMESPACE = "__cfdocs_v2__";
/** Default number of doc chunks to retrieve per user message. */
export const DOCS_TOP_K = 4;

/** Max chars per embedded chunk (bge handles ~512 tokens; keep headroom). */
const MAX_CHUNK_CHARS = 1_400;
/** Max chunks we keep per page, so one huge page can't dominate the index. */
const MAX_CHUNKS_PER_PAGE = 8;
/** Vectorize accepts at most 1,000 ids in one delete mutation. */
const VECTOR_DELETE_BATCH = 1_000;
/** Max chars of chunk text stored in metadata (well under Vectorize's 10 KiB/vector). */
const MAX_META_TEXT = 1_200;
/** Cap on the query string we embed for retrieval. */
const MAX_QUERY_CHARS = 1_024;
/** Per-request timeout for a docs fetch. */
const FETCH_TIMEOUT_MS = 20_000;
/** Bound indexes and pages before decoding them into Worker memory. */
export const MAX_DOC_FETCH_BYTES = 2_000_000;
const MAX_DOC_PRODUCTS = 500;
const MAX_DOC_PAGES_PER_PRODUCT = 20_000;

/** A product discovered in the top-level index. */
export interface DocProduct {
  /** Stable key derived from the URL path, e.g. "dns". */
  product: string;
  /** Human label, e.g. "DNS". */
  label: string;
  /** The product's own `llms.txt` index URL. */
  url: string;
  /** Top-level category the product was grouped under, e.g. "Application security". */
  category: string;
}

/** A page discovered in a product's index. */
export interface DocPage {
  /** The page's Markdown URL (ends in `.md`). */
  url: string;
  /** Page title from the index link. */
  title: string;
  /** Section heading the page was listed under, e.g. "Get started". */
  section: string;
}

/** True when a usable Vectorize binding is present at runtime. */
export function hasVectorize(env: Cloudflare.Env): boolean {
  return Boolean((env as { VECTORIZE?: unknown }).VECTORIZE);
}

function vectorizeIndex(env: Cloudflare.Env): VectorizeIndex | undefined {
  return (env as { VECTORIZE?: VectorizeIndex }).VECTORIZE;
}

/**
 * Fetch a docs URL as Markdown. Sends `Accept: text/markdown` (the docs honour
 * it) and applies a timeout. Returns the body text, or null on any failure.
 */
export async function fetchDocText(url: string): Promise<string | null> {
  if (!isCloudflareDocsUrl(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "text/markdown, text/plain, */*" },
      signal: controller.signal,
      redirect: "manual",
    });
    if (!res.ok || (res.status >= 300 && res.status < 400)) {
      await res.body?.cancel().catch(() => undefined);
      console.warn(`[docs-scraper] fetch ${url} → ${res.status}`);
      return null;
    }
    const contentLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_DOC_FETCH_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!res.body) return "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const chunks: string[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_DOC_FETCH_BYTES) {
          await reader.cancel().catch(() => undefined);
          return null;
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
  } catch (err) {
    console.warn(`[docs-scraper] fetch ${url} failed:`, (err as Error)?.message ?? err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Derive a short product key from a docs URL path (first path segment). */
function productKeyFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/^\/+/, "");
    const seg = path.split("/")[0] ?? "";
    return seg || "root";
  } catch {
    return "root";
  }
}

/**
 * Parse the top-level `llms.txt` into the list of products. The file groups
 * products under `## Category` headings, each a Markdown bullet linking to that
 * product's own `llms.txt`:
 *   `- [DNS](https://developers.cloudflare.com/dns/llms.txt): Deliver …`
 * Only bullets whose URL ends in `llms.txt` are products (skips the intro blurb).
 */
export function parseTopIndex(md: string): DocProduct[] {
  const out: DocProduct[] = [];
  const seen = new Set<string>();
  let category = "";
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      category = heading[1].trim();
      continue;
    }
    const m = /^-\s*\[([^\]]+)\]\((https?:\/\/[^)]+?)\)/.exec(line.trim());
    if (!m) continue;
    const label = m[1].trim().slice(0, 200);
    const url = m[2].trim();
    if (!isCloudflareDocsUrl(url)) continue;
    if (!/\/llms\.txt$/i.test(url)) continue; // only per-product indexes
    if (seen.has(url)) continue;
    seen.add(url);
    if (url.length > 2_048) continue;
    out.push({ product: productKeyFromUrl(url).slice(0, 60), label, url, category: category.slice(0, 120) });
    if (out.length >= MAX_DOC_PRODUCTS) break;
  }
  return out;
}

/**
 * Parse a product's `llms.txt` into its page list. Pages are Markdown bullets
 * under `## Section` headings, each linking to the page's `.md`:
 *   `- [Get started](https://developers.cloudflare.com/dns/get-started/index.md): …`
 * Only bullets whose URL ends in `.md` are pages (skips the intro/other-product
 * links in the header blockquote).
 */
export function parseProductIndex(md: string): DocPage[] {
  const out: DocPage[] = [];
  const seen = new Set<string>();
  let section = "";
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    const m = /^-\s*\[([^\]]+)\]\((https?:\/\/[^)]+?)\)/.exec(line.trim());
    if (!m) continue;
    const title = m[1].trim().slice(0, 200);
    const url = m[2].trim();
    if (!isCloudflareDocsUrl(url)) continue;
    if (!/\.md$/i.test(url)) continue; // only Markdown page links
    if (seen.has(url)) continue;
    seen.add(url);
    if (url.length > 2_048) continue;
    out.push({ url, title, section: section.slice(0, 120) });
    if (out.length >= MAX_DOC_PAGES_PER_PRODUCT) break;
  }
  return out;
}

/** The human-facing page URL (drop the `/index.md` or `.md` suffix). */
export function humanUrl(mdUrl: string): string {
  return mdUrl.replace(/\/index\.md$/i, "/").replace(/\.md$/i, "");
}

/**
 * Strip the docs' Markdown boilerplate so we embed real content:
 *  - leading YAML frontmatter (`---` … `---`),
 *  - the `> Documentation Index …` blockquote injected at the top of every page,
 *  - the `[Skip to content](#…)` link.
 */
export function cleanDocMarkdown(md: string): string {
  let text = md.replace(/^\uFEFF/, "");
  // Frontmatter block at the very start.
  text = text.replace(/^---\n[\s\S]*?\n---\s*\n/, "");
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (/^>\s*Documentation Index/i.test(t)) continue;
    if (/^>\s*Fetch the complete documentation index/i.test(t)) continue;
    if (/^>\s*Use this file to discover/i.test(t)) continue;
    if (/^>\s*Links below point directly/i.test(t)) continue;
    if (/^>\s*For other Cloudflare products/i.test(t)) continue;
    if (/^\[Skip to content\]/i.test(t)) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Split cleaned text into embed-sized chunks on paragraph boundaries, capped at
 * {@link MAX_CHUNKS_PER_PAGE}. A single oversized paragraph is hard-split.
 */
export function chunkText(text: string): string[] {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  const push = () => {
    const t = cur.trim();
    if (t) chunks.push(t);
    cur = "";
  };
  for (const para of paras) {
    if (para.length > MAX_CHUNK_CHARS) {
      push();
      for (let i = 0; i < para.length; i += MAX_CHUNK_CHARS) {
        chunks.push(para.slice(i, i + MAX_CHUNK_CHARS));
        if (chunks.length >= MAX_CHUNKS_PER_PAGE) return chunks.slice(0, MAX_CHUNKS_PER_PAGE);
      }
      continue;
    }
    if (cur.length + para.length + 2 > MAX_CHUNK_CHARS) push();
    cur = cur ? `${cur}\n\n${para}` : para;
    if (chunks.length >= MAX_CHUNKS_PER_PAGE) break;
  }
  push();
  return chunks.slice(0, MAX_CHUNKS_PER_PAGE);
}

/**
 * Deterministic vector id for a page chunk: `cfdoc:<hash(url)>#<i>`. Same URL →
 * same ids across runs, so upserts update in place instead of duplicating.
 */
export function chunkVectorId(mdUrl: string, i: number): string {
  return `cfdoc:${hashUrl(mdUrl)}#${i}`;
}

/** Compact stable hash of a URL (two FNV-1a passes → ~13 base36 chars). */
function hashUrl(url: string): string {
  const fnv = (seed: number): number => {
    let h = seed >>> 0;
    for (let i = 0; i < url.length; i++) {
      h ^= url.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  };
  const a = fnv(0x811c9dc5) ^ Math.imul(url.length, 0x9e3779b1);
  const b = fnv(0x1b3);
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

/** Result of indexing one page. */
export interface IndexPageResult {
  ok: boolean;
  /** Number of chunks upserted (0 when the page was empty or embedding failed). */
  chunks: number;
  /** Conservative live-id count when stale-tail cleanup failed after a successful upsert. */
  retainedChunks?: number;
}

/**
 * Fetch, clean, chunk, embed and upsert a single docs page into the global
 * namespace. Returns how many chunks were written. Best-effort: returns
 * `{ ok: false, chunks: 0 }` on any failure (caller marks the page failed).
 */
export async function indexDocPage(
  env: Cloudflare.Env,
  page: DocPage,
  product: string,
): Promise<IndexPageResult> {
  if (!isCloudflareDocsUrl(page.url)) return { ok: false, chunks: 0 };
  const index = vectorizeIndex(env);
  if (!index) return { ok: false, chunks: 0 };

  const raw = await fetchDocText(page.url);
  if (raw == null) return { ok: false, chunks: 0 };

  const cleaned = cleanDocMarkdown(raw);
  const chunks = chunkText(cleaned);
  if (!chunks.length) {
    try {
      await index.deleteByIds(Array.from({ length: MAX_CHUNKS_PER_PAGE }, (_, i) => chunkVectorId(page.url, i)));
      return { ok: true, chunks: 0 };
    } catch (err) {
      console.warn(`[docs-scraper] clear empty page ${page.url} failed:`, (err as Error)?.message ?? err);
      return { ok: false, chunks: 0 };
    }
  }

  const vectors = await embedTexts(env, chunks);
  if (!vectors) return { ok: false, chunks: 0 };

  const human = humanUrl(page.url);
  const payload: VectorizeVector[] = chunks.map((text, i) => ({
    id: chunkVectorId(page.url, i),
    values: vectors[i],
    namespace: CFDOCS_NAMESPACE,
    metadata: {
      url: human,
      title: page.title.slice(0, 200),
      product: product.slice(0, 60),
      section: page.section.slice(0, 120),
      text: text.slice(0, MAX_META_TEXT),
    },
  }));

  try {
    await index.upsert(payload);
  } catch (err) {
    console.warn(`[docs-scraper] upsert ${page.url} failed:`, (err as Error)?.message ?? err);
    return { ok: false, chunks: 0 };
  }
  const staleIds: string[] = [];
  for (let i = payload.length; i < MAX_CHUNKS_PER_PAGE; i++) {
    staleIds.push(chunkVectorId(page.url, i));
  }
  try {
    if (staleIds.length) await index.deleteByIds(staleIds);
    return { ok: true, chunks: payload.length };
  } catch (err) {
    console.warn(`[docs-scraper] stale-tail cleanup ${page.url} failed:`, (err as Error)?.message ?? err);
    return { ok: true, chunks: payload.length, retainedChunks: MAX_CHUNKS_PER_PAGE };
  }
}

/** Delete known page chunks in bounded batches after a successful replacement crawl. */
export async function deleteDocPages(
  env: Cloudflare.Env,
  pages: Array<{ url: string; chunks: number }>,
): Promise<{ ok: boolean; deleted: number }> {
  const index = vectorizeIndex(env);
  if (!index) return { ok: false, deleted: 0 };
  const ids: string[] = [];
  for (const page of pages) {
    const count = Math.min(MAX_CHUNKS_PER_PAGE, Math.max(0, Math.floor(Number(page.chunks) || 0)));
    for (let i = 0; i < count; i++) ids.push(chunkVectorId(page.url, i));
  }
  for (let i = 0; i < ids.length; i += VECTOR_DELETE_BATCH) {
    try {
      await index.deleteByIds(ids.slice(i, i + VECTOR_DELETE_BATCH));
    } catch (err) {
      console.warn("[docs-scraper] bulk delete failed:", (err as Error)?.message ?? err);
      return { ok: false, deleted: i };
    }
  }
  return { ok: true, deleted: ids.length };
}

/**
 * Retrieve the docs chunks most relevant to `query` from the global namespace.
 * Returns [] on any failure or when nothing is indexed yet, so callers can
 * simply omit the docs section from the prompt. Never throws.
 */
export async function retrieveDocChunks(
  env: Cloudflare.Env,
  query: string,
  topK = DOCS_TOP_K,
): Promise<DocChunk[]> {
  const index = vectorizeIndex(env);
  const q = query.trim();
  if (!index || !q) return [];

  const vectors = await embedTexts(env, [q.slice(0, MAX_QUERY_CHARS)]);
  if (!vectors) return [];

  let matches: VectorizeMatches;
  try {
    matches = await index.query(vectors[0], {
      topK,
      namespace: CFDOCS_NAMESPACE,
      returnMetadata: "all",
    });
  } catch (err) {
    console.warn("[docs-scraper] query failed:", (err as Error)?.message ?? err);
    return [];
  }

  const out: DocChunk[] = [];
  for (const m of matches.matches ?? []) {
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    const text = typeof meta.text === "string" ? meta.text : "";
    const url = typeof meta.url === "string" ? meta.url : "";
    if (!text || !isCloudflareDocsUrl(url)) continue;
    out.push({
      url,
      title: typeof meta.title === "string" ? meta.title : url,
      product: typeof meta.product === "string" ? meta.product : undefined,
      section: typeof meta.section === "string" ? meta.section : undefined,
      text,
      score: typeof m.score === "number" ? m.score : undefined,
    });
  }
  return out;
}

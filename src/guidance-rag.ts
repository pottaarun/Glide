/**
 * Guidance RAG — embed the room's admin "Team guidance" docs into Vectorize and
 * retrieve only the most relevant ones into Glide's system prompt at chat time.
 *
 * Why: enabled guidance docs used to be injected wholesale into every prompt
 * (see `renderGuidance` in system-prompt.ts). That's fine for a handful of notes
 * but doesn't scale — a large knowledge base would blow the context window and
 * dilute the prompt. Here we embed each doc on save and, per user message, pull
 * back only the top-k semantically relevant docs.
 *
 * Design contract (must never regress or break chat):
 *  - **Tenant isolation.** One Vectorize index is shared by every room, so each
 *    room's vectors are partitioned by a stable `namespace` derived from the DO
 *    instance name. Queries are scoped to that namespace.
 *  - **Enabled-only index.** We keep vectors ONLY for enabled, non-empty docs
 *    (disable/delete removes the vector), so retrieval can't surface a disabled
 *    doc even during Vectorize's brief eventual-consistency window.
 *  - **Safe fallback.** Every call is guarded and swallows errors. If the binding
 *    is missing, embedding fails, or a query returns nothing, callers fall back
 *    to the previous behaviour (inject all enabled docs). RAG is an optimisation,
 *    never a hard dependency.
 *
 * The embedding model (GLIDE_EMBED_MODEL) and the index dimensions are coupled
 * and immutable — see wrangler.jsonc.
 */
import type { GuidanceDoc } from "./shared";

/** Max chars of a doc (title + body) we feed the embedder (bge handles ~512 tokens). */
const MAX_EMBED_CHARS = 2_048;
/** Default number of guidance docs to retrieve per message. */
export const GUIDANCE_TOP_K = 6;

/** A guidance doc is worth indexing/injecting only if enabled and has text. */
export function isIndexableGuidance(d: GuidanceDoc): boolean {
  return d.enabled && Boolean(d.title.trim() || d.body.trim());
}

/**
 * Derive a short, stable, namespace-safe key for a room from the Durable Object
 * instance name. Vectorize namespaces are capped at 64 bytes and room names can
 * be long/arbitrary, so we hash to a compact ASCII token (two FNV-1a passes with
 * different seeds → ~13 chars) rather than use the raw name.
 */
export function roomKeyFor(name: string): string {
  const fnv = (seed: number): number => {
    let h = seed >>> 0;
    for (let i = 0; i < name.length; i++) {
      h ^= name.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  };
  // Mix in length too so same-prefix names don't collide as easily.
  const a = fnv(0x811c9dc5) ^ Math.imul(name.length, 0x9e3779b1);
  const b = fnv(0x1000001b3 & 0xffffffff);
  return "r" + (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

/** Stable vector id for a doc within a room (room-prefixed for uniqueness in the shared index). */
function vectorId(roomKey: string, docId: string): string {
  return `${roomKey}:${docId}`;
}

/** True when a usable Vectorize binding is present at runtime. */
export function hasVectorize(env: Cloudflare.Env): boolean {
  return Boolean((env as { VECTORIZE?: unknown }).VECTORIZE);
}

/** Text we embed for a doc: title then body, trimmed and length-capped. */
function guidanceText(d: GuidanceDoc): string {
  const t = d.title.trim();
  const b = d.body.trim();
  const combined = t && b ? `${t}\n\n${b}` : t || b;
  return combined.slice(0, MAX_EMBED_CHARS);
}

/**
 * Embed a batch of strings with the configured Workers AI model. Returns one
 * vector per input (same order), or null if embedding is unavailable/failed.
 *
 * Shared by guidance RAG and the Cloudflare-docs RAG (docs-scraper.ts) so both
 * use the exact same model/dimensionality as the Vectorize index. Best-effort:
 * never throws; callers treat null as "retrieval unavailable, fall back".
 */
export async function embedTexts(env: Cloudflare.Env, texts: string[]): Promise<number[][] | null> {
  if (!texts.length) return [];
  try {
    const res = (await env.AI.run(env.GLIDE_EMBED_MODEL, { text: texts })) as {
      data?: number[][];
    };
    const data = res?.data;
    if (!Array.isArray(data) || data.length !== texts.length) return null;
    return data;
  } catch (err) {
    console.warn("[guidance-rag] embed failed:", (err as Error)?.message ?? err);
    return null;
  }
}

/**
 * Upsert vectors for the given docs into the room's namespace. Docs that aren't
 * indexable (disabled/empty) have their vectors DELETED so they can't be
 * retrieved. Best-effort: never throws.
 */
export async function syncGuidanceVectors(
  env: Cloudflare.Env,
  roomKey: string,
  docs: GuidanceDoc[],
): Promise<{ upserted: number; deleted: number }> {
  const index = (env as { VECTORIZE?: VectorizeIndex }).VECTORIZE;
  if (!index || !docs.length) return { upserted: 0, deleted: 0 };

  const toIndex = docs.filter(isIndexableGuidance);
  const toDelete = docs.filter((d) => !isIndexableGuidance(d));

  let deleted = 0;
  if (toDelete.length) {
    try {
      await index.deleteByIds(toDelete.map((d) => vectorId(roomKey, d.id)));
      deleted = toDelete.length;
    } catch (err) {
      console.warn("[guidance-rag] deleteByIds failed:", (err as Error)?.message ?? err);
    }
  }

  let upserted = 0;
  if (toIndex.length) {
    const vectors = await embedTexts(env, toIndex.map(guidanceText));
    if (vectors) {
      const payload: VectorizeVector[] = toIndex.map((d, i) => ({
        id: vectorId(roomKey, d.id),
        values: vectors[i],
        namespace: roomKey,
        metadata: { docId: d.id },
      }));
      try {
        // Well under the 1,000-vectors/call Workers limit (docs are capped at 25).
        await index.upsert(payload);
        upserted = payload.length;
      } catch (err) {
        console.warn("[guidance-rag] upsert failed:", (err as Error)?.message ?? err);
      }
    }
  }
  return { upserted, deleted };
}

/** Delete a single doc's vector from the room's namespace. Best-effort. */
export async function deleteGuidanceVector(
  env: Cloudflare.Env,
  roomKey: string,
  docId: string,
): Promise<void> {
  const index = (env as { VECTORIZE?: VectorizeIndex }).VECTORIZE;
  if (!index) return;
  try {
    await index.deleteByIds([vectorId(roomKey, docId)]);
  } catch (err) {
    console.warn("[guidance-rag] delete failed:", (err as Error)?.message ?? err);
  }
}

/**
 * Retrieve the guidance docs most relevant to `query`, scoped to the room.
 *
 * Returns the matching docs from `allDocs` (still filtered to indexable, so
 * disabled/edited state always wins over the index), ordered by similarity.
 * Returns null when RAG is unavailable or errored, and [] when the index simply
 * had no matches — callers should treat BOTH as "fall back to injecting all
 * enabled docs" so a cold/again-consistent index never hides guidance.
 */
export async function retrieveGuidance(
  env: Cloudflare.Env,
  roomKey: string,
  query: string,
  allDocs: GuidanceDoc[],
  topK = GUIDANCE_TOP_K,
): Promise<GuidanceDoc[] | null> {
  const index = (env as { VECTORIZE?: VectorizeIndex }).VECTORIZE;
  const q = query.trim();
  if (!index || !q) return null;

  const vectors = await embedTexts(env, [q.slice(0, MAX_EMBED_CHARS)]);
  if (!vectors) return null;

  let matches: VectorizeMatches;
  try {
    matches = await index.query(vectors[0], {
      topK,
      namespace: roomKey,
      returnMetadata: "none",
    });
  } catch (err) {
    console.warn("[guidance-rag] query failed:", (err as Error)?.message ?? err);
    return null;
  }

  const byId = new Map(allDocs.filter(isIndexableGuidance).map((d) => [d.id, d]));
  const prefix = `${roomKey}:`;
  const out: GuidanceDoc[] = [];
  const seen = new Set<string>();
  for (const m of matches.matches ?? []) {
    const docId = m.id.startsWith(prefix) ? m.id.slice(prefix.length) : m.id;
    if (seen.has(docId)) continue;
    const doc = byId.get(docId);
    if (doc) {
      out.push(doc);
      seen.add(docId);
    }
  }
  return out;
}

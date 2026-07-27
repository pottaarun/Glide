# Architecture

Glide runs entirely on Cloudflare. A single Worker serves a React single-page app
and routes chat to a [Durable Object](https://developers.cloudflare.com/durable-objects/)
built on the [Agents SDK](https://developers.cloudflare.com/agents/); the chat
brain is [Workers AI](https://developers.cloudflare.com/workers-ai/).

```
Browser (React SPA, src/client/main.tsx)   /  = chat room   ·   /admin = read-only dashboard
   │  WebSocket (state sync + streaming chat) and HTTP delivery verification
   ▼
Worker (src/server.ts, default fetch handler)
   ├── routeAgentRequest()  ──►  GlideAgent (Durable Object)
   │                               ├── AIChatAgent: streaming chat + message history
   │                               ├── GlideState: synced room memory + pending queue
   │                               ├── SQLite: encrypted token, snapshots, queues, last config
   │                               ├── secret-redacted history + structured glideEvent logs
   │                               ├── LLM tools (reads run; writes queue)
   │                               ├── Team guidance RAG ──► AI embed + Vectorize (src/guidance-rag.ts)
   │                               ├── Cloudflare-docs RAG ──► scrape + embed + Vectorize (src/docs-scraper.ts)
   │                               └── Apply/Reject RPCs ──► Cloudflare API (src/cf-api.ts)
   ├── env.ASSETS.fetch()   ──►  static React build (dist/client)
   └── scheduled()          ──►  weekly Cloudflare-docs reindex (cron: Sun 02:00 UTC)

                 (optional) MIGRATION service binding / MIGRATION_API_URL
                                         │  read-only endpoints
                                         ▼
                             Switchflare / migration tool Worker (src/migration.ts)
```

## Worker entry point

The default export in `src/server.ts` is tiny — it routes agent traffic to the
Durable Object and otherwise serves the static SPA. A sibling `scheduled()`
handler drives the weekly Cloudflare-docs reindex:

```ts
export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    return (await routeAgentRequest(request, env)) ?? env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
```

- `routeAgentRequest()` (Agents SDK) handles `/agents/*` — the WebSocket upgrade,
  state sync, streaming chat, and `@callable` RPC dispatch — by mapping to a
  `GlideAgent` instance.
- Anything else falls through to the `ASSETS` binding, which serves the built
  client from `./dist/client` with SPA fallback (`wrangler.jsonc:18`,
  `not_found_handling: "single-page-application"`, `run_worker_first: true`).

## A "room" is one Durable Object instance

A **room** is a single `GlideAgent` instance, addressed by name. The client uses
the URL hash as that name (`Room()` and `useAgent<GlideState>()` in
`src/client/main.tsx`).
Open the same link and you share the same agent — same chat transcript, same
pending queue, same memory.

The default room id is a **128-bit, URL-safe random value**
(`crypto.randomUUID().replace(/-/g, "")`, `src/client/main.tsx:65`). Because the
room link doubles as the access credential (there is no per-user login), the
default must not be guessable — see [Security model](./security.md).

## `GlideAgent`: an `AIChatAgent` with synced state

`GlideAgent extends AIChatAgent<Cloudflare.Env, GlideState>` in `src/server.ts`.
That base class gives it:

- **Streaming chat** with persisted message history and resumable streams.
- **Synced state** (`GlideState`) — broadcast live to every connected client.
- **SQLite** (`this.sql`) — durable, server-side storage that is never synced.
- **`@callable()` RPCs** — methods the client invokes over the WebSocket.

### `onStart()` — table creation + status flags

On boot, the agent creates six application-owned SQLite tables, scrubs token-shaped
text from old persisted messages, and refreshes room status flags:

| Table | Columns | Purpose |
| --- | --- | --- |
| `glide_snapshots` | `action_id` PK, `zone_id`, `ts`, `data` | Best-effort zone snapshot captured **before** an Apply mutates a zone (a rollback breadcrumb). |
| `glide_secrets` | `name` PK, `value`, `ts` | The Cloudflare API token, **AES-256-GCM encrypted** (`name = "cf_api_token"`). |
| `glide_migration_src` | `id` PK, `provider`, `data`, `ts` | Raw provider config from the last preview (`id = "last"`), kept server-side so Terraform/CSV export can reuse it. **Never synced.** |
| `glide_action_notifications` | `id` PK, `completed`, `ts` | Idempotency marker for scheduled chat follow-ups after Apply/Reject. |
| `glide_docs_products` | `product` PK, `label`, `url`, `category`, `enumerated` | Product-discovery queue for the Cloudflare-docs reindex job. |
| `glide_docs_pages` | `url` PK, `product`, `title`, `section`, `status`, `chunks` | Per-page work queue and progress for the docs reindex job. |

`sanitizeMessageForPersistence()` also protects every newly persisted text part.
On startup, older messages are rewritten idempotently if they contain a
recognizable `cfat_...`, `cfut_...`, or `cfk_...` value; the encrypted value in
`glide_secrets` is not touched. The agent then recomputes `tokenConfigured` by
successfully decrypting this room's stored token, `migrationToolConfigured` (a `MIGRATION` binding
**or** `MIGRATION_API_URL` is set), and any stale Apply-attempt recovery state.
There is no deployment-wide Cloudflare API token fallback.

## The chat-turn lifecycle

`onChatMessage()` in `src/server.ts` runs each turn:

1. **Correlate and attribute.** A `turnId` is generated and `chat.received` records
   the room, turn, latest `messageId`, message count, and whether this is a
   server-generated action-result event. `resolveActor()` selects the human name
   from the request body or latest message metadata for queued-action attribution.
2. **Prepare context.** Deterministic onboarding inference fills any missing
   fields from the latest user text. Team-guidance and Cloudflare-docs retrieval
   run concurrently; `chat.prepared` records their result counts. Retrieved docs
   are also folded into the room's capped, deduplicated `docLinks` reading list.
3. **Build the model call.** `buildSystemPrompt()` injects room memory, defaults,
   onboarding state, migration state, retrieved guidance, retrieved Cloudflare
   docs, and the safety contract. `buildTools()` supplies the LLM tools. The first
   `streamText()` pass allows at most 8 tool steps.
4. **Recover incomplete model behavior.** Pass output is buffered before replay.
   If a model ends on a tool call with no prose, Glide runs a tool-less narration
   pass. If it promises a tool action or emits a literal tool call without running
   it, Glide can run one required-tool continuation and then narrate. Unsupported
   claims that an action was queued are corrected against the server-owned queue.
   During active onboarding, a successful `list_dns_records` result that ends
   without a real user hand-off triggers `chat.onboarding_nudge`: narration is
   rebuilt from the post-tool state and a deterministic proxy-status question is
   appended if the second model pass still does not ask one.
5. **Emit one assistant message.** Buffered chunks are replayed through one
   `createUIMessageStream`; `sendReasoning: false` keeps the model's harmony
   reasoning channel out of the room, and exactly one final `finish` is emitted.
6. **Record the outcome.** `chat.model_pass`, `chat.stream_created`, and
   `chat.stream_finished` expose the stage and outcome. Exceptions additionally
   emit `chat.error` before being rethrown.

> **gpt-oss is non-streaming on Workers AI.** `@cf/openai/gpt-oss-120b` doesn't
> support `/ai/run` streaming, so `workers-ai-provider` transparently makes a
> single non-streaming call and synthesizes the token stream. `dedupAIBinding()`
> (`src/server.ts:677`) wraps the `AI` binding to guard against duplicated SSE
> frames; it's a no-op for gpt-oss.

## The client delivery lifecycle

The browser treats the persisted Durable Object transcript as authoritative rather
than assuming an optimistic chat bubble reached the server:

1. `useAgent()` tracks the WebSocket `readyState`. The header shows **live** only
   for `WebSocket.OPEN`; otherwise it shows **reconnecting**, preserves the draft,
   and blocks Send.
2. The transport wrapper checks readiness again at the actual `send()` call and
   throws if the socket closed or `agent.send()` reports that it only buffered the
   frame. This closes the gap between a button click and the asynchronous send.
3. Every user send gets a client-generated `messageId` and captures the current
   `connectionEpoch`. If the connection changes before a complete local response,
   the client fetches `/get-messages` with `cache: "no-store"`.
4. `persistedDeliveryStatus()` in `src/chat-delivery.ts` classifies the result:
   `delivered` means the user message is followed by an assistant message;
   `not_delivered` means the id is absent; `response_interrupted` means the user
   message persisted without a following assistant response.
5. For `not_delivered`, the optimistic bubble is removed and the original text is
   restored to the composer. For `response_interrupted`, **Retry response** calls
   the chat continuation without adding a duplicate user message.
6. `reportClientChatIssue()` records only the classification, message id, and
   connection epoch. It never sends message text to the diagnostic log.

The composer also exposes **Stop** while a turn is busy and marks a turn stalled
after 20 seconds without progress, so a dropped stream cannot disable Send
forever. Deployments can interrupt an active Durable Object turn; wait for
**live** or hard-refresh before sending after a deploy.

## Structured chat events

`logChatEvent()` writes object logs with `glideEvent` and `room` on every record.
Depending on the event, records also contain `turnId`, `messageId`, `stage`,
`outcome`, `kind`, `connectionEpoch`, and numeric counts. Message text and token
values are intentionally excluded.

The lifecycle events are `chat.received`, `chat.prepared`, `chat.model_pass`,
`chat.stream_created`, `chat.stream_finished`, and `chat.error`. Client recovery
adds `chat.client_issue`; startup sanitization adds `chat.secrets_redacted`.
Observability is enabled in `wrangler.jsonc`. See
[Troubleshooting & observability](./troubleshooting.md) for queries and an incident
workflow.

### Why tool output is clipped

Read tools echo their result back to the model through `clip()`
(`src/server.ts:484`), which caps any payload at **`MAX_READ_CHARS` = 6 000 chars**
(`src/server.ts:109`) and appends `…(truncated — narrow your query)`. This protects
the context window from a huge `list_zones`/`cf_get` response.

## Synced room state (`GlideState`)

`GlideState` (`src/shared.ts:62`) is the room's live, persistent memory. Every
field is broadcast to all clients via `onStateUpdate` (`src/client/main.tsx:375`).

| Field | Type | Meaning |
| --- | --- | --- |
| `memory` | `Record<string,string>` | Durable free-form facts (account ids, naming conventions, preferences). |
| `pendingActions` | `PendingAction[]` | Changes awaiting human approval, currently applying, or retained after a failed attempt for Retry. |
| `recentResults` | `ActionResult[]` | Last applied/failed/rejected outcomes, newest first (capped at `MAX_RECENT_RESULTS` = 25, `src/server.ts:107`). |
| `invites` | `Invite[]` | People invited by email (most recent first, capped at 100). |
| `defaultAccountId` | `string?` | Convenience default so users needn't repeat the account id. |
| `defaultZone` | `{ id, name, accountId? }?` | Convenience default zone plus owning-account provenance. Legacy rooms may lack `accountId`; zone creation verifies that provenance unless the caller supplies an explicit account. |
| `tokenConfigured` | `boolean` | This room's encrypted GUI token is available and decryptable. |
| `tokenLast4` | `string?` | Last 4 chars of the GUI-set token (status only). |
| `tokenValid` | `boolean?` | Result of the latest token authentication check: `/user/tokens/verify`, with account/zone read fallback for account-scoped tokens. |
| `onboarding` | `OnboardingState?` | Guided onboarding progress; its `checklist` auto-completes as info is captured (see [Onboarding & migration](./onboarding-and-migration.md)). |
| `businessProfile` | `BusinessProfile?` | The team's "nature of the business" discovery answers (`industry`, `appTypes`, `hasLogin`, `hasApi`, `audience`, `trafficProfile`, `sensitiveData`, `compliance`, `concerns`, `notes`, `completed`; `src/shared.ts:299`). Captured in chat during onboarding and on-demand; feeds the recommendation engine. Kept at the room level (not inside `onboarding`) so the advisor keeps working after go-live. Rendered in the sidebar **Recommendations** panel and the `/admin` dashboard. |
| `docLinks` | `DocLink[]?` | Up to 12 official `https://developers.cloudflare.com` pages surfaced by per-turn docs retrieval, deduplicated by URL and ordered by recency. Rendered as the room's **Cloudflare docs** reading list in the sidebar and `/admin`; users can clear it without changing the Vectorize index. |
| `migrationPlan` | `MigrationPlan?` | Most recent provider-config preview as CF rules (rules capped at `MAX_PLAN_RULES` = 300, `src/server.ts:113`). |
| `terraform` | `TerraformArtifact?` | Most recent Terraform export (downloadable). |
| `csv` | `TerraformArtifact?` | Most recent CSV export (downloadable). |
| `migrationCheck` | `MigrationCheck?` | Result of the last preflight / diff / validate. |
| `snapshots` | `SnapshotInfo[]?` | Zone snapshots (restore points), capped at 50. |
| `migrationToolConfigured` | `boolean?` | Whether a migration tool is connected (binding or URL). |
| `guidance` | `GuidanceDoc[]?` | Team-guidance docs for the room (`title`, `body`, `enabled`, `updatedBy`, `ts`; `src/shared.ts:184`), capped at `MAX_GUIDANCE_DOCS` = 25 (`src/server.ts:115`). Edited from the admin dashboard; embedded into Vectorize (see below). |
| `docsIndex` | `DocsIndexState?` | Internal progress of the cron-owned Cloudflare-docs reindex job: status, products/pages/chunks counters, `runId`, and attribution. Present only on the fixed system Durable Object, not normal rooms. |

> **What is _not_ synced:** the decrypted token, the raw provider config
> (`glide_migration_src`), and the pre-apply zone snapshots (`glide_snapshots`).
> Those live only in SQLite. The guidance **vectors** are likewise not synced —
> they live in Vectorize (only the plain-text `guidance` docs are in state).

### Key supporting types

- **`PendingAction`** (`src/shared.ts:9`) — `product`, `summary`, `method`
  (`POST|PUT|PATCH|DELETE`), `path`, optional `body`, optional `zoneId`,
  `createdBy`, `ts`, lifecycle `status` (`pending | applying | failed`), last
  `error` / `attemptedAt`, and an optional `mergeEntrypoint` (see below).
- **`ActionResult`** (`src/shared.ts:47`) — outcome of an apply/reject, `status`
  is `applied | failed | rejected`.
- **`OnboardingState`** / **`MigrationPlan`** / **`BusinessProfile`** — documented
  in [Onboarding & migration](./onboarding-and-migration.md).

Synced state is server-owned: `validateStateChange()` rejects direct client
state writes. UI changes flow through callable methods, so a browser cannot
inject a privileged API request into `pendingActions`. The `queueRecommendation`
RPC (`src/server.ts:1249`) is a good example: the browser sends only a
recommendation id and a target zone id, and the server recomputes the
recommendation from the room's **trusted** `businessProfile` and rebuilds the exact
Cloudflare call from `src/recommendations.ts`'s own catalog
(`recommendationToPending()`) — never from a client-supplied path/body. It also
requires a 32-hex zone id and de-duplicates against the queue, so a one-click
**Queue** button cannot inject an arbitrary API request.

### `mergeEntrypoint`: never silently drop ruleset rules

Cloudflare ruleset phase entrypoints are replaced as a whole via `PUT`. To avoid
clobbering rules added by anyone after an action was queued, migration-queued
ruleset actions carry `mergeEntrypoint: { phase, newRules }` (`src/shared.ts:28`).
At **Apply** time, `applyAction` re-reads the phase's *current* rules and appends
`newRules` via `mergeEntrypointRules()` (`src/server.ts:2594`), so the stored
`body` is only a queue-time preview. `stripRuleForPut()` (`src/server.ts:473`)
normalises each rule for the `PUT`.

### Approval lifecycle and concurrency fences

Pending actions are server-owned records with `pending`, `applying`, or `failed`
state. `applyAction` marks the record applying before any snapshot or network I/O.
An interrupted attempt becomes **outcome uncertain** after the stale threshold;
it cannot be retried through `applyAll`, and an individual retry is rejected until
the client has shown the live-state warning and sends explicit confirmation.

Bulk approval is snapshot-based rather than "whatever is pending now": the client
sends the exact reviewed IDs, and `selectBulkApplyIds()` intersects them with the
current queue. An action queued after review is never swept into the request.
Actions that are already applying or whose prior outcome is uncertain are skipped.

`actionResourceKey()` fences logical resources while Apply awaits external I/O:
`PUT`, `PATCH`, and `DELETE` to the same canonical API path share one lock even
when their methods differ. Ruleset entrypoints use a zone/phase key. Zone creation
uses an account/normalized-domain key and is also deduplicated centrally in
`queuePending()`. The generic `cf_write` tool refuses `POST /zones`, preserving
the dedicated `add_domain` existence and duplicate checks.

## The Cloudflare API client (`src/cf-api.ts`)

A structured, never-throwing client (ported from switchflare). Every call returns
a `CfResult<T>` — `{ ok: true, result }` or `{ ok: false, status, category,
message, hint? }`.

- **Retry/backoff** (`cfRequest`): retries only on `RETRYABLE_STATUSES`
  `{429, 500, 502, 503, 504}`; **GETs allow up to 3 retries**, while writes are
  attempted once with **no automatic retry** because a lost response can hide a
  committed mutation. Backoff is `1500ms × attempt`. Read timeout is 25 s; write
  timeout is 60 s.
- **Error classification** (`classifyHttpError`, `src/cf-api.ts:66`): `auth` (401),
  `permission` (403 or CF codes 9109/10000), `not_found` (404), `conflict` (409),
  `rate_limit` (429), `validation` (4xx), `transient` (5xx), `network`, `unknown`.
- **Permission hints** (`PERMISSION_MAP`, `src/cf-api.ts:45`): maps an API path to
  the token permission it needs, so a 403 tells you exactly what to grant. See the
  table in [Setup & configuration](./setup.md#cloudflare-api-token-permissions).
- **Pagination** (`cfGetAll`, `src/cf-api.ts:182`): follows `total_pages` up to a
  hard cap of 50 pages × 50 per page.
- **Token verification** (`verifyToken`): tries `/user/tokens/verify`, then real
  `/accounts` and `/zones` reads because the user-scoped verify endpoint can
  reject otherwise valid account-scoped tokens.
- **Response-envelope validation:** a 2xx response is successful only when it has
  a valid Cloudflare API envelope. A malformed 2xx write response is `transient`,
  so Apply records an uncertain outcome instead of inviting a blind retry.
- **Zone snapshot** (`snapshotZone`, `src/cf-api.ts:252`): captures 8 zone settings
  (`security_level`, `ssl`, `min_tls_version`, `always_use_https`,
  `automatic_https_rewrites`, `tls_1_3`, `browser_check`, `brotli`) plus the
  zone's rulesets — used as a rollback breadcrumb before an Apply.

## The migration tool client (`src/migration.ts`)

A **read-only** client for the optional Switchflare / migration tool Worker. Glide
only ever calls side-effect-free endpoints and **never** calls
`/api/migrations/start` (which would deploy directly) — all real changes flow
through Glide's queue → Apply contract.

- Transport (`MigrationTransport`, `src/migration.ts:74`): prefers the `MIGRATION`
  **service binding** (works even when the tool is behind Cloudflare Access),
  falling back to `MIGRATION_API_URL`. When using the binding it fetches
  `https://migration.internal${path}` (the host is ignored by the target Worker's
  path router).
- Endpoints used: `/api/providers`, `/api/preview-rules`,
  `/api/generate-terraform`, `/api/preflight`, `/api/diff-report`,
  `/api/export-csv`, `/api/validate-config`, `/api/snapshots`,
  `/api/snapshots/:id`, `/api/restore`.
- Limits: 20 s timeout; inline, uploaded, and URL-fetched config are capped at
  `MAX_CONFIG_BYTES` = 2 000 000 UTF-8 bytes. URL bodies are streamed and cancelled
  as soon as they cross the limit; uploads are capped at `MAX_CONFIG_FILES` = 50.

See [Onboarding & migration](./onboarding-and-migration.md) for the full flow.

## Team guidance (RAG) — `src/guidance-rag.ts`

Admins attach **guidance docs** to a room (house rules, preferred defaults, the
onboarding questions Glide should ask). Rather than injecting every doc into the
prompt forever, Glide embeds them and retrieves only the relevant ones per turn.

- **Data model.** `GuidanceDoc` (`src/shared.ts:184`) — `id`, `title`, `body`,
  `enabled`, `updatedBy?`, `ts`. The list lives on `state.guidance` (synced);
  vectors live in Vectorize (not synced).
- **Bindings.** `AI` (embeddings) + `VECTORIZE` (`glide-guidance`, 768-dim,
  cosine). The embed model is `GLIDE_EMBED_MODEL` = `@cf/baai/bge-base-en-v1.5`
  (`wrangler.jsonc:47`); its dimensionality must match the index.
- **Per-room isolation.** Every upsert/query is scoped to a Vectorize `namespace`
  derived from the room name by `roomKeyFor()` (`src/guidance-rag.ts:44`, two
  FNV-1a passes → a ~13-char key, safely under Vectorize's 64-byte namespace cap).
  Vector ids are `${roomKey}:${docId}`.
- **Write path.** On any guidance edit, `syncGuidanceVectors()`
  (`src/guidance-rag.ts:105`) embeds enabled/non-empty docs (`env.AI.run`,
  `src/guidance-rag.ts:88`) and upserts them; disabled/empty docs are removed via
  `deleteByIds`. `MAX_EMBED_CHARS` = 2 048 (`src/guidance-rag.ts:29`).
- **Read path.** Each turn, `selectGuidanceForPrompt()` (`src/server.ts:1241`)
  decides: if there are `≤ GUIDANCE_INJECT_ALL_MAX` (= 6, `src/server.ts:123`)
  enabled docs **or** there's no Vectorize binding, it returns `undefined` and
  `buildSystemPrompt()` injects **all** enabled docs (`renderGuidance()`,
  `src/system-prompt.ts:113`). Otherwise it embeds the latest user message and
  calls `retrieveGuidance()` (`src/guidance-rag.ts:172`) for the top
  `GUIDANCE_TOP_K` = 6 (`src/guidance-rag.ts:31`) matches.
- **Graceful degradation.** Absent binding, an embed failure, or zero matches all
  fall back to injecting the enabled docs — every Vectorize/AI call is wrapped in
  try/catch that warns and degrades, so guidance never breaks a chat turn.

The RPCs that drive this (`upsertGuidanceDoc`, `deleteGuidanceDoc`,
`reindexGuidance`) are in [Tools & RPC reference](./tools.md#team-guidance).

## Cloudflare-docs RAG — `src/docs-scraper.ts`

Alongside per-room guidance, Glide grounds its answers in the **official Cloudflare
developer docs**. A background job scrapes, embeds, and indexes those docs into a
**shared** Vectorize namespace, and every chat turn retrieves the most relevant
excerpts into the prompt.

- **Scrape → clean → chunk.** Starting from `DOCS_ROOT_INDEX`
  (`https://developers.cloudflare.com/llms.txt`, `src/docs-scraper.ts:29`),
  `parseTopIndex()` (`:120`) discovers products and `parseProductIndex()` (`:150`)
  their pages. `fetchDocText()` (`:81`) pulls each page's Markdown, `cleanDocMarkdown()`
  (`:184`) strips chrome, and `chunkText()` (`:206`) splits it on paragraph
  boundaries (`MAX_CHUNKS_PER_PAGE` cap).
- **Shared index, deterministic ids.** Chunks are embedded with `GLIDE_EMBED_MODEL`
  and upserted into the **global** `CFDOCS_NAMESPACE` (`__cfdocs_v2__`,
  `src/docs-scraper.ts:31`) — distinct from the per-room `r…` guidance keys — with
  ids derived from the page URL (`cfdoc:<hash>#<i>`), so every room benefits.
- **The reindex job.** One fixed internal Durable Object owns the queue and global
  lock. `startDocsReindex()` is not a browser-callable RPC; the job runs in bounded
  batches chained through the Agents SDK scheduler. Before replacing the queue it
  deletes all vectors recorded by the previous canonical run, and each page also
  removes obsolete tail chunk ids before upsert. The versioned `v2` namespace
  excludes pre-hardening vectors created by arbitrary room-owned runs.
- **Weekly refresh.** The Worker's `scheduled()` handler (`src/server.ts:3078`),
  wired to the `Sun 02:00 UTC` cron in `wrangler.jsonc`, drives a full reindex
  automatically via one well-known DO.
- **Read path.** Each turn, `selectDocsForPrompt()` (`src/server.ts:1551`) calls
  `retrieveDocChunks()` (`src/docs-scraper.ts:333`) for the top `DOCS_TOP_K` = 4
  (`src/docs-scraper.ts:33`) matches, and `renderDocs()` (`src/system-prompt.ts:137`)
  injects them (with URLs to cite) into the system prompt. The same hits are
  merged into `state.docLinks`, capped at 12 and displayed as a running reading
  list. Index parsing, retrieval, state merging, and rendering all reject URLs
  outside the official HTTPS developer-docs origin.
- **Graceful degradation.** Gated by `hasVectorize()` (`src/docs-scraper.ts:69`);
  without the `VECTORIZE` binding the feature is simply inert and never breaks a
  chat turn.

## The admin dashboard (`/admin`)

`/admin#<room>` is read-only for Cloudflare configuration over the same `GlideAgent`. The
client is a single SPA: `Root()` (`src/client/main.tsx:2796`) checks
`isAdminPath()` (`src/client/main.tsx:1768`, matches `/admin`) and renders
`AdminGate` instead of the chat `App`; the room id comes from the URL hash, so
`/admin#<room>` and `/#<room>` address the same Durable Object.

It **reads** three sources — it defines no dedicated read RPCs:

- **Synced `GlideState`** via `useAgent()` — pending queue, results, invites,
  onboarding, migration plan/check, snapshots, exports, guidance, token status.
- **The chat transcript** via `useAgentChat()` — powers the **Comms** tab.
- **A build-time docs manifest** (`virtual:glide-docs`, generated by the
  `glide-docs-manifest` Vite plugin in `vite.config.ts`) — powers the **Dev docs**
  tab. It embeds README + everything under `docs/` at build time (title,
  last-modified, size, lines, content), so a fresh `npm run build` refreshes it.

Tabs are `comms | actions | guidance | docs | onboarding`
(`AdminTab`, `src/client/main.tsx:1959`; tab bar built at `src/client/main.tsx:2383`).
There are no Apply/Reject controls in admin — the **Actions** tab is view-only and
directs you to the chat room. **Team guidance** is the only editable tab and uses
its three room-scoped guidance RPCs. The deployment-wide Cloudflare-docs index has
no admin tab or client-callable controls.

## Client styling

The UI has no CSS framework; its look comes from three cooperating layers:

1. **Inline `S` styles object** (`const S` in `src/client/main.tsx`) — the
   single source of every component's *static* appearance (`React.CSSProperties`).
   Gradient/font recipes are shared consts: `GRAD_BRAND`, `GRAD_CTA`, `DISPLAY`,
   `MONO`, and the gradient-text `brandText` (`src/client/main.tsx:2820`).
2. **`src/client/index.css`** — everything inline styles can't express: font
   wiring, restrained ambient light, the fine-pointer glow, glass edge treatment,
   hover/focus/entrance motion, approval status rails, responsive desktop/tablet/
   mobile layouts, custom scrollbars, and a `prefers-reduced-motion` reset.
3. **`index.html`** — preconnects and loads the fonts (Space Grotesk, Inter,
   JetBrains Mono) and paints the twilight background before React mounts.

The convention: inline `S` wins on the base property; `index.css` layers on the
`:hover`/animation/pseudo-element behaviour that inline styles can't reach.

## Source layout

| File | Responsibility |
| --- | --- |
| `src/server.ts` | Worker entry + the `GlideAgent` Durable Object: chat brain, structured chat events, secret-safe persistence, LLM tools, approval/token/diagnostic RPCs, RAG jobs, and migration helpers. |
| `src/client/main.tsx` | The React client: join screen, delivery-aware chat room, connection recovery, chat-led onboarding + opt-in form wizard, sidebar, read-only `/admin` dashboard, and inline styles. |
| `src/client/index.css` | Global visual layer: font wiring, restrained ambient light and pointer glow, hover/focus/entrance motion, responsive layouts, scrollbars, and the reduced-motion reset. See [Client styling](#client-styling). |
| `src/shared.ts` | Types shared by the Worker and the client (`GlideState`, `PendingAction`, `OnboardingState`, `MigrationPlan`, `BusinessProfile`, `GuidanceDoc`, …). Pure types only. |
| `src/recommendations.ts` | Pure, deterministic recommendation engine: maps a `BusinessProfile` to tailored, priority-ranked Cloudflare recommendations (rationale, triggering signals, docs citation), and maps the concrete ones to queue-ready API calls (`recommendationToPending` / `isRecommendationQueueable`). Imports only types from `src/shared.ts`, so it's **client-safe** and shared by the Worker (the `recommend_configuration` tool + `queueRecommendation`) and the React client (the sidebar Recommendations panel). |
| `src/system-prompt.ts` | Builds the LLM system prompt, injecting room memory, onboarding status, the migration plan, and the retrieved team-guidance docs. Encodes the safety contract. |
| `src/guidance-rag.ts` | Team-guidance RAG: embeds docs with `GLIDE_EMBED_MODEL`, upserts/queries Vectorize per room (namespace-isolated), and degrades gracefully when the index is absent. |
| `src/docs-scraper.ts` | Cloudflare-docs RAG: scrapes/cleans/chunks the developer docs, embeds them into the shared `__cfdocs_v2__` Vectorize namespace with deterministic ids, and retrieves the top matches per turn. |
| `src/cf-api.ts` | Cloudflare API client: retry/backoff, typed error classification, a permission-hint map, and zone-snapshot capture. |
| `src/chat-delivery.ts` | Pure delivery classification plus Cloudflare token detection and redaction helpers shared by the client and server. |
| `src/migration.ts` | Read-only client for the Switchflare / migration tool Worker (preview, Terraform, pre-flight, diff, validate, CSV, snapshots, restore). |
| `src/env.d.ts` | Augments the generated `Cloudflare.Env` with secrets not declared in `wrangler.jsonc`. |
| `wrangler.jsonc` | Worker config: Durable Object, AI binding, `VECTORIZE` binding, optional `MIGRATION` service binding, static assets, and the `GLIDE_MODEL` / `GLIDE_EMBED_MODEL` vars. |
| `vite.config.ts` | Builds the React client to `dist/client` (served by the `ASSETS` binding) and generates the `virtual:glide-docs` manifest for the admin **Dev docs** tab. |
| `index.html` | SPA entry; loads fonts + `src/client/main.tsx`. |

## Bindings (`wrangler.jsonc`)

| Binding | Type | Notes |
| --- | --- | --- |
| `GlideAgent` | Durable Object | `new_sqlite_classes: ["GlideAgent"]` (migration tag `v1`). |
| `AI` | Workers AI | Powers the chat brain, guidance embeddings, and Cloudflare-docs embeddings. |
| `VECTORIZE` | Vectorize index | `glide-guidance` (768-dim, cosine) for per-room guidance and the shared `__cfdocs_v2__` namespace. Create it once — see [Setup](./setup.md). |
| `ASSETS` | Static assets | Serves `./dist/client` with SPA fallback; `run_worker_first: true`. |
| `MIGRATION` | Service binding | Points at a Worker named `switchflare`. Optional and **commented out by default** — see [Setup](./setup.md). |

`compatibility_date` is `2025-06-01` with the `nodejs_compat` flag, and
Workers Observability is enabled. A **cron trigger** (`triggers.crons: ["0 2 * * SUN"]`)
fires the `scheduled()` handler weekly to refresh the Cloudflare-docs index.

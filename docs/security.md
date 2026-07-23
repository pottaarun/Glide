# Security model

Glide drives a powerful API on behalf of a whole room of people, so its security
properties matter. This page documents the guarantees, how they're implemented,
and the threat model's sharp edges.

## The core guarantee: reads run, writes wait

> **The LLM can only _queue_ changes. A real Cloudflare write happens in exactly
> one place — the `applyAction` RPC — triggered by a human clicking Apply.**

- Every "write" tool (`add_domain`, `create_dns_record`, `set_zone_setting`,
  `create_waf_custom_rule`, `cf_write`, `queue_migration_rules`) calls
  `queuePending()` (`src/server.ts:2274`), which only appends a `PendingAction`
  to synced state. None of them touch Cloudflare.
- `applyAction()` (`src/server.ts:2956`) is the **only** code path that calls a
  mutating Cloudflare method (`cfRequest(action.method, …)` at
  `src/server.ts:3001`). Search the codebase: there is no other `POST/PUT/PATCH/
  DELETE` to the Cloudflare API.
- The system prompt reinforces this (`src/system-prompt.ts:43`): the model is
  instructed never to claim a change is "done/live/created" until it's applied.

This is what makes Glide safe to use collaboratively: the LLM proposes, humans
dispose.

## Tokens are encrypted at rest

GUI-provided Cloudflare API tokens are sealed with **AES-256-GCM** before being
written to the Durable Object's SQLite (`glide_secrets` table). The key is
**derived from the Worker-held `GLIDE_TOKEN_KEY` secret via HKDF-SHA-256**, so the
ciphertext in the DO is useless without that Worker secret.

Implementation (`src/server.ts:723`–754):

- `deriveAesKey()` — HKDF-SHA-256 with fixed salt `glide:token:salt:v1` and info
  `glide:token:aes-gcm:v1`, producing a 256-bit AES-GCM key.
- `encryptSecret()` — random 12-byte IV; stored as `base64(iv):base64(ciphertext)`.
- `decryptSecret()` — reverses it; on failure (corrupt/rotated key) Glide falls
  back to `CF_API_TOKEN` rather than erroring.

Properties:

- The plaintext token is **never synced to clients, never logged, never returned**.
- Only non-sensitive status is exposed in `GlideState`: `tokenConfigured`,
  `tokenLast4` (last 4 chars), and `tokenValid` (last authentication check).
- Without `GLIDE_TOKEN_KEY`, **GUI token storage is disabled** —
  `setCloudflareToken` refuses and tells the operator to set the key
  (`src/server.ts:1091`). Only `CF_API_TOKEN` is used in that case.
- `setCloudflareToken` first tries `/user/tokens/verify`, then authenticated
  `/accounts` and `/zones` reads. The fallback matters because the verify endpoint
  is user-scoped and can reject a valid account-scoped token. It stores the token
  regardless so a transient check cannot lock out an otherwise-usable credential.
- A reconnecting client calls `reverifyToken` once when a stored token is marked
  unverified, allowing old false negatives to self-correct without re-entry.

> **Token resolution order** (`getToken()`, `src/server.ts:1073`): GUI-stored
> token (decrypted) first, then the `CF_API_TOKEN` secret.

## Tokens are kept out of chat and logs

The connection form is the only supported place for a room member to enter a
Cloudflare API token. The normal chat path has three layers of protection:

- Before sending, the client rejects recognizable `cfat_...` tokens and directs
  the user to **Connection → Set token** or **Connection → Change**.
- `sanitizeMessageForPersistence()` replaces matching values with
  `[Cloudflare API token redacted]` before any text part is stored.
- When a room wakes, `onStart()` applies the same sanitizer to historical messages
  created before this guard existed and persists the cleaned transcript.

Structured `glideEvent` logs contain identifiers, counts, stages, and outcomes,
not chat text or token values. `reportClientChatIssue` similarly accepts only a
delivery classification, message id, and connection epoch.

The recognizer is defense in depth, not a credential-revocation mechanism. It is
deliberately scoped to Cloudflare API token strings beginning with `cfat_`; a
different secret format or an obfuscated value can bypass it. If any secret is
pasted into chat, browser logs, an issue, or another unintended location, revoke
and rotate it even if Glide later displays a redacted transcript.

## The room link is the credential

There is **no per-user authentication**. A room is identified by its URL hash, and
**anyone with the link can read the room and Apply changes using its token.**

- Default rooms get a **128-bit random id** (`newRoomId()`,
  `src/client/main.tsx:65`) so they aren't guessable. Treat the link like a
  password.
- The Invite panel makes this explicit and warns before sharing
  (`src/client/main.tsx:1050`).
- Choosing a short/custom room name (the header lets you type one) makes the room
  guessable — only do that for non-sensitive use.
- The **`/admin#<room>` dashboard** is under the same credential model: it addresses
  the room by the same URL hash, so anyone with the link can also open it. It is
  **read-only** — it adds no Apply/Reject controls and no new write path (its only
  mutations are team-guidance edits) — but it does surface the room's full history,
  queue, onboarding, and migration state in one view. Its editable guidance and
  docs-index controls do not write Cloudflare account configuration. Treat the
  `/admin` link with the same care as the room link.

**Implication:** share room links only with people you trust to apply changes to
your Cloudflare account. If you need stronger isolation, put the Worker behind
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/).

## Defense-in-depth around Apply

- **Pre-mutation zone snapshot.** Before applying an action that targets a zone,
  `applyAction` captures a best-effort snapshot of key zone settings + rulesets
  (`snapshotZone()`, `src/cf-api.ts:252`) into the `glide_snapshots` table as a
  rollback breadcrumb. Snapshots are advisory and never block an apply.
- **Ruleset entrypoint merge.** Phase-replacing `PUT`s re-read the phase's current
  rules at apply time and append the queued rules (`mergeEntrypointRules()`,
  `src/server.ts:2594`), so applying never silently drops rules added by anyone
  after the action was queued. If that safety read fails, Apply refuses the write
  and retains the action; it never replaces the phase from an empty baseline.
- **Apply lifecycle and resource fencing.** The server marks an action `applying`
  before external I/O, rejects duplicate Apply calls, and serializes actions that
  target the same phase-replacing ruleset resource. A watchdog converts an
  interrupted attempt into an uncertain result that requires verification.
- **No blind write retries.** `cfRequest()` does not automatically retry
  non-idempotent writes. Network and 5xx failures may have reached Cloudflare, so
  the UI requires explicit confirmation before retrying an uncertain outcome.
- **Server-owned synced state.** `validateStateChange()` rejects direct browser
  state writes. Clients can propose/apply changes only through the callable RPCs;
  `applyAction` also runtime-validates persisted action method/path fields.
- **Attribution.** Every queued action and every result records who triggered it
  (`createdBy` / `by`), resolved from the request body or message metadata
  (`resolveActor()`, `src/server.ts:1773`).
- **Friendly permission errors.** A failed write returns the exact token
  permission to add (`permissionHint()`, `src/cf-api.ts:59`), so operators grant
  least privilege rather than over-scoping.
- **Visible, retryable failures.** Failed actions remain in Pending approvals with
  their error. A durable scheduled chat event informs Glide of Apply/Reject
  outcomes, so the conversation does not keep waiting on a completed decision.

## Migration previews never write

The migration-tool client (`src/migration.ts`) only ever calls **read-only**
endpoints and deliberately **never** calls `/api/migrations/start` (which would
deploy directly to Cloudflare). Translating a provider config is pure parsing on
the tool's side; every real change still flows through Glide's queue → Apply.

Using the `MIGRATION` **service binding** (rather than `MIGRATION_API_URL`) keeps
that traffic inside the Cloudflare runtime, so it works even when the migration
tool's public hostname is protected by Cloudflare Access — no public request, no
Access challenge.

## The Cloudflare-docs RAG only reads public docs

The Cloudflare-docs indexer (`src/docs-scraper.ts`) fetches the **public**
developer documentation, embeds it, and writes vectors to a **shared** Vectorize
namespace (`__cfdocs__`). It contains no account data, no tokens, and nothing
room-specific — reindexing and retrieval never touch your Cloudflare account. The
job is admin-triggered (or the weekly cron) and, like everything else, cannot make
a change to your account: it has no write path to the Cloudflare API.

## Snapshot restores are human-only

`restoreSnapshot` reverts a zone to a captured snapshot, **removing changes made
since**. It is never an LLM tool and never automated: the UI requires an explicit
`window.confirm` (`src/client/main.tsx:1024`) before calling the RPC. The outcome
is recorded in `recentResults`.

## Input-size & resource limits

These limits bound resource use and protect the model's context window:

| Limit | Value | Source |
| --- | --- | --- |
| Tool-steps per chat turn | 8 | `stepCountIs(8)`, `src/server.ts:1635` |
| Read payload echoed to the model | ~6 000 chars | `MAX_READ_CHARS`, `src/server.ts:109` |
| Synced action-result history | 25 | `MAX_RECENT_RESULTS`, `src/server.ts:107` |
| Migration-plan rules in synced state | 300 | `MAX_PLAN_RULES`, `src/server.ts:113` |
| URL-fetched config size | 2 000 000 bytes | `MAX_CONFIG_BYTES`, `src/migration.ts:21` |
| API GET retries / write retries | 3 / 0 | `cfRequest`, `src/cf-api.ts` |
| `cfGetAll` page cap | 50 pages × 50 | `src/cf-api.ts:190` |

## Threat-model summary

| Concern | Mitigation | Residual risk |
| --- | --- | --- |
| LLM makes an unwanted change | Writes only queue; a human must Apply | A human can Apply a bad proposal — review the diff/body on the action card. |
| Token theft from storage | AES-256-GCM at rest, key in a Worker secret; never synced/logged/returned | Anyone with both the DO storage **and** `GLIDE_TOKEN_KEY` could decrypt. |
| Token pasted into chat | Client blocks recognizable `cfat_...` values; server redacts new and historical persisted text | Other secret formats or obfuscation can bypass pattern matching; revoke any exposed credential. |
| Sensitive text exposed through diagnostics | Structured chat events omit message text and token values | Platform-generated exception metadata may still need normal operator access controls and retention review. |
| Unauthorized room access | 128-bit unguessable default room id | The link is the credential; sharing it grants Apply rights. Use custom names only for non-sensitive rooms, or front with Access. |
| Dropping existing ruleset rules on Apply | Re-read + merge at apply time; pre-apply snapshot | Concurrent changes after the final read remain possible; review the result and snapshot. If the safety read fails, Glide refuses the write. |
| A message appears sent during a disconnect | Send-time socket validation and server-authoritative transcript check | Delivery can be temporarily unconfirmed while both WebSocket and verification fetch are unavailable; wait for **live** before retrying. |
| Migration tool causing writes | Only read-only endpoints are called; `/api/migrations/start` is never used | Trust boundary is the migration tool you connect. |
| Destructive restore | Human-only, explicit confirm; never an LLM tool | A human can still confirm a destructive restore. |

## Operator recommendations

- Set `GLIDE_TOKEN_KEY` to a strong random value (`openssl rand -base64 32`) so
  GUI tokens are encrypted; rotate it by re-entering tokens if needed.
- Scope the Cloudflare API token to **only** the permissions the team needs (see
  the table in [Setup](./setup.md#cloudflare-api-token-permissions)).
- Enter tokens only in the Connection form. If one is exposed in chat or anywhere
  else, revoke and rotate it; redaction does not make the old value safe again.
- Keep default (random) room ids for any room with a real token; share links only
  with trusted teammates.
- Consider fronting the Worker with Cloudflare Access for an extra auth layer.
- Capture a zone snapshot before a large migration Apply, and use
  `migration_diff_report` first to see what already exists.
- Restrict Workers Observability access and use the structured `glideEvent` fields
  for incident analysis instead of adding ad hoc message-body logging. See
  [Troubleshooting & observability](./troubleshooting.md).

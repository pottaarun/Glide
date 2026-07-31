# Security model

Glide drives a powerful API on behalf of a whole room of people, so its security
properties matter. This page documents the guarantees, how they're implemented,
and the threat model's sharp edges.

## The core guarantee: reads run, writes wait

> **The LLM can only _queue_ changes. An LLM-proposed Cloudflare write reaches
> the API only through the server approval path after a human reviews it and
> clicks Apply.**

- Every "write" tool (`add_domain`, `create_dns_record`, `set_zone_setting`,
  `create_waf_custom_rule`, `cf_write`, `queue_migration_rules`) calls
  `queuePending()` (`src/server.ts`), which only appends a `PendingAction`
  to synced state. None of them touch Cloudflare.
- `applyAction()` and its private `applyActionInternal()` are the **only** paths
  that execute an LLM-queued `PendingAction` with
  `cfRequest(action.method, action.path, …)`. `applyAll()` delegates to the same
  internal path for an exact reviewed ID set; it is not a second write mechanism.
- Automated migration validation and zone snapshot capture/list/restore/rollback
  are disabled fail-closed. They have no LLM tools or UI controls; compatibility
  RPCs return disabled errors, and legacy restore approvals are rejected.
- The system prompt reinforces this (`src/system-prompt.ts`): the model is
  instructed never to claim a change is "done/live/created" until it's applied.

This is what makes Glide safe to use collaboratively: the LLM proposes, humans
dispose.

## Tokens are encrypted at rest

GUI-provided Cloudflare API tokens are sealed with **AES-256-GCM** before being
written to the Durable Object's SQLite (`glide_secrets` table). The key is
**derived from the Worker-held `GLIDE_TOKEN_KEY` secret via HKDF-SHA-256**, so the
ciphertext in the DO is useless without that Worker secret.

Implementation (`src/server.ts`):

- `deriveAesKey()` — HKDF-SHA-256 with fixed salt `glide:token:salt:v1` and info
  `glide:token:aes-gcm:v1`, producing a 256-bit AES-GCM key.
- `encryptSecret()` — random 12-byte IV; stored as `base64(iv):base64(ciphertext)`.
- `decryptSecret()` — reverses it; on failure (corrupt/rotated key) Glide fails
  closed, logs only a structured failure classification, and requires re-entry.

Properties:

- The plaintext token is **never synced to clients, never logged, never returned**.
- Only non-sensitive status is exposed in `GlideState`: `tokenConfigured`,
  `tokenLast4` (last 4 chars), and `tokenValid` (last authentication check).
- Without `GLIDE_TOKEN_KEY`, **GUI token storage is disabled** —
  `setCloudflareToken` refuses and tells the operator to set the key
  (`src/server.ts`).
- A room can use only the token encrypted in that room's Durable Object. Glide has
  no deployment-wide Cloudflare API token fallback, so one room cannot inherit an
  operator credential by choosing or guessing another room name.
- `setCloudflareToken` first tries `/user/tokens/verify`, then authenticated
  `/accounts` and `/zones` reads. The fallback matters because the verify endpoint
  is user-scoped and can reject a valid account-scoped token. It stores the token
  regardless so a transient check cannot lock out an otherwise-usable credential.
- A reconnecting client calls `reverifyToken` once when a stored token is marked
  unverified, allowing old false negatives to self-correct without re-entry.

> **Token resolution** (`getToken()`, `src/server.ts`): decrypt this room's stored
> token or return no token. Missing/rotated keys and corrupt ciphertext never fall
> through to another credential.

## Tokens are kept out of chat and logs

The connection form is the only supported place for a room member to enter a
Cloudflare API token. The normal chat path has three layers of protection:

- Before sending, the client rejects recognizable `cfat_...`, `cfut_...`, and
  `cfk_...` tokens and directs the user to **Connection → Set token** or
  **Connection → Change**.
- `sanitizeMessageForPersistence()` replaces matching values with
  `[Cloudflare API token redacted]` before any text part is stored.
- When a room wakes, `onStart()` applies the same sanitizer to historical messages
  created before this guard existed and persists the cleaned transcript.
- Before the chat SDK can hydrate a pre-upgrade transcript, Glide swaps it into a
  server-only quarantine and redacts it in bounded batches. Reads and chat writes
  remain locked until sanitization and the durable completion marker both succeed.

Structured `glideEvent` logs contain identifiers, counts, stages, and outcomes,
not chat text or token values. `reportClientChatIssue` similarly accepts only a
delivery classification, message id, and connection epoch.

The recognizer is defense in depth, not a credential-revocation mechanism. A
different secret format or an obfuscated value can bypass it. If any secret is
pasted into chat, browser logs, an issue, or another unintended location, revoke
and rotate it even if Glide later displays a redacted transcript.

## Verified identity and room membership

Production Glide requires a Cloudflare Access application over the complete
hostname. The Worker does not trust edge placement alone: `src/access-auth.ts`
validates the `Cf-Access-Jwt-Assertion` signature against the team's remote JWKS
and requires the configured issuer, application audience, RS256 algorithm,
`type: "app"`, canonical email, non-empty subject, and current expiry. A service
token has no user email and an empty subject, so it cannot become a room member.

The Worker removes the browser's ability to assert its own identity by overwriting
`X-Glide-Access-Email`, `X-Glide-Access-Subject`, and
`X-Glide-Access-Expiry` only after JWT verification. Missing production
configuration fails closed with `503`; missing or invalid assertions return
`401`/`403` before Agent routing. `/api/session` returns only the verified canonical
email and employee classification.

The config-derived `jose` resolver is reused for the configured issuer so its
remote JWKS and rotation cooldown are cached across requests in an isolate. A key
endpoint timeout, network/HTTP failure, or malformed key set fails closed as
no-store `503 access_keys_unavailable` with `Retry-After: 10` and logs only
`access.jwks_unavailable`. An unknown key id or otherwise invalid token remains a
`403`, preventing an attacker-selected `kid` from masquerading as an outage.

Authorization is a server-only SQLite ACL in each room's Durable Object:

- `glide_room_members` stores canonical email, `owner | member | viewer` role,
  inviter, and join time. It is not synced through `GlideState` and is capped at 100
  entries. The `role` column is CHECK-constrained; a one-time migration rebuilds the
  pre-viewer table on first load after upgrade.
- Only a same-origin `POST /api/room-access` may activate membership. An exact
  `@cloudflare.com` email may create a canonical empty room or become owner of an
  existing unclaimed legacy room. Agent GET/WebSocket routing is read-only and
  cannot create or claim. The admin and unexpected-close checks send
  `intent=inspect`, which calls read-only authorization and cannot insert an owner.
- The URL hash is a display id. The activation endpoint and both Agent clients map
  it through the same PartySocket-compatible resolver before lookup; serialized
  storage names are limited to 1,024 bytes. This keeps legacy links on their
  original object and prevents authorization/client name drift.
- Legacy invitations are copied to the server-only `glide_room_invites` audit, not
  to `glide_room_members`; each guest must be re-invited. New ACL grants and audit
  records commit atomically, and the synced invite list is a repairable projection.
- Any current member can grant another canonical email membership. The browser's
  prefilled email is only delivery convenience; the durable ACL grant is what
  authorizes the recipient after Access verifies that exact email. Grants require
  the explicit Invite-panel RPC; the model has no membership mutation tool.
- **Roles are least-privilege.** A `viewer` may read, chat, and *propose* (queue)
  changes, but every commit path — apply / apply-all / reject, invite, remove,
  token set/clear, rename, role change, delete — is gated by `requireCommitRole()`
  and refused for viewers (the client also hides those controls). A `member` keeps
  those commit rights and may invite other members; only an `owner` may grant the
  `viewer` role, change a member's role (`setMemberRole`, member↔viewer; the owner
  is immutable), or delete the room. The gate keys off the **live connection
  identity's** stored role, never the untrusted `by` label.
- Every governance-relevant action is recorded in an append-only `glide_room_audit`
  table (who queued/applied/rejected/invited/changed roles or settings/inspected).
  The trail is **never synced** in `GlideState`; the `getAuditLog()` RPC is
  owner-gated and exportable to CSV/JSON from `/admin`.
- Only the owner can remove a non-owner. Revocation atomically removes the ACL and
  invitation audit row, then closes every matching socket with `1008` and reason
  `Room membership revoked`.
- Only the owner can **delete** a room. `destroyRoom` resolves the live connection
  identity (not the untrusted `by` label), requires that identity's role to be
  `owner`, and requires the exact `DELETE THIS ROOM` phrase before it deregisters
  the room and calls `storage.deleteAll()`, wiping members, transcript, queue,
  memory, business profile, invites, and the encrypted token. Naming a room
  (`setRoomName`) is any-member and display-only; it never affects routing,
  storage identity, or the ACL.
- A nonemployee cannot create or claim a room. A second employee does not gain
  *membership* merely because they are an employee; an existing member must invite
  them. A verified employee may, however, **inspect** any existing room read-only
  via `POST /api/room-inspect` → the DO's `inspectRoom()`, which is deliberately
  **separate from** the members-only socket/activation gate: it returns an audited,
  read-only snapshot (state + transcript + audit) and never a connection, so
  inspection carries **zero mutation surface** (writes still require membership at
  the RPC layer). Each inspection is itself written to the audit trail, and a
  never-activated room is reported non-existent rather than materialized.
- The Worker requires an exact same-origin `Origin` for Agent WebSocket upgrades
  and checks membership in `routeAgentRequest()` hooks before routing.
  `shouldSendProtocolMessages()` suppresses initial SDK state/identity frames for
  an unadmitted connection. `GlideAgent` repeats origin, membership, and expiry
  checks on HTTP/connection admission, after asynchronous connection-key
  derivation and expiry-schedule creation, and both before and after each
  WebSocket frame's limiter await.
- Privileged RPCs that await external I/O retain a connection-bound authorization
  lease containing a server-generated socket-session nonce, so a reconnect that
  reuses the same SDK connection id cannot inherit in-flight authority. Apply/bulk
  Apply recheck it after credential and ruleset reads and immediately before a
  Cloudflare write; token replacement, clearing, reverification, and destructive
  legacy-archive recovery recheck before changing durable state. Migration preview,
  preflight, diff, Terraform, and CSV operations recheck before retaining a source,
  plan, check, or export. Active chat turns and response retries register the same
  exact lease for cancellation; tools recheck it after awaited reads and before
  room mutation, and retry cancellation reaches `saveMessages()`. Revocation,
  expiry, or socket replacement/loss therefore aborts remaining model work and
  suppresses later state/output rather than transferring authority to a reconnect.
- Glide does not use Agent facets. `onBeforeSubAgent()` returns a non-cacheable
  `404`, so authenticated users cannot create persistent objects through `/sub/`
  routes.
- `onConnect()` creates a durable per-connection schedule at the JWT expiry, which
  wakes a hibernated room and proactively closes idle expired/revoked sockets with
  `1008`. Close cancels the schedule; schedule creation failure closes with `1011`.
  Hibernation state stores only canonical email, expiry/schedule metadata, and
  SHA-256 subject/client digests, never the raw Access subject.
- Constructor-only storage created while probing a previously absent room is
  marked provisional. Denial queues idempotent destruction; bounded schedule
  retries end by arming a native alarm so destruction still runs in a fresh
  invocation. The final serialized check preserves any room that gained a member
  or durable data, then one atomic `deleteAll()` clears provisional storage before
  the isolate aborts. No durable condemned marker can outlive an interrupted
  cleanup and erase a later activation. Owner creation removes the marker
  atomically. A stable attempt id makes the Worker's one cleanup-reset retry replay
  the original `created`/`claimed` result instead of misreporting it as `member`.

The URL hash identifies a room display id; after bounded path serialization it is
not an authorization credential. New ids match `^[A-Za-z0-9_-]{1,128}$`, reserve
`__system__`, and default to a 32-character hyphenless UUIDv4. Shipped non-control
ids up to 200 characters remain lookup-only for legacy claims when their serialized
storage name fits 1,024 bytes. Random defaults still reduce accidental discovery
and should not be posted publicly, but possessing one grants no data or Apply access.
`/admin#<room>` uses the same Access and membership checks as the chat room. Any
admitted member can use room controls, including Apply and invitations, so invite
only people trusted to operate that room's Cloudflare credential. Opening admin
itself uses inspect-only authorization and cannot create or claim a room.

The deployment-wide **room registry** (`GET /api/rooms`, backed by the fixed
`__registry__` Durable Object) powers the admin **All rooms** list. It is
`GET`-only, same-origin, and restricted to verified Cloudflare employees; it is a
convenience index that rooms self-report into, **not** an authorization boundary.
Listing a room reveals only its id, optional display name, owner, member count, and
timestamps — never its transcript, token, or state — and opening any listed room
still enforces that room's server-only membership ACL. Both reserved system
instances (`__system__` and `__registry__`) are rejected by browser HTTP/WebSocket
Agent routes.

Worker-served HTML adds `Content-Security-Policy: frame-ancestors 'none'` and
`X-Frame-Options: DENY` to prevent clickjacking of authenticated controls.

Local Wrangler has no Access edge. `GLIDE_DEV_ACCESS_EMAIL` is therefore an
explicit development seam accepted only for loopback request URLs. It is ignored
on deployed hostnames and must never be treated as a production Access substitute.
Because the URL hostname does not authenticate the network peer, keep Wrangler
bound to loopback and never publish or reverse-proxy a server using this bypass.

## Authenticated-traffic abuse controls

Authentication and membership are complemented by two
[Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
bindings:

- `AGENT_RATE_LIMITER` allows 120 dynamic HTTP attempts per 60 seconds per opaque
  client-network key. The check runs before JWT verification to bound invalid-token
  and JWKS work. Every inbound WebSocket frame then uses a separate
  120-per-60-second bucket derived from the verified Access subject before the
  Agents SDK can dispatch state, RPC, or chat protocol work. Membership is checked
  again after that binding await, so revocation cannot race into dispatch.
- `CHAT_RATE_LIMITER` allows 20 validated chat submissions per 60 seconds per
  verified identity and 20 per 60 seconds per room. The identity check happens
  first, so an identity already over limit cannot consume the room bucket. Response
  retries and guidance add/delete/reindex RPCs use the same strict budget.
- `clientRateLimitKey()` hashes only Cloudflare's authoritative
  `CF-Connecting-IP` header for HTTP admission; it never trusts caller-supplied
  `X-Forwarded-For`. After authentication, the Worker replaces the internal client
  key with a digest of the signed Access subject. `opaqueRateLimitKey()` separately
  hashes room names. No raw IP, subject, room name, or rate-limit digest is logged;
  structured room events use the opaque Durable Object id as their correlation key.
- Hashed JS/CSS and non-root asset requests are excluded; the authenticated root
  document consumes the HTTP bucket. A binding failure gets a non-cacheable
  HTTP `503` with `Retry-After: 10`, closes an active socket with `1013`, or returns
  a bounded unavailable error. Exhaustion gets HTTP `429` with `Retry-After: 60`,
  socket close `1013`, or a bounded chat/RPC response before mutation.
- Binary protocol messages close with `1003`; byte-oversized messages close with
  `1009`. Both are rejected before limiter I/O. A
  per-room in-flight byte budget bounds the combined frames retained by handlers
  waiting on asynchronous admission. Successful private transcript responses are
  `private, no-store` as well as being fetched with the browser's no-store mode.

Cloudflare documents these counters as permissive, eventually consistent, and
local to the Cloudflare location running the call. A burst can briefly exceed the
nominal threshold, distributed locations have independent counters, and the
pre-auth network bucket can group users behind one NAT. Input-size guards, the
identity and room budgets, Durable Object serialization, and Apply approval fences
remain defense in depth; Access plus the durable ACL is the authorization system.

## Defense-in-depth around Apply

- **Review before controls.** Each approval card presents the method, product,
  summary, path, request body, and any prior error before Apply/Reject. The user
  reviews the actual queued request rather than approving a model sentence alone.
- **No implicit rollback snapshot.** `applyAction` does not capture a local
  pre-mutation snapshot. On room startup, `onStart()` drops the legacy
  `glide_snapshots` table because those incomplete breadcrumbs had no safe restore
  consumer.
- **Ruleset entrypoint merge.** Phase-replacing `PUT`s re-read the phase's current
  rules at apply time and append the queued rules (`mergeEntrypointRules()`,
  `src/server.ts`), so applying never silently drops rules added by anyone
  after the action was queued. If that safety read fails, Apply refuses the write
  and retains the action; it never replaces the phase from an empty baseline.
- **Apply lifecycle and resource fencing.** The server marks an action `applying`
  before external I/O and rejects duplicate Apply calls. `PUT`, `PATCH`, and
  `DELETE` requests to the same canonical path share a lock even when their
  methods differ; ruleset entrypoints use a zone/phase key, and zone creation uses
  an account/domain key. A watchdog converts an interrupted attempt into an
  uncertain result that requires verification.
- **Authorization survives awaits.** Each browser Apply captures the verified
  connection id, server-generated socket-session nonce, email, and Access expiry.
  The server rechecks that exact live socket session, JWT expiry, and durable
  membership after asynchronous setup/safety reads and immediately before
  dispatching the Cloudflare write. Access loss or same-id socket replacement marks
  the approval failed without sending the write or scheduling an AI follow-up;
  bulk Apply stops before the next item.
- **No blind write retries.** `cfRequest()` does not automatically retry
  non-idempotent writes. Network and 5xx failures may have reached Cloudflare, so
  the UI requires explicit confirmation before retrying an uncertain outcome,
  and the server rejects that individual retry unless the confirmation flag is
  present.
- **Bulk approval is an immutable reviewed snapshot.** The client confirms and
  sends the exact visible action IDs. The server applies only their intersection
  with the current safe queue, so newly queued work is never swept in. Applying,
  stale-interrupted, and uncertain actions are excluded from bulk apply.
- **Zone creation is deduplicated and specialized.** `add_domain` performs an
  exact account-filtered existence check and central queue deduplication by
  account plus normalized domain. `cf_write` refuses `POST /zones`, so a model
  cannot bypass these checks with the generic builder.
- **Server-owned synced state.** `validateStateChange()` rejects direct browser
  state writes. Clients can propose/apply changes only through the callable RPCs;
  `applyAction` also runtime-validates persisted action method/path fields.
- **Attribution.** Every queued action and every result records who triggered it
  (`createdBy` / `by`). Browser actions use the verified connection email;
  request-body/message metadata is only a bounded fallback for internal or
  server-driven calls (`resolveActor()`, `src/server.ts`).
- **Friendly permission errors.** A failed call suggests the likely method-aware
  token permission group (`permissionHint()`, `src/cf-api.ts`) for operators to
  verify and scope narrowly. New-zone creation specifically
  requires Zone > Zone > Edit over All zones/domains; Account API Tokens need a
  separate zone/domain-scoped policy rather than an Entire Account policy.
- **Visible, retryable failures.** Failed actions remain in Pending approvals with
  their error. A durable scheduled chat event informs Glide of Apply/Reject
  outcomes, so the conversation does not keep waiting on a completed decision.

## Migration previews never write

The migration-tool client (`src/migration.ts`) only ever calls **read-only**
endpoints and deliberately **never** calls `/api/migrations/start` (which would
deploy directly to Cloudflare). Translating a provider config is pure parsing on
the tool's side; every real change still flows through Glide's queue → Apply.

The initiating browser or chat socket retains its exact authorization lease across
migration-service and Cloudflare-read awaits. If membership, Access expiry, or that
socket session changes, returned preview/check/export data is discarded before the
room saves a source, plan, check, Terraform artifact, CSV artifact, or onboarding
completion.

Using the `MIGRATION` **service binding** (rather than `MIGRATION_API_URL`) keeps
that traffic inside the Cloudflare runtime, so it works even when the migration
tool's public hostname is protected by Cloudflare Access — no public request, no
Access challenge.

Automated post-migration validation is disabled because the migration service
does not compare complete live rule and setting values. Snapshot capture, listing,
restore, and rollback are disabled because complete, fail-safe recovery cannot be
guaranteed. The server exposes neither capability to the model or UI and returns
explicit errors from compatibility RPCs.

## The Cloudflare-docs RAG only reads public docs

The Cloudflare-docs indexer (`src/docs-scraper.ts`) fetches the **public**
developer documentation, embeds it, and writes vectors to a **shared** Vectorize
namespace (`__cfdocs_v2__`). It contains no account data, no tokens, and nothing
room-specific — reindexing and retrieval never touch your Cloudflare account. The
job is owned by one fixed `__system__` Durable Object and triggered only by the
weekly cron or first-load bootstrap. Worker routing returns `404` before HTTP or
WebSocket requests can wake that reserved instance, and coordinator methods reject
ordinary room names. A durable queue-ready marker and startup reconciliation
prevent interrupted jobs from remaining active or treating a partial manifest as
canonical. Successful pages replace deterministic vectors in place; removed pages
are deleted only after complete product enumeration. The job has no write path to
your Cloudflare account.

## Disabled migration validation and recovery paths

There is no current snapshot or automated validation workflow. `runValidate`,
`snapshotZone`, `refreshSnapshots`, and `restoreSnapshot` are compatibility stubs
that always return `{ ok: false }`. The UI has no controls for them, the LLM has no
corresponding tools, and legacy `/api/restore` or `/api/rollback` approvals are
recognized and refused by Apply. Operators must verify the reviewed live
configuration directly and use an external backup/change-management process when
rollback protection is required.

## Input-size & resource limits

These limits bound resource use and protect the model's context window:

| Limit | Value | Source |
| --- | --- | --- |
| Tool-steps per chat turn | 8 | `stepCountIs(8)`, `src/server.ts` |
| Dynamic HTTP attempts per client network | 120 per 60 seconds | `AGENT_RATE_LIMITER`, `wrangler.jsonc` |
| Inbound WebSocket frames per Access identity | 120 per 60 seconds | `AGENT_RATE_LIMITER`, `src/server.ts` |
| Chat submissions/expensive RPCs per Access identity and per room | 20 per 60 seconds for each bucket | `CHAT_RATE_LIMITER`, `src/server.ts` |
| Room members | 100 | `MAX_ROOM_MEMBERS`, `src/server.ts` |
| Room display name | 60 chars | `MAX_ROOM_NAME_CHARS`, `src/shared.ts` |
| Rooms returned by `GET /api/rooms` | 1 000, most-recently-active first | `listRoomRegistry()`, `src/server.ts` |
| Session/room-access request | 128 000 response bytes; 15-second deadline | `MAX_ACCESS_RESPONSE_BYTES`, `ACCESS_REQUEST_TIMEOUT_MS`, `src/client/main.tsx` |
| Read payload echoed to the model | ~6 000 chars | `MAX_READ_CHARS`, `src/server.ts` |
| Synced action-result history | 25 | `MAX_RECENT_RESULTS`, `src/server.ts` |
| Migration-plan rules in synced state | 300 | `MAX_PLAN_RULES`, `src/server.ts` |
| Inline or uploaded config size | 850 000 UTF-8 bytes total | `MAX_CONFIG_BYTES`, `src/migration.ts` |
| Uploaded config file count | 50 | `MAX_CONFIG_FILES`, `src/migration.ts` |
| API GET retries / write retries | 3 / 0 | `cfRequest`, `src/cf-api.ts` |
| `cfGetAll` page cap | 50 pages × 50 | `src/cf-api.ts` |

## Threat-model summary

| Concern | Mitigation | Residual risk |
| --- | --- | --- |
| LLM makes an unwanted change | Writes only queue; a human must Apply | A human can Apply a bad proposal — review the diff/body on the action card. |
| Queue changes during bulk review | Client sends exact reviewed IDs; server intersects them with the current safe queue | A reviewed action can still become invalid before Cloudflare receives it; API errors remain visible and retryable. |
| Lost or malformed write response causes a duplicate retry | No automatic write retry; network, 5xx, and malformed 2xx write outcomes are uncertain, excluded from bulk, and require explicit individual confirmation | The operator must inspect live state correctly before confirming Retry anyway. |
| Duplicate zone proposal | Exact existing-zone lookup, central account/domain queue dedupe, and `cf_write` block for `POST /zones` | A token without read access cannot prove whether a zone exists; use correct Zone Read scope before queueing. |
| Token theft from storage | AES-256-GCM at rest, key in a Worker secret; never synced/logged/returned | Anyone with both the DO storage **and** `GLIDE_TOKEN_KEY` could decrypt. |
| Token pasted into chat | Client blocks recognizable `cfat_...`, `cfut_...`, and `cfk_...` values; server redacts new and historical persisted text | Other secret formats or obfuscation can bypass pattern matching; revoke any exposed credential. |
| Old transcript cannot be redacted because its room token cannot decrypt | Recovery is exposed only to authenticated room members from a durable decryption-failed state, requires an exact typed confirmation, rechecks the exact socket-session lease after token decryption and before arming deletion, deletes in bounded batches, and preserves permanent message-id tombstones | The unrecoverable legacy transcript is permanently deleted; admitted members must still understand the consequence. |
| Sensitive text exposed through diagnostics | Structured chat events omit message text and token values | Platform-generated exception metadata may still need normal operator access controls and retention review. |
| Forged or stale identity | RS256 Access JWT verification with issuer/audience/type/email/subject/expiry checks; trusted headers are overwritten | Access policy and identity-provider security remain external dependencies. |
| Cross-site Agent control or clickjacking | Exact-origin WebSocket/activation checks, pre-connect protocol suppression, CSP `frame-ancestors 'none'`, and `X-Frame-Options: DENY` | A compromised allowed origin or browser remains within the trusted application boundary. |
| Unauthorized room access | Server-only durable email ACL checked before routing and on every frame; URL possession alone is insufficient | Every admitted member can operate the room and its stored token; invite carefully. |
| Revocation or same-id reconnect races an active chat, retry, or privileged RPC | Connection-bound authorization leases include a socket-session nonce; active model/retry work is aborted, chat tools recheck after awaits, and Apply/token/archive/migration paths recheck before writes or retained state | A Cloudflare write already dispatched before revocation cannot be recalled; its outcome is still recorded. A read-only upstream request may finish, but its result is discarded. |
| Authenticated users create Agent facets | `onBeforeSubAgent()` rejects every `/sub/` route with `404` | Revisit this deny-all hook before intentionally adopting sub-agents. |
| Admin inspection creates or claims a room | `inspectRoom()` (behind `POST /api/room-inspect`) is separate from the members-only activation gate, never inserts an owner, and reports a never-activated room as non-existent (queuing provisional cleanup); the transient-close recheck uses read-only `intent=inspect` | A Cloudflare employee using the normal chat activation flow can still intentionally create or claim. |
| Non-member employee inspection mutates a room | Inspection returns a read-only snapshot and never opens a socket; every write RPC independently requires membership via `requireCommitRole()`/the connection lease, so there is no mutation surface even if the snapshot path were abused | A verified employee can *read* any room's state, transcript, and audit; scope employee trust accordingly. Each inspection is itself audited. |
| Viewer escalates to a write | Every commit path is gated by `requireCommitRole()` on the live connection role; only an owner can change roles or grant `viewer`, and the owner is immutable | A compromised owner account can still change roles; protect owner identities. |
| Audit trail tampering or leakage | Append-only `glide_room_audit`, never synced in `GlideState`, self-pruning at 5,000 rows; `getAuditLog()` is owner-gated (or delivered inside an audited employee snapshot) | An owner or inspecting employee can read the trail; there is no in-app edit/delete, but storage-level access remains an operator concern. |
| Legacy-room takeover | Only a verified Cloudflare employee may perform the one-time atomic claim | The first employee who knows an unclaimed legacy room id becomes owner; migrate sensitive legacy rooms promptly. |
| Accidental or malicious room deletion | `destroyRoom` requires the live owner identity **and** the exact `DELETE THIS ROOM` phrase; the untrusted `by` label is never used | Deletion is intentional and irreversible — a legitimate owner can still delete a room; there is no built-in restore. |
| Room registry leaks room contents | `GET /api/rooms` is employee-only and returns only id/name/owner/counts/timestamps; it is not an authorization boundary and each room is still membership-gated | A verified employee can enumerate room ids and names, but cannot read a room's data without being a member. |
| Authenticated probing reserves arbitrary room storage | Previously absent storage stays provisional and denied probes trigger idempotent cleanup with bounded scheduling retries and a final serialized state recheck | Cleanup is asynchronous; transient storage can exist until the scheduled or fallback attempt completes. |
| Cleanup races first-owner activation | Owner insertion atomically clears the provisional marker; cleanup rechecks marker, members, and durable data under `blockConcurrencyWhile()`; activation retries once with a replay id | A persistent platform failure can still make the activation request fail, but cannot intentionally destroy an activated room through this cleanup path. |
| Client floods Agent/RPC/AI paths | Layered network request, identity protocol, per-identity chat/RPC, and per-room chat binding checks; rejected work does not mutate state | Counters are permissive and location-local; NATs can affect HTTP admission and rotating IPs/locations can raise the effective ceiling. |
| Dropping existing ruleset rules on Apply | Re-read + merge at apply time; refuse the write if the safety read fails | Concurrent changes after the final read remain possible; review the live result directly. |
| A message appears sent during a disconnect | Send-time socket validation and server-authoritative transcript check | Delivery can be temporarily unconfirmed while both WebSocket and verification fetch are unavailable; wait for **live** before retrying. |
| Migration tool causing writes | Enabled operations are read-only/export only; `/api/migrations/start` is never used, and snapshot/restore/rollback paths fail closed | Trust boundary is the migration service you configure. |
| False confidence from incomplete migration validation | Automated validation is disabled; operators verify the reviewed live values directly | Verification is manual and must cover the intended rules and settings. |
| Incomplete snapshot restore | Snapshot capture/list/restore/rollback have no tools or UI; compatibility paths fail closed and legacy approvals are refused | Glide provides no automated rollback; use an external recovery process. |

## Operator recommendations

- Set `GLIDE_TOKEN_KEY` to a strong random value (`openssl rand -base64 32`) so
  GUI tokens are encrypted; rotate it by re-entering tokens if needed.
- Protect the complete production hostname with Access, set the exact
  `TEAM_DOMAIN` and `POLICY_AUD`, and verify `/api/session` before inviting users.
  Never configure `GLIDE_DEV_ACCESS_EMAIL` as a production auth substitute.
- Scope the Cloudflare API token to **only** the permissions the team needs (see
  the table in [Setup](./setup.md#cloudflare-api-token-permissions)).
- For new-zone creation, use the documented All zones/domains resource policy;
  do not broaden unrelated account permissions to solve a `POST /zones` failure.
- Enter tokens only in the Connection form. If one is exposed in chat or anywhere
  else, revoke and rotate it; redaction does not make the old value safe again.
- Keep default random room ids and grant membership only to people trusted to
  inspect, change, and invite within that room. URL secrecy is defense in depth,
  not the authorization boundary.
- Keep the rate-limit namespace IDs unique within the Cloudflare account, monitor
  `rate_limit.exceeded` / `rate_limit.unavailable`, and tune thresholds only from
  observed legitimate traffic. Do not log keys or raw client IPs while debugging.
- Before a large migration Apply, use `migration_diff_report`, arrange any needed
  external backup/rollback process, and verify the reviewed live configuration
  directly afterward.
- Restrict Workers Observability access and use the structured `glideEvent` fields
  for incident analysis instead of adding ad hoc message-body logging. See
  [Troubleshooting & observability](./troubleshooting.md).

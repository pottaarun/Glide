# Tools & RPC reference

Glide exposes two distinct surfaces:

1. **LLM tools** — what the chat model can call during a turn (`buildTools()`,
   `src/server.ts`). **READ** tools execute against Cloudflare immediately;
   **QUEUE** tools only append a `PendingAction` for human approval.
2. **`@callable` RPCs** — active methods the React client invokes over the
   WebSocket (token management, approvals, the onboarding wizard,
   business-profile capture and recommendation queueing, migration checks/exports,
   delivery diagnostics, and room-scoped guidance controls), plus fail-closed
   compatibility stubs documented separately.

A turn runs **at most 8 tool-steps** (`stepCountIs(8)`), and read payloads echoed
to the model are clipped to ~6 KB. See [Architecture](./architecture.md#the-chat-turn-lifecycle).

---

## LLM tools

### Read / discovery — run immediately

| Tool | Input | Behaviour |
| --- | --- | --- |
| `list_accounts` | — | List Cloudflare accounts the token can see. |
| `list_zones` | `accountId?` | List zones, optionally filtered to one account. |
| `find_zone` | `name` | Resolve a zone id by domain name and **save it as the room's default zone**. |
| `list_dns_records` | `zoneId`, `type?` | List DNS records for a zone (optionally by record type). During an active onboarding it also sets `dnsReviewed`, ticking the "review DNS records" checklist step. |
| `cf_get` | `path` | Generic READ against v4 JSON REST endpoints using the standard Cloudflare API envelope (path after `…/client/v4`). |
| `recommend_configuration` | `focus?` (`all\|security\|performance\|reliability\|privacy\|bots\|api\|tls`) | Turn the room's captured `businessProfile` into tailored, priority-ranked Cloudflare recommendations (rationale, triggering profile signals, and a docs citation). **Read-only — it proposes and QUEUES NOTHING**; the model then presents the items grouped by theme and offers to queue the concrete ones via the write builders. Runs the local engine (`src/recommendations.ts`), so it never calls Cloudflare. |

The Cloudflare reads never change anything, and their failures come back through
`readError()` (`src/server.ts`), which appends a permission hint when
relevant. `recommend_configuration` reads only the room's own captured
`businessProfile`, so it makes no Cloudflare call and can never queue an action —
it only returns text for the model to relay (`formatRecommendationsForModel()`,
`src/recommendations.ts`).

### Memory & collaboration

| Tool | Input | Behaviour |
| --- | --- | --- |
| `remember` | `key`, `value` | Store a durable fact in room `memory` (survives restarts). |
| `set_defaults` | `accountId?`, `zoneId?`, `zoneName?` | Set the room's default account id / default zone. |

### Writes — these only QUEUE a pending action

None of these call Cloudflare. Each appends a `PendingAction`; a human must
**Apply** it. The model is told to say a change is "queued", never "done".

| Tool | Input | Queues |
| --- | --- | --- |
| `add_domain` | `name`, `accountId?`, `setupType?` (`full\|partial`) | `POST /zones`. Normalises the domain and resolves the account (explicit account → selected-zone provenance / room default → the token's sole account). With a token, it performs an exact account-filtered lookup first: an existing zone becomes the room default and nothing is queued. A matching pending/applying/failed approval is returned instead of duplicated. |
| `create_dns_record` | `zoneId`, `type`, `name`, `content`, `ttl?`, `proxied?`, `priority?` | `POST /zones/<id>/dns_records`. |
| `set_zone_setting` | `zoneId`, `setting`, `value` | `PATCH /zones/<id>/settings/<setting>`. |
| `create_waf_custom_rule` | `zoneId`, `rulesetId`, `description`, `expression`, `action` | `POST /zones/<id>/rulesets/<rulesetId>/rules`. (First `cf_get` the `http_request_firewall_custom` ruleset id.) |
| `cf_write` | `product`, `summary`, `method` (`POST\|PUT\|PATCH\|DELETE`), `path`, `body?`, `zoneId?` | JSON REST changes for products without a dedicated builder (Gateway, Access, Tunnels, Load Balancing, cache/redirect rules, …). Raw, multipart, binary, GraphQL, and nonstandard response APIs are unsupported. It refuses `POST /zones`; zone creation must use `add_domain` so existing-zone and duplicate-approval checks cannot be bypassed. |

> `expression` fields take Cloudflare wirefilter syntax, e.g.
> `ip.geoip.country eq "RU"` or `http.request.uri.path contains "/admin"`.
> Prefer the specific builders over `cf_write` when one exists.

### Onboarding, discovery & migration

| Tool | Type | Behaviour |
| --- | --- | --- |
| `update_onboarding` | state | Record the path (migrate vs fresh), domain, DNS setup, provider, and goals — call it after **each** answer in the chat-led flow. Captured info **auto-completes** the matching checklist steps, so `checkOff` is only needed for external go-live steps (TTLs, nameservers, verify, DNSSEC, proxy). |
| `update_business_profile` | state | Record answers to the "nature of the business" discovery questions (industry, app type, audience, traffic, whether users log in / expose an API, sensitive data, compliance, top concerns) into the room's `businessProfile`. **Only stores context — it changes nothing on the account.** Ask one question at a time; array answers are unioned with what's already captured so a partial call never drops earlier ones. Feeds `recommend_configuration`. Runs during onboarding **and** on-demand after go-live. |
| `list_migration_providers` | READ | List providers the migration tool can parse and their phases. |
| `preview_provider_migration` | READ | Translate inline or wizard-uploaded provider config into Cloudflare-equivalent rules; stores a migration plan. Formats: `json\|xml\|terraform\|panos\|auto`. Config input is capped at 850,000 UTF-8 bytes. |
| `queue_migration_rules` | QUEUE | Convert supported retained plan rules into pending actions (`zoneId` required; optional `phases` subset). Truncated plans queue only their displayed subset; Terraform export uses the complete stored source. |
| `generate_migration_terraform` | READ | Emit Terraform for the plan (reuses the last previewed config unless overridden). Downloadable from the sidebar. |
| `migration_preflight` | READ | Check the token has the permissions the plan's provider needs. |
| `migration_diff_report` | READ | Show what already exists in the target zone (migration-owned vs manual). |
| `export_migration_csv` | READ | Export the plan's config as CSV. Downloadable from the sidebar. |

Migration calls retain the initiating chat socket's authorization lease across
service and Cloudflare-read awaits. If that lease ends, Glide discards returned
data before saving a source, plan, check, export, onboarding update, or queued rule.

Automated post-migration validation and zone snapshot capture/list/restore/rollback
are disabled fail-closed and are not exposed as LLM tools. Verify the reviewed
Cloudflare configuration directly after Apply.

See [Onboarding & migration](./onboarding-and-migration.md) for the end-to-end
pipeline and what `queue_migration_rules` can and can't translate.

---

## `@callable` RPCs

These are invoked by the client via `agent.call(method, args)`
(`src/client/main.tsx`). Browser calls run only after signed Access identity and
room membership checks. Legacy trailing `by` arguments remain in several method
signatures, but browser attribution is replaced with the verified connection email.
Membership grants are available only through the explicit Invite-panel
`inviteTeammate` RPC; they are intentionally absent from the model's tool set.

Every callable invocation is an inbound Agent WebSocket frame and must pass the
`AGENT_RATE_LIMITER` protocol bucket (120 frames per 60 seconds per verified Access
identity) before the Agents SDK dispatches the method. Membership and JWT expiry
are rechecked after the binding await immediately before dispatch. The handshake also requires the exact
application origin, and initial protocol frames are suppressed before admission.
Binary frames close with `1003`; frames over the protocol byte limit close with
`1009`, both before rate-limit I/O.
Exhaustion closes the socket
with code `1013`, so the pending call rejects and normal client reconnection takes
over; it never executes in the background. Chat-request frames pass that same
gate and then `CHAT_RATE_LIMITER` at 20 submissions per 60 seconds both per Access
identity and per room. A chat-specific rejection uses the normal bounded chat error
frame and occurs before transcript persistence. HTTP delivery checks at
`/get-messages` use the separate 120-per-60-second Agent-request bucket. See
[Architecture](./architecture.md#layered-authenticated-traffic-limits) and
[Troubleshooting](./troubleshooting.md#rate-limiting).

### Approvals — the only place real writes happen

| RPC | Args | Returns | Notes |
| --- | --- | --- | --- |
| `applyAction` | `id`, `by?`, `confirmUncertain?` | `ActionResult` | **Executes** a queued action against Cloudflare. Publishes applying status and safely re-merges ruleset entrypoints; it does not capture a pre-mutation snapshot. Success removes the action; an ordinary API failure retains it. An uncertain/interrupted attempt is rejected unless the UI has completed the live-state warning and passes `confirmUncertain: true`. Legacy snapshot-restore approvals fail closed and are removed rather than retained for retry. |
| `rejectAction` | `id`, `by?` | `ActionResult` | Discards a queued action. |
| `applyAll` | `ids`, `by?` | `ActionResult[]` | Applies only the exact reviewed action IDs supplied by the client, in queue order. Newly queued actions, currently applying actions, and uncertain/interrupted attempts are excluded server-side. The UI confirms the reviewed count and reports if the queue changed before Apply. |

`applyAction` delegates to the single server path that executes queued
`PendingAction` writes. `applyAll` supplies reviewed IDs to that same path; it
does not bypass action validation, lifecycle state, or resource fences. Disabled
legacy snapshot-restore approvals are excluded from bulk Apply and rejected by the
individual server path. See [Security model](./security.md).
Apply and bulk Apply retain the invoking connection's authorization lease across
credential/safety-read awaits. If that connection closes, expires, or loses room
membership before write dispatch, no Cloudflare write is sent and bulk processing
stops. The lease includes a server-generated socket-session nonce, so reconnecting
with the same SDK connection id cannot inherit an older in-flight Apply.

### Token management

| RPC | Args | Returns | Notes |
| --- | --- | --- | --- |
| `setCloudflareToken` | `rawToken` | `{ ok, message }` | Requires `GLIDE_TOKEN_KEY`. Tries `/user/tokens/verify`, then account/zone read fallbacks for valid account-scoped tokens. Stores AES-256-GCM encrypted regardless of the result and updates `tokenLast4` / `tokenValid`. |
| `clearCloudflareToken` | — | `{ ok }` | Deletes this room's stored token and clears its token status. |
| `reverifyToken` | — | `{ ok, valid, message }` | Re-checks the already-stored token without returning it and refreshes `tokenValid`. The room calls this once on connect when an older stored token is marked unverified. |

`tokenValid` confirms that one authentication check succeeded; it does not prove
the token has every permission needed by later product-specific operations.
Token replacement, clear, and reverification also recheck the invoking connection's
exact socket-session lease after awaited work and before credential-state mutation.

### Client delivery diagnostics

| RPC | Args | Returns | Notes |
| --- | --- | --- | --- |
| `reportClientChatIssue` | `{ kind, messageId, connectionEpoch }` | `{ ok: true }` | Records a privacy-safe `chat.client_issue` structured event. `kind` is `not_delivered`, `response_interrupted`, or `accepted_pruned`; invalid input becomes `unknown`. The RPC accepts no message text or token value. |
| `retryInterruptedResponse` | `messageId`, `interruptedAssistantId?` | `{ ok, message }` | Retries only an authoritative latest unanswered turn. It consumes the strict identity and room chat budget before transcript work. |

Normal chat turns and response retries are bound to the exact initiating
socket-session nonce. Close, expiry, revocation, or same-id reconnect aborts the
active request; retry cancellation is passed through transcript save, and chat
tools suppress post-await output or mutation once the lease ends.

The authoritative delivery check uses the Agents SDK `/get-messages` HTTP endpoint
plus `acceptedChatMessageIds` for ids that have aged out of retained history. A
turn is delivered only when a correlated assistant message records the user id in
`responseTo` and `delivery: "completed"`. The client restores a truly absent draft,
offers **Retry response** for an accepted turn without a completed response, and
never resends an `accepted_pruned` turn. See
[Architecture: client delivery lifecycle](./architecture.md#the-client-delivery-lifecycle).

### Access and invites

| RPC | Args | Returns | Notes |
| --- | --- | --- | --- |
| `roomAccessStatus` | none | `RoomAccessStatus` | Rechecks the current connection identity/membership and returns canonical email, role, entry status, and the bounded member list. |
| `inviteTeammate` | `email`, `by?`, `link?` | `{ ok, message, members? }` | Only a current member can call it. Atomically adds the canonical ACL member and durable invite-audit row with the verified inviter, then updates the repairable UI projection. Refuses a 101st member. The optional link is metadata, not the credential. |
| `removeRoomMember` | `email` | `{ ok, message, members? }` | Owner-only. Refuses owner removal, atomically deletes the target's ACL/audit rows, and immediately closes every matching socket with `1008 Room membership revoked`. |

### Onboarding

Both the chat-led flow and the opt-in form drive the same `OnboardingState`, and
its checklist **auto-completes** from captured answers + the action queue
(`autoDoneSteps()` and `recomputeOnboardingChecklist()` in `src/server.ts`).

| RPC | Args | Notes |
| --- | --- | --- |
| `startOnboarding` | `by?` | Begin onboarding (creates the checklist once a path is chosen). Called by **Start in chat** and the branch quick-replies (`startGuided()`, `src/client/main.tsx`). |
| `updateOnboarding` | `patch`, `by?` | Merge a partial answer set (`path`, `domain`, `setupType`, `migratingFrom`, `goals`, `configProvided`, `completed`, `checkOff`). Auto-completes the matching checklist steps. |
| `completeOnboarding` | `by?` | Mark the guided setup finished. |
| `resetOnboarding` | `by?` | Clear onboarding entirely (`onboarding: undefined`) so the room can start over. Wired to the sidebar **Reset** button behind a `window.confirm` (`resetOnboarding()`, `src/client/main.tsx`). |
| `toggleOnboardingStep` | `id`, `done`, `by?` | Manually check/uncheck a single step — the override for the human-only go-live steps; most steps auto-complete. |
| `previewMigration` | `args`, `by?` | Run a read-only provider-config preview from the form wizard; accepts uploaded `configFiles`. |

### Business discovery & recommendations

These back the room's `businessProfile` and the sidebar **Recommendations** panel.
The profile is normally captured in chat by the `update_business_profile` tool;
these RPCs power the opt-in form step, the panel's **Queue** / **Ask Glide**
buttons, and the sidebar **Reset**.

| RPC | Args | Returns | Notes |
| --- | --- | --- | --- |
| `updateBusinessProfile` | `patch`, `by?` | `{ ok: true }` | Merge answers into `state.businessProfile` (`applyBusinessProfilePatch()`, `src/server.ts`). Array fields replace (the form sends the full selection); scalars/booleans overwrite when provided. Capturing a profile changes **nothing** on the account. |
| `resetBusinessProfile` | `by?` | `{ ok: true }` | Clear the captured profile (`businessProfile: undefined`) so discovery can start over. Wired to the sidebar **Reset** behind a `window.confirm` (`src/client/main.tsx`). |
| `queueRecommendation` | `recId`, `zoneId`, `by?` | `{ ok, message, id? }` | One-click **Queue** for a concrete recommendation. The client sends only the recommendation id + target zone id; the server **recomputes the set from the room's trusted `businessProfile` and rebuilds the exact Cloudflare call from its own catalog** (`recommendationToPending()`), never from a client-supplied path/body. Requires a 32-hex `zoneId`, de-duplicates against the queue, and refuses anything not concretely queueable — routing it to chat instead. |

Only a narrow set of recommendations are one-click queueable: `set_zone_setting`
for `ssl`, `always_use_https`, `min_tls_version`, `tls_1_3`, and `brotli`, plus the
concrete `cf_write` items for HSTS (`security_header`) and Tiered Cache
(`argo/tiered_caching`). Everything else (WAF managed rules, rate limits, Bot Fight
Mode, API Shield, Access, Argo, Load Balancing, Data Localization, leaked-credential
checks, or anything needing discovery / a paid plan / a dashboard step) is **not**
one-click and instead offers an **Ask Glide** hand-off in chat
(`isRecommendationQueueable()`, `src/recommendations.ts`).

### Conversation docs reading list

Cloudflare-docs retrieval automatically builds `state.docLinks`; it is not
manually editable and does not affect the shared Vectorize index.

| RPC | Args | Returns | Notes |
| --- | --- | --- | --- |
| `clearDocLinks` | `by?` | `{ ok: true }` | Clear this room's **Cloudflare docs** reading list. The sidebar exposes this as **Clear**; `/admin` renders the same list read-only. |

### Migration checks & exports

| RPC | Args | Notes |
| --- | --- | --- |
| `runPreflight` | `zoneId?`, `by?` | Token-permission preflight for the plan's provider. |
| `runDiffReport` | `zoneId?`, `by?` | What already exists in the target zone. |
| `exportMigrationCsv` | `by?` | Export the plan as CSV. |

### Legacy chat-history recovery

These room-scoped RPCs support the pre-upgrade transcript safety migration. The
client calls them automatically; they do not change Cloudflare configuration.

| RPC | Args | Notes |
| --- | --- | --- |
| `legacyChatMigrationStatus` | none | Returns `ready`, `migrating`, `recovery_required`, or `discarding`; also recreates a missing continuation schedule while work remains. |
| `discardLegacyChatArchiveForRecovery` | exact confirmation string | Available only after a durable stored-token decryption failure. Requires `DISCARD LEGACY CHAT ARCHIVE`, rechecks the exact socket-session lease after token decryption and before arming deletion, preserves retention rows and replay tombstones, and starts bounded archive deletion. |

### Disabled migration compatibility RPCs

These callable methods remain only as fail-closed compatibility stubs. The React
client exposes no validation or snapshot controls.

| RPC | Behaviour |
| --- | --- |
| `runValidate` | Always returns `{ ok: false }` with the automated-validation-disabled explanation. |
| `snapshotZone` | Always returns `{ ok: false }`; no snapshot is captured. |
| `refreshSnapshots` | Always returns `{ ok: false }`; no snapshot list is loaded. |
| `restoreSnapshot` | Always returns `{ ok: false }`; no restore or rollback is queued or executed. |

### Team guidance

Invoked from the read-only [admin dashboard](./architecture.md#the-admin-dashboard-admin)
(**Team guidance** tab, `src/client/main.tsx`). Each write keeps the
Vectorize RAG index in sync best-effort — see
[Architecture → Team guidance](./architecture.md#team-guidance-rag--srcguidance-ragts).

| RPC | Args | Returns | Notes |
| --- | --- | --- | --- |
| `upsertGuidanceDoc` | `input` (`{ id?, title?, body?, enabled? }`), `by?` | `{ ok, message, id? }` | Consumes the strict identity/room chat budget, then adds or updates a doc (`src/server.ts`). Title is clipped to 120 chars and body to `MAX_GUIDANCE_BODY`; rejects if both are empty or the room already has `MAX_GUIDANCE_DOCS` (25) docs. Then `syncGuidanceVectors()` (re)embeds it if enabled+non-empty, else drops its vector (`src/guidance-rag.ts`). |
| `deleteGuidanceDoc` | `id` | `{ ok, message? }` | Consumes the strict identity/room chat budget, then removes the doc from state and deletes its vector (`src/server.ts`). |
| `reindexGuidance` | — | `{ ok, indexed, message }` | Consumes the strict identity/room chat budget, then re-embeds every doc (upsert enabled, drop the rest). Use to backfill docs created before RAG existed or to repair the index; returns `ok: false` when Vectorize isn't configured (`src/server.ts`). |

These are the only mutating guidance paths; retrieval happens automatically each
turn via the private `selectGuidanceForPrompt()` (`src/server.ts`), not an RPC.

### Cloudflare docs (internal RAG index job)

The shared Cloudflare-docs index has no room-callable RPC controls. A **weekly
cron** (`Sun 02:00 UTC`) invokes `startDocsReindex` directly on one fixed internal
Durable Object; public HTTP and WebSocket routes to its reserved name return `404`.
The job enumerates, embeds, and upserts current pages in bounded scheduled batches,
with durable startup reconciliation if a delayed tick is lost. Per-turn retrieval
remains automatic via the private `selectDocsForPrompt()`.
See [Architecture → Cloudflare-docs RAG](./architecture.md#cloudflare-docs-rag--srcdocs-scraperts).

---

## How a write travels through the system

1. The user asks for a change in chat.
2. The model calls a QUEUE tool (e.g. `create_dns_record`) → `queuePending()`
   appends a `PendingAction` to `state.pendingActions` (`src/server.ts`).
3. The action shows up in every client's **Pending approvals** panel.
4. A human reviews the method, path, request body, and warnings before the
   controls, then clicks **Apply** → `applyAction` →
   (for ruleset phases) re-read + merge current rules →
   `cfRequest(method, path, token, body)`. No local pre-mutation snapshot is taken.
5. The action is first marked `applying`, which syncs to every client and fences
   duplicate Apply calls. The outcome is prepended to `recentResults` (capped at
   25). Applied/rejected actions are removed; failed actions remain queued with
   `status: "failed"` and an error so the team can correct the issue and Retry.
   A scheduled server-driven chat turn tells Glide the outcome automatically.
6. Non-idempotent writes are never retried automatically. A network/5xx outcome
   is marked uncertain and must be checked against live Cloudflare state before
   anyone chooses **Retry anyway**.

For bulk approval, the browser captures the IDs in the reviewed queue, asks for
confirmation, and calls `applyAll(ids, by)`. The server intersects that immutable
snapshot with its current queue and skips anything new, active, stale, or
uncertain. Logical resource locks serialize `PUT`/`PATCH`/`DELETE` requests to the
same API path even when their methods differ; zone creation is locked and deduped
by account plus normalized domain.

If the call fails with a permission error, the result `detail` names the missing
token permission.

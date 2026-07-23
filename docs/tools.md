# Tools & RPC reference

Glide exposes two distinct surfaces:

1. **LLM tools** — what the chat model can call during a turn (`buildTools()`,
   `src/server.ts:1791`). **READ** tools execute against Cloudflare immediately;
   **QUEUE** tools only append a `PendingAction` for human approval.
2. **`@callable` RPCs** — methods the React client invokes over the WebSocket
   (token management, approvals, the onboarding wizard, migration checks,
   snapshots, delivery diagnostics, and the admin dashboard's RAG controls).

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
| `cf_get` | `path` | Generic READ against any Cloudflare API `GET` endpoint (path after `…/client/v4`). |

These never change anything. Failures come back through `readError()`
(`src/server.ts:2262`), which appends a permission hint when relevant.

### Memory & collaboration

| Tool | Input | Behaviour |
| --- | --- | --- |
| `remember` | `key`, `value` | Store a durable fact in room `memory` (survives restarts). |
| `set_defaults` | `accountId?`, `zoneId?`, `zoneName?` | Set the room's default account id / default zone. |
| `invite_teammate` | `email` | Record an invite by email (validated, deduped). |

### Writes — these only QUEUE a pending action

None of these call Cloudflare. Each appends a `PendingAction`; a human must
**Apply** it. The model is told to say a change is "queued", never "done".

| Tool | Input | Queues |
| --- | --- | --- |
| `add_domain` | `domain`, `accountId?`, `type?` (`full\|partial`) | `POST /zones`. Normalises the domain, then resolves the account (explicit `accountId` → room `defaultAccountId` → the token's sole account). If it can't (no token, or several accounts and none chosen) it returns a question instead of queuing. |
| `create_dns_record` | `zoneId`, `type`, `name`, `content`, `ttl?`, `proxied?`, `priority?` | `POST /zones/<id>/dns_records`. |
| `set_zone_setting` | `zoneId`, `setting`, `value` | `PATCH /zones/<id>/settings/<setting>`. |
| `create_waf_custom_rule` | `zoneId`, `rulesetId`, `description`, `expression`, `action` | `POST /zones/<id>/rulesets/<rulesetId>/rules`. (First `cf_get` the `http_request_firewall_custom` ruleset id.) |
| `cf_write` | `product`, `summary`, `method` (`POST\|PUT\|PATCH\|DELETE`), `path`, `body?`, `zoneId?` | Any Cloudflare API change — for products without a dedicated builder (Gateway, Access, Tunnels, R2, Load Balancing, cache/redirect rules, …). |

> `expression` fields take Cloudflare wirefilter syntax, e.g.
> `ip.geoip.country eq "RU"` or `http.request.uri.path contains "/admin"`.
> Prefer the specific builders over `cf_write` when one exists.

### Onboarding & migration

| Tool | Type | Behaviour |
| --- | --- | --- |
| `update_onboarding` | state | Record the path (migrate vs fresh), domain, DNS setup, provider, and goals — call it after **each** answer in the chat-led flow. Captured info **auto-completes** the matching checklist steps, so `checkOff` is only needed for external go-live steps (TTLs, nameservers, verify, DNSSEC, proxy). |
| `list_migration_providers` | READ | List providers the migration tool can parse and their phases. |
| `preview_provider_migration` | READ | Translate an exported provider config into Cloudflare-equivalent rules; stores a migration plan. Accepts inline `config` or a `configUrl`; formats `json\|xml\|terraform\|panos\|auto`. |
| `queue_migration_rules` | QUEUE | Convert supported plan rules into pending actions (`zoneId` required; optional `phases` subset). |
| `generate_migration_terraform` | READ | Emit Terraform for the plan (reuses the last previewed config unless overridden). Downloadable from the sidebar. |
| `migration_preflight` | READ | Check the token has the permissions the plan's provider needs. |
| `migration_diff_report` | READ | Show what already exists in the target zone (migration-owned vs manual). |
| `migration_validate` | READ | After Apply, verify the queued rules exist in the zone. |
| `export_migration_csv` | READ | Export the plan's config as CSV. Downloadable from the sidebar. |
| `snapshot_zone` | READ* | Capture a full zone snapshot (restore point). Read-only on Cloudflare. |
| `list_zone_snapshots` | READ | List captured snapshots. Restoring is a **human-only** UI action, never a tool. |

\* `snapshot_zone` reads Cloudflare and writes a record into the migration tool's
snapshot store; it makes no changes to your zone.

See [Onboarding & migration](./onboarding-and-migration.md) for the end-to-end
pipeline and what `queue_migration_rules` can and can't translate.

---

## `@callable` RPCs

These are invoked by the client via `agent.call(method, args)`
(`src/client/main.tsx:407`). Most take a trailing `by` (the actor's display name)
for attribution.

### Approvals — the only place real writes happen

| RPC | Args | Returns | Notes |
| --- | --- | --- | --- |
| `applyAction` | `id`, `by?` | `ActionResult` | **Executes** a queued action against Cloudflare. Publishes applying status, snapshots the zone first (best-effort), and safely re-merges ruleset entrypoints. Success removes the action; failure retains it with the error for Retry. |
| `rejectAction` | `id`, `by?` | `ActionResult` | Discards a queued action. |
| `applyAll` | `by?` | `ActionResult[]` | Applies every non-running pending action in order. |

`applyAction` (`src/server.ts:2956`) is the **only** code path that calls a
mutating Cloudflare endpoint. See [Security model](./security.md).

### Token management

| RPC | Args | Returns | Notes |
| --- | --- | --- | --- |
| `setCloudflareToken` | `rawToken` | `{ ok, message }` | Requires `GLIDE_TOKEN_KEY`. Tries `/user/tokens/verify`, then account/zone read fallbacks for valid account-scoped tokens. Stores AES-256-GCM encrypted regardless of the result and updates `tokenLast4` / `tokenValid`. |
| `clearCloudflareToken` | — | `{ ok }` | Deletes the stored token; `tokenConfigured` falls back to whether `CF_API_TOKEN` exists. |
| `reverifyToken` | — | `{ ok, valid, message }` | Re-checks the already-stored token without returning it and refreshes `tokenValid`. The room calls this once on connect when an older stored token is marked unverified. |

`tokenValid` confirms that one authentication check succeeded; it does not prove
the token has every permission needed by later product-specific operations.

### Client delivery diagnostics

| RPC | Args | Returns | Notes |
| --- | --- | --- | --- |
| `reportClientChatIssue` | `{ kind, messageId, connectionEpoch }` | `{ ok: true }` | Records a privacy-safe `chat.client_issue` structured event. `kind` is `not_delivered` or `response_interrupted`; invalid input becomes `unknown`. The RPC accepts no message text or token value. |

The authoritative delivery check itself uses the Agents SDK `/get-messages` HTTP
endpoint, not a callable RPC. The client compares its generated message id with
the persisted transcript: it restores the draft when the id is absent, or offers
**Retry response** when the user message exists without a following assistant
message. See [Architecture: client delivery lifecycle](./architecture.md#the-client-delivery-lifecycle).

### Invites

| RPC | Args | Returns |
| --- | --- | --- |
| `inviteTeammate` | `email`, `by?`, `link?` | `{ ok, message }` |

### Onboarding

Both the chat-led flow and the opt-in form drive the same `OnboardingState`, and
its checklist **auto-completes** from captured answers + the action queue
(`autoDoneSteps()`, `src/server.ts:217`; re-derived by
`recomputeOnboardingChecklist()`, `src/server.ts:900`).

| RPC | Args | Notes |
| --- | --- | --- |
| `startOnboarding` | `by?` | Begin onboarding (creates the checklist once a path is chosen). Called by **Start in chat** and the branch quick-replies (`startGuided()`, `src/client/main.tsx:494`). |
| `updateOnboarding` | `patch`, `by?` | Merge a partial answer set (`path`, `domain`, `setupType`, `migratingFrom`, `goals`, `configProvided`, `completed`, `checkOff`). Auto-completes the matching checklist steps. |
| `completeOnboarding` | `by?` | Mark the guided setup finished. |
| `resetOnboarding` | `by?` | Clear onboarding entirely (`onboarding: undefined`) so the room can start over. Wired to the sidebar **Reset** button behind a `window.confirm` (`resetOnboarding()`, `src/client/main.tsx:514`). |
| `toggleOnboardingStep` | `id`, `done`, `by?` | Manually check/uncheck a single step — the override for the human-only go-live steps; most steps auto-complete. |
| `previewMigration` | `args`, `by?` | Run a read-only provider-config preview from the form wizard; accepts uploaded `configFiles`. |

### Migration checks & exports

| RPC | Args | Notes |
| --- | --- | --- |
| `runPreflight` | `zoneId?`, `by?` | Token-permission preflight for the plan's provider. |
| `runDiffReport` | `zoneId?`, `by?` | What already exists in the target zone. |
| `runValidate` | `zoneId?`, `by?` | Verify queued rules landed (post-Apply). |
| `exportMigrationCsv` | `by?` | Export the plan as CSV. |

### Zone snapshots

| RPC | Args | Notes |
| --- | --- | --- |
| `snapshotZone` | `zoneId?`, `by?` | Capture a restore point (read-only on Cloudflare). |
| `refreshSnapshots` | `zoneId?` | Pull the stored snapshot list into synced state. |
| `restoreSnapshot` | `snapshotId`, `zoneId?`, `by?` | **DESTRUCTIVE** — reverts the zone to a snapshot. Guarded by a `window.confirm` in the UI (`src/client/main.tsx:1024`); never automated. |

### Team guidance

Invoked from the read-only [admin dashboard](./architecture.md#the-admin-dashboard-admin)
(**Team guidance** tab, `src/client/main.tsx:2538`). Each write keeps the
Vectorize RAG index in sync best-effort — see
[Architecture → Team guidance](./architecture.md#team-guidance-rag--srcguidance-ragts).

| RPC | Args | Returns | Notes |
| --- | --- | --- | --- |
| `upsertGuidanceDoc` | `input` (`{ id?, title?, body?, enabled? }`), `by?` | `{ ok, message, id? }` | Add or (when `id` matches) update a doc (`src/server.ts:1169`). Title clipped to 120 chars, body to `MAX_GUIDANCE_BODY`; rejects if both are empty or the room already has `MAX_GUIDANCE_DOCS` (25) docs. Then `syncGuidanceVectors()` (re)embeds it if enabled+non-empty, else drops its vector (`src/guidance-rag.ts:105`). |
| `deleteGuidanceDoc` | `id` | `{ ok: true }` | Remove the doc from state and delete its vector (`src/server.ts:1202`). |
| `reindexGuidance` | — | `{ ok, indexed, message }` | Re-embed every doc (upsert enabled, drop the rest). Use to backfill docs created before RAG existed or to repair the index; returns `ok: false` when Vectorize isn't configured (`src/server.ts:1215`). |

These are the only mutating guidance paths; retrieval happens automatically each
turn via the private `selectGuidanceForPrompt()` (`src/server.ts:1241`), not an RPC.

### Cloudflare docs (RAG index job)

Admin-only controls on the **Cloudflare docs** tab (`CfDocsTab`,
`src/client/main.tsx:2236`) that drive the background job which indexes the
official Cloudflare developer docs into the shared `__cfdocs__` Vectorize
namespace. See [Architecture → Cloudflare-docs RAG](./architecture.md#cloudflare-docs-rag--srcdocs-scraperts).

| RPC | Args | Returns | Notes |
| --- | --- | --- | --- |
| `startDocsReindex` | `by?` | `{ ok, message }` | Start (or restart) a full reindex: enumerate products from `llms.txt`, then embed + upsert pages in bounded batches chained via the scheduler (`docsTick`). Refuses if one is already running (`src/server.ts:1326`). |
| `cancelDocsReindex` | — | `{ ok, message }` | Flip the run to `cancelled` and clear its `runId`; in-flight ticks self-cancel (`src/server.ts:1491`). |
| `clearDocsIndex` | — | `{ ok, message, deleted }` | Delete all indexed doc vectors from the shared namespace (`src/server.ts:1511`). |

A **weekly cron** (`Sun 02:00 UTC`) also drives a full reindex via the Worker's
`scheduled()` handler (`src/server.ts:3078`) — no admin action needed. Retrieval
per chat turn is automatic via the private `selectDocsForPrompt()`
(`src/server.ts:1551`), not an RPC.

---

## How a write travels through the system

1. The user asks for a change in chat.
2. The model calls a QUEUE tool (e.g. `create_dns_record`) → `queuePending()`
   appends a `PendingAction` to `state.pendingActions` (`src/server.ts:2274`).
3. The action shows up in every client's **Pending approvals** panel.
4. A human clicks **Apply** → `applyAction` RPC (`src/server.ts:2956`) →
   best-effort zone snapshot → (for ruleset phases) re-read + merge current rules
   → `cfRequest(method, path, token, body)` (`src/server.ts:3001`).
5. The action is first marked `applying`, which syncs to every client and fences
   duplicate Apply calls. The outcome is prepended to `recentResults` (capped at
   25). Applied/rejected actions are removed; failed actions remain queued with
   `status: "failed"` and an error so the team can correct the issue and Retry.
   A scheduled server-driven chat turn tells Glide the outcome automatically.
6. Non-idempotent writes are never retried automatically. A network/5xx outcome
   is marked uncertain and must be checked against live Cloudflare state before
   anyone chooses **Retry anyway**.

If the call fails with a permission error, the result `detail` names the missing
token permission.

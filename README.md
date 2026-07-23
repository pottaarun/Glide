# Glide

**Chat your Cloudflare config into existence — together.**

Glide is a multi-user, real-time chat room that drives the Cloudflare API with
persistent memory. A team opens a shared room, talks to an AI assistant in plain
English, and Glide inspects their Cloudflare account, proposes changes, and
**queues every change for a human to approve**. It also guides teams onboarding
onto Cloudflare — including migrating an existing CDN/WAF/DNS/Zero-Trust provider
(Akamai, Fastly, Imperva, Zscaler, and more) into Cloudflare-equivalent rules.

It runs entirely on Cloudflare: a Worker serves a React SPA and routes chat to a
[Durable Object](https://developers.cloudflare.com/durable-objects/) built on the
[Agents SDK](https://developers.cloudflare.com/agents/), with the chat brain
powered by [Workers AI](https://developers.cloudflare.com/workers-ai/).

The chat transport is delivery-aware: Glide shows whether the room is live,
verifies interrupted sends against the server-authoritative transcript, restores
drafts that were not delivered, and offers a safe response retry when only the
assistant turn was interrupted.

---

## The core idea: reads run, writes wait

Glide's safety contract is the most important thing to understand:

- **Read / list operations run immediately.** The assistant can freely inspect
  accounts, zones, DNS records, rulesets, and settings to answer questions and
  ground its proposals.
- **Every change is only _queued_.** When the assistant wants to create, update,
  or delete Cloudflare configuration, it does **not** call the API. It appends a
  `PendingAction` to the room's shared queue.
- **A human applies it.** The real Cloudflare write happens only when someone in
  the room clicks **Apply** (the `applyAction` RPC). Until then, nothing is live.

This makes Glide safe to use collaboratively: the LLM proposes, humans dispose.

---

## Documentation

This README is the overview. In-depth docs live in [`docs/`](docs/):

| Doc | What's inside |
| --- | --- |
| [Architecture](docs/architecture.md) | Worker + `GlideAgent` Durable Object, the chat-turn lifecycle, source map, synced state, SQLite tables, and the API clients. |
| [Setup & configuration](docs/setup.md) | Prerequisites, local dev, every var/secret, the `MIGRATION` binding, token permissions, and deploying. |
| [Tools & RPC reference](docs/tools.md) | Every LLM tool and every `@callable` Durable Object RPC. |
| [Onboarding & migration](docs/onboarding-and-migration.md) | The guided wizard and the read-only provider-migration pipeline. |
| [Security model](docs/security.md) | At-rest token encryption, the room-link credential model, and the writes-through-a-human guarantee. |
| [Troubleshooting & observability](docs/troubleshooting.md) | Connection recovery, delivery diagnostics, structured log queries, and incident handling. |

---

## Features

- **Real-time collaborative rooms.** Everyone in a room shares the same live chat
  transcript and the same pending-action queue, synced over a WebSocket.
- **Verified message delivery.** A **live** / **reconnecting** badge prevents sends
  into a closed socket. Interrupted sends are checked by message id; missing text
  returns to the composer and incomplete assistant turns can be retried safely.
- **Drives all of Cloudflare.** Dedicated tools to add a domain/zone, and manage
  DNS, zone settings, and WAF custom rules, plus a generic `cf_write`/`cf_get`
  that can reach any Cloudflare API endpoint (Gateway, Access, Tunnels, R2, Load
  Balancing, cache rules, …).
- **Answers grounded in the live Cloudflare docs.** An admin-triggered background
  job scrapes the official Cloudflare developer docs, embeds them into **Vectorize**
  (a shared `__cfdocs__` namespace), and a weekly cron keeps them fresh. Each chat
  turn retrieves the most relevant excerpts into the prompt so Glide cites current,
  authoritative guidance instead of guessing.
- **Persistent room memory.** Durable facts (account IDs, zone defaults, naming
  conventions) survive restarts and are shared with everyone in the room.
- **Guided, chat-led onboarding.** Glide greets a new room and walks a team
  through going live **one question at a time** — _migrate from a provider_ or
  _start fresh_ — recording each answer and **auto-completing a checklist**
  grounded in Cloudflare's recommended go-live path. A click-through form wizard is
  available as an opt-in.
- **Provider migration (read-only first).** Translate an exported Akamai / Fastly /
  Imperva / Zscaler / Prisma Access / Cisco Umbrella / Proofpoint config into
  Cloudflare rules, with pre-flight permission checks, a target-zone diff,
  post-migration validation, Terraform & CSV export, and zone snapshots/restore.
- **Team guidance (semantic RAG).** Admins add per-room "guidance" docs (house
  rules, preferred defaults, onboarding questions to ask). They're embedded with
  Workers AI and stored in **Vectorize**; at chat time Glide retrieves only the
  most relevant docs into the system prompt. Falls back to injecting all enabled
  docs when Vectorize isn't configured — so it always works.
- **Read-only admin dashboard (`/admin`).** A per-room control room to review the
  full transcript, the pending/After-Apply action log, invites, onboarding and
  migration status, zone snapshots, exports, and a build-time docs tracker — plus
  two editable surfaces: the **Team guidance** tab and the **Cloudflare docs** tab
  (trigger/monitor the docs reindex job).
- **Encrypted-at-rest tokens.** A Cloudflare API token can be set in the GUI and
  is stored AES-256-GCM encrypted in the Durable Object — never synced, logged, or
  returned (only a masked last-4 is shown).
- **Secret-safe chat and telemetry.** API-token-shaped chat input is blocked,
  persisted history is redacted, and privacy-safe `glideEvent` logs correlate
  rooms, turns, messages, model stages, outcomes, and client connection epochs.
- **Friendly errors.** API failures are classified and, where relevant, tell you
  exactly which token permission is missing.
- **A calm, vivid interface.** A dark "aurora over the edge at dawn" theme — a
  living gradient backdrop behind translucent glass panels, an animated gradient
  wordmark, and a color-coded safety model (a header **"reads run · writes wait"**
  pill; green = applied, amber = pending, red = failed). Respects
  `prefers-reduced-motion`.

---

## Architecture

```
Browser (React SPA)  ──  chat room (/)  ·  read-only admin (/admin#<room>)
   │  WebSocket (state sync + streaming chat) and persisted delivery checks
   ▼
Worker (src/server.ts)
   ├── routeAgentRequest()  ──►  GlideAgent (Durable Object)
   │                               ├── AIChatAgent: streaming chat + message history
   │                               ├── GlideState: synced room memory + pending queue
   │                               ├── SQLite: encrypted token, snapshots, queues, last config
   │                               ├── secret-redacted history + structured chat events
   │                               ├── LLM tools (reads run; writes queue)
   │                               ├── Team guidance RAG ──► AI embed + Vectorize (guidance-rag.ts)
   │                               ├── Cloudflare-docs RAG ──► scrape + embed + Vectorize (docs-scraper.ts)
   │                               └── Apply/Reject RPCs ──► Cloudflare API (cf-api.ts)
   ├── env.ASSETS.fetch()   ──►  static React build (dist/client)
   └── scheduled()          ──►  weekly Cloudflare-docs reindex (cron: Sun 02:00 UTC)

                 (optional) MIGRATION service binding / MIGRATION_API_URL
                                      │  read-only endpoints
                                      ▼
                          Switchflare / migration tool Worker
```

A **room** is a single `GlideAgent` instance, named by the URL hash. Open the same
link and you share the same agent — same chat, same queue, same memory. Append
`/admin#<room>` for a read-only dashboard of that same room.

### Source layout

| File | Responsibility |
| --- | --- |
| `src/server.ts` | Worker entry + the `GlideAgent` Durable Object: chat brain, LLM tool definitions, the Apply/Reject approval RPCs, at-rest token encryption, the guidance RPCs, and all migration helpers. |
| `src/client/main.tsx` | The React client: join screen, room UI, the chat-led onboarding opener + opt-in form wizard, the sidebar, and the read-only `/admin` dashboard. Holds all component styling in one inline `S` styles object. |
| `src/client/index.css` | Global visual layer the inline styles can't do: Google-font wiring, the animated aurora backdrop, gradient wordmark, hover/focus/entrance motion, custom scrollbars, and the `prefers-reduced-motion` reset. |
| `src/shared.ts` | Types shared by the Worker and the client (`GlideState`, `PendingAction`, `OnboardingState`, `MigrationPlan`, `GuidanceDoc`, …). Pure types only. |
| `src/system-prompt.ts` | Builds the LLM system prompt, injecting room memory, onboarding status, the migration plan, and the retrieved team-guidance docs. Encodes the safety contract. |
| `src/guidance-rag.ts` | Team-guidance RAG helper: embeds docs with `GLIDE_EMBED_MODEL`, upserts/queries **Vectorize** per-room (namespace-isolated), and degrades gracefully when the index is absent. |
| `src/docs-scraper.ts` | Cloudflare-docs RAG: scrapes the developer docs (`llms.txt` index), cleans + chunks pages, embeds them into a shared `__cfdocs__` Vectorize namespace with deterministic ids, and retrieves the top matches per chat turn. |
| `src/cf-api.ts` | Cloudflare API client: retry/backoff, typed error classification, a permission-hint map, and zone-snapshot capture. |
| `src/chat-delivery.ts` | Server-authoritative delivery classification plus Cloudflare token detection and persistence redaction. |
| `src/migration.ts` | Read-only client for the Switchflare / migration tool Worker (preview, Terraform, pre-flight, diff, validate, CSV, snapshots, restore). |
| `src/env.d.ts` | Augments the generated `Cloudflare.Env` with secrets not declared in `wrangler.jsonc`. |
| `vite.config.ts` | Builds the client to `dist/client` and exposes the build-time docs manifest (`virtual:glide-docs`) that powers the admin **Dev docs** tab. |
| `wrangler.jsonc` | Worker config: Durable Object, AI binding, Vectorize binding, optional MIGRATION service binding, static assets, and the `GLIDE_MODEL` / `GLIDE_EMBED_MODEL` vars. |

> Deep dive: [docs/architecture.md](docs/architecture.md) — request/chat-turn
> lifecycle, the full `GlideState`, the SQLite tables, and the API clients.

---

## Prerequisites

- **Node.js** 20+ and npm (Vite 8 requires a current Node release)
- A **Cloudflare account** with **Workers AI** enabled
- **[Wrangler](https://developers.cloudflare.com/workers/wrangler/)** (installed as a dev dependency)
- A **Cloudflare API token** (create one at
  [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens))
- _Optional:_ a running [Switchflare](https://developers.cloudflare.com/) migration
  tool Worker if you want the provider-migration features

---

## Quick start (local development)

```bash
# 1. Install dependencies
npm install

# 2. Configure local secrets
cp .dev.vars.example .dev.vars
#   then edit .dev.vars and set at least CF_API_TOKEN

# 3. Build the client bundle the Worker serves from ./dist/client
npm run build

# 4. Run the Worker locally (serves the SPA + the GlideAgent Durable Object)
npm run dev
```

Open the URL Wrangler prints, pick a display name, and you'll land in a fresh
room. Share the room URL with a teammate to collaborate.

For fast UI-only iteration you can also run the Vite dev server:

```bash
npm run dev:ui
```

> **Tip:** You don't have to put a token in `.dev.vars`. If you set
> `GLIDE_TOKEN_KEY`, you can enter a Cloudflare API token directly into the GUI
> (**Connection → Set token**); it's stored encrypted in the Durable Object.

### npm scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | `wrangler dev` — runs the full Worker (DO + AI + assets) locally. |
| `npm run dev:ui` | `vite` — runs only the React UI dev server for quick iteration. |
| `npm run build` | `vite build` — builds the client to `dist/client`. |
| `npm run deploy` | `npm run build && wrangler deploy` — build, then deploy the Worker. |
| `npm test` | Runs the action-lifecycle, chat-integrity, and delivery/redaction regression tests with Node's test runner. |
| `npm run types` | `wrangler types` — regenerate binding types. |
| `npm run check` | `tsc --noEmit` — type-check the project. |

---

## Configuration

### Non-secret vars (`wrangler.jsonc`)

| Var | Default | Purpose |
| --- | --- | --- |
| `GLIDE_MODEL` | `@cf/openai/gpt-oss-120b` | The Workers AI model that powers the chat brain. A full-precision, 128k-context model with reliable function calling. |
| `GLIDE_EMBED_MODEL` | `@cf/baai/bge-base-en-v1.5` | The Workers AI text-embedding model for team-guidance **and** Cloudflare-docs RAG. Its output dimensionality (768) **must** match the Vectorize index. |

### Secrets / environment

Set these via `.dev.vars` locally or `wrangler secret put <NAME>` in production.

| Name | Required | Purpose |
| --- | --- | --- |
| `CF_API_TOKEN` | Recommended | Cloudflare API token Glide uses to drive the API. Acts as the fallback when no GUI token is set. |
| `GLIDE_TOKEN_KEY` | Optional | Key used to derive the AES-256-GCM key that encrypts GUI-provided tokens at rest. **Without it, GUI token storage is disabled** and only `CF_API_TOKEN` is used. Generate one with e.g. `openssl rand -base64 32`. |
| `MIGRATION_API_URL` | Optional | Base URL of the Switchflare / migration tool Worker. Used as a fallback when the `MIGRATION` service binding isn't present. |

### The `VECTORIZE` binding (team-guidance RAG)

`wrangler.jsonc` declares a [Vectorize](https://developers.cloudflare.com/vectorize/)
index for guidance retrieval:

```jsonc
"vectorize": [{ "binding": "VECTORIZE", "index_name": "glide-guidance" }]
```

Create the index once (its 768 dimensions must match `GLIDE_EMBED_MODEL`):

```bash
wrangler vectorize create glide-guidance --dimensions=768 --metric=cosine
```

Each room's docs are isolated by a per-room Vectorize `namespace`. If the binding
or index is absent, Glide safely falls back to injecting **all** enabled guidance
docs into the prompt, so guidance still works — you just lose the semantic
top-K narrowing.

### The `MIGRATION` service binding

`wrangler.jsonc` can declare a service binding to a Worker named `switchflare`:

```jsonc
"services": [{ "binding": "MIGRATION", "service": "switchflare" }]
```

This invokes the migration tool directly inside the runtime, which works even
when its public hostname is behind Cloudflare Access. It is **preferred** over
`MIGRATION_API_URL`.

> **Note:** This line is **commented out by default** in `wrangler.jsonc`, because
> a service binding to a `switchflare` Worker that doesn't exist makes
> `wrangler deploy` fail. Re-enable it once you've deployed your own migration
> Worker, or set `MIGRATION_API_URL` instead. Without either, the migration
> features are simply disabled and the tools explain how to enable them — the rest
> of Glide works.

### Cloudflare API token permissions

Reads and writes require matching token permissions. Glide surfaces the missing
permission when an API call fails. Common ones, by product:

- **DNS** — DNS: Edit (Zone)
- **Zone settings / SSL** — Zone Settings: Edit (Zone)
- **WAF / rate limiting / cache / redirects** — Zone WAF: Edit (Zone) + Account Rulesets: Edit (Account)
- **Load Balancing** — Load Balancers: Edit (Zone) + Monitors and Pools: Edit (Account)
- **IP lists** — Account Filter Lists: Edit (Account)
- **Zero Trust** — Gateway: Edit, Access: Apps and Policies: Edit, Cloudflare Tunnel: Edit (all Account)
- **Workers** — Workers Scripts: Edit (Account)

Grant only what the team actually needs.

When a token is saved, Glide first calls `/user/tokens/verify`. That endpoint is
user-scoped and can reject a valid account-scoped token, so Glide falls back to
authenticated account and zone reads before marking the token unverified. A green
token badge means authentication succeeded for at least one of those checks;
individual operations can still fail if the token lacks a product-specific
permission. A stored unverified token is checked once again when the room connects.

Enter tokens only through **Connection → Set token** or **Connection → Change**.
Do not paste a token into chat. The client blocks recognizable `cfat_...` values
and the server redacts matching values before persistence, but any token exposed
outside the connection form should still be revoked and rotated.

---

## Deploying

```bash
# Create the Vectorize index for team-guidance RAG (once)
wrangler vectorize create glide-guidance --dimensions=768 --metric=cosine

# Set production secrets (once)
wrangler secret put CF_API_TOKEN
wrangler secret put GLIDE_TOKEN_KEY      # optional, enables GUI token storage
wrangler secret put MIGRATION_API_URL    # optional, if not using the service binding

# Build + deploy
npm run deploy
```

The Worker serves the built SPA from `./dist/client` via the `ASSETS` binding and
routes `/agents/*` to the `GlideAgent` Durable Object. `npm run deploy` runs
`vite build` first, which also refreshes the admin **Dev docs** snapshot from the
current Markdown.

A deployment can interrupt an in-flight Durable Object response. Deploy outside
active conversations when possible; after a deploy, wait for the **live** badge or
hard-refresh the room before sending another message.

---

## How a room works

1. **Join.** You enter a display name (saved in `localStorage`). The name is
   attached to your messages and to any action you queue or apply.
2. **Room URL = access.** A room is identified by the URL hash, which is a
   128-bit random id by default. **There is no separate login — anyone with the
   room link can read the room and Apply changes using its token.** Share links
   only with teammates.
3. **Chat.** Wait for the **live** badge, then ask Glide to inspect or change your
   Cloudflare setup. Reads stream back immediately; changes appear in the
   **Pending approvals** panel.
4. **Approve.** Click **Apply** (or **Apply all**) to execute a queued change, or
   **Reject** to discard it. Every client sees the action move through pending,
   applying, and applied/failed status. Failed actions stay queued with their
   error so they can be retried after the token or permission is fixed; uncertain
   network outcomes require a live-state check first. Outcomes also land in
    **Recent results**, and Glide automatically receives the result in chat.

If the WebSocket drops during a send, Glide checks the persisted transcript by
message id. A missing message is removed from the optimistic transcript and
restored to the composer. If the user message arrived but the assistant response
did not, Glide offers **Retry response** once the connection is live. A **Stop**
button and 20-second stall escape hatch keep a hung response from permanently
disabling the composer.

### Synced room state (`GlideState`)

Everything in the sidebar is live-synced read-only to every client: room `memory`,
`pendingActions`, `recentResults`, `invites`, `defaultAccountId` / `defaultZone`,
token status (`tokenConfigured`, masked `tokenLast4`, `tokenValid`), the
`onboarding` progress, the current `migrationPlan`, `terraform` / `csv` exports,
the latest `migrationCheck`, zone `snapshots`, the team `guidance` docs, and
whether a migration tool is connected (`migrationToolConfigured`). The decrypted
token, the raw provider config, the guidance **vectors**, and pre-apply zone
snapshots are **not** synced — they live only in the Durable Object's SQLite (or
Vectorize).

Clients mutate room data only through callable RPCs; direct client state writes
are rejected by the agent.

---

## Onboarding & migration

### Guided onboarding (chat-led)

A guided setup walks a team through going live on Cloudflare. By default it's
**conversational**: Glide greets the room and asks **one focused question at a
time** — **migrate vs. start fresh**, then provider, scope (DNS / WAF / cache /
rate limiting / load balancing / Zero Trust), domain, DNS setup type
(**Full/primary** vs **Partial/CNAME**), and an API token — recording each answer
as it goes. It keeps a live checklist mirroring Cloudflare's recommended go-live
path that **auto-completes as the required info is captured**. A click-through
form wizard is available as an opt-in alternative for people who prefer it. A
**Reset** button in the sidebar clears onboarding so a room can start the flow
over (`resetOnboarding`).

### Provider migration

If a team is moving off another vendor, Glide uses the migration tool to read
their **exported** config and translate it into Cloudflare rules. This whole
preview path is **read-only** — nothing changes until queued rules are Applied:

1. **`preview_provider_migration`** — parse an exported config (JSON, XML,
   Terraform, or PAN-OS, inline or by URL) into Cloudflare-equivalent rules and
   store a migration plan in the room.
2. **`migration_preflight`** — check the token has the permissions the plan needs.
3. **`migration_diff_report`** — show what already exists in the target zone
   (migration-owned vs. manually created) so nothing is clobbered.
4. **`queue_migration_rules`** — convert supported rules (WAF custom, IP/geo
   access, rate limiting, redirects, cache, origin, header transforms, zone/SSL
   settings) into pending actions. Redirect/cache/origin/header mappings are
   best-effort and flagged "review before Apply."
5. **`generate_migration_terraform`** / **`export_migration_csv`** — export the
   plan as Infrastructure-as-Code or CSV (downloaded from the sidebar).
6. **`migration_validate`** — after Apply, verify the queued rules actually exist
   in the zone.

**Supported providers:** Akamai, Fastly, Imperva (Incapsula), Zscaler ZIA,
Zscaler ZPA, Prisma Access, Cisco Umbrella, Akamai EAA, Proofpoint.

**Zone snapshots.** Capture a full read-only snapshot of a zone (rulesets,
settings, IP lists, load balancers) as a restore point before applying changes.
Restoring a snapshot is **destructive** and is always a human-only action in the
UI — Glide never auto-restores.

> Deep dive (wizard steps, checklists, the translation table for what
> `queue_migration_rules` can map): [docs/onboarding-and-migration.md](docs/onboarding-and-migration.md).

---

## Team guidance & the admin dashboard

### Team guidance (semantic RAG)

Admins can teach Glide house rules per room — preferred defaults, naming
conventions, or the exact onboarding questions to ask. Each **guidance doc**
(`title` + `body`, toggleable `enabled`) is embedded with `GLIDE_EMBED_MODEL` and
upserted into **Vectorize** under a per-room namespace. On each chat turn Glide
embeds the latest user message and retrieves the top matches into the system
prompt, so guidance scales past the point where injecting everything would bloat
the context window. With ≤ 6 enabled docs (or no Vectorize index) it simply
injects them all. Manage docs from the admin **Team guidance** tab
(`upsertGuidanceDoc` / `deleteGuidanceDoc` / `reindexGuidance`).

### Cloudflare docs (semantic RAG)

Glide can also ground its answers in the **official Cloudflare developer docs**. An
admin starts a reindex from the **Cloudflare docs** tab (`startDocsReindex`), which
scrapes the docs index (`llms.txt`), cleans and chunks each page, and embeds it
into a **shared** `__cfdocs__` Vectorize namespace with deterministic ids (so
re-runs update in place and benefit *every* room). The job runs in bounded batches
chained via the Agents SDK scheduler, and a **weekly cron** (`Sun 02:00 UTC`,
`scheduled()`) refreshes it automatically. On each chat turn Glide retrieves the
top matching excerpts into the system prompt and is told to cite their URLs. Needs
the `VECTORIZE` binding; without it the feature is simply inert.

### Read-only admin dashboard (`/admin`)

Open `/admin#<room>` (there's an **Admin →** link in the room header) for a
read-only control room over the same `GlideAgent`. It reads the live synced state,
the chat transcript, and a build-time docs manifest — there are **no** Apply/Reject
controls here (do that from the chat room). Tabs:

| Tab | Shows |
| --- | --- |
| **Comms** | The full chat transcript (with per-message tool chips) + invites. |
| **Actions** | The pending queue (view-only) and the recent apply/fail/reject results. |
| **Team guidance** | An editable surface — add / edit / enable / delete guidance docs and **Reindex for search**. |
| **Cloudflare docs** | Start / cancel / clear the background job that indexes the Cloudflare developer docs into Vectorize, with live progress (pages indexed, chunks upserted). |
| **Dev docs** | A "what changed" tracker of the repo's Markdown (README + `docs/`): title, last-modified, size, and an inline viewer. Refreshed on every `npm run build`. |
| **Onboarding & migration** | Onboarding checklist/progress, the migration plan + last check, zone snapshots, and the Terraform / CSV exports. |

---

## LLM tools reference

The assistant has these tools. **READ** tools execute immediately; **QUEUE** tools
only add a pending action for human approval.

### Read / discovery

| Tool | Description |
| --- | --- |
| `list_accounts` | List Cloudflare accounts the token can see. |
| `list_zones` | List zones, optionally filtered to one account. |
| `find_zone` | Resolve a zone id by domain name and save it as the room default. |
| `list_dns_records` | List DNS records for a zone (optionally by type). |
| `cf_get` | Generic READ against any Cloudflare API GET endpoint. |

### Memory & collaboration

| Tool | Description |
| --- | --- |
| `remember` | Store a durable fact for the room. |
| `set_defaults` | Set the room's default account id / default zone. |
| `invite_teammate` | Record an invite by email. |

### Writes (queue only)

| Tool | Description |
| --- | --- |
| `add_domain` | Queue adding a domain/zone (`POST /zones`). Resolves the account automatically (explicit → room default → the token's only account) and asks for a token/account when it can't. |
| `create_dns_record` | Queue creating a DNS record. |
| `set_zone_setting` | Queue changing a zone setting. |
| `create_waf_custom_rule` | Queue adding a WAF custom rule to a ruleset. |
| `cf_write` | Queue any Cloudflare API change (POST/PUT/PATCH/DELETE) for products without a dedicated builder. |

### Onboarding & migration

`update_onboarding`, `list_migration_providers`, `preview_provider_migration`,
`queue_migration_rules`, `generate_migration_terraform`, `migration_preflight`,
`migration_diff_report`, `migration_validate`, `export_migration_csv`,
`snapshot_zone`, `list_zone_snapshots`.

> Each turn runs at most 8 tool-steps, read payloads echoed to the model are
> capped (~6 KB) to protect the context window, and the room keeps the last 25
> action results in synced state.

> Full per-tool inputs and the client-invoked RPCs: [docs/tools.md](docs/tools.md).

---

## Security notes

- **Tokens are encrypted at rest.** GUI-provided tokens are sealed with
  AES-256-GCM (key derived from `GLIDE_TOKEN_KEY` via HKDF) and stored in the
  Durable Object's SQLite. They're never synced to clients, logged, or returned —
  only a masked last-4 is exposed for status.
- **Tokens stay out of chat and telemetry.** Recognizable Cloudflare API tokens
  cannot be submitted through the normal composer and are redacted from persisted
  text parts. Structured chat events contain identifiers and outcomes, not message
  text or token values.
- **The room link is the credential.** There is no per-user auth. Anyone with the
  link can read the room and Apply changes with its token. Default rooms get a
  128-bit random id so they aren't guessable; treat the link like a password.
- **Writes always pass through a human.** The LLM can only queue; `applyAction`
  is the single place a real Cloudflare write occurs. A best-effort zone snapshot
  is captured before mutating a zone, and ruleset-phase replacements re-read the
  phase's current rules at apply time so existing rules aren't dropped.
- **Migration previews never write.** Glide only calls the migration tool's
  read-only endpoints; it never triggers a direct deploy.

> Full threat model, the encryption scheme (HKDF → AES-256-GCM), and operator
> recommendations: [docs/security.md](docs/security.md).

---

## Troubleshooting and logs

| Symptom | Expected recovery |
| --- | --- |
| Badge says **reconnecting** | Keep the draft in the composer and wait for **live** before sending. Hard-refresh after a deployment if it does not recover. |
| Message was not delivered | Glide restores the original text to the composer; send it again only after **live** returns. |
| Assistant response was interrupted | Click **Retry response** after the room reconnects. Glide continues from the persisted user turn instead of duplicating it. |
| Response spinner stops progressing | Click **Stop**. After 20 seconds without progress, the composer also becomes usable again. |
| Token remains unverified | Open **Connection → Change**, confirm its scope and permissions, then replace it if authenticated account and zone reads both fail. |

Production logs are available under **Workers & Pages → glide → Observability →
Logs** or from a terminal:

```bash
npx wrangler tail glide
```

Filter structured records by `glideEvent` and `room`. Chat lifecycle records can
also include `turnId`, `messageId`, `stage`, `outcome`, `kind`, and
`connectionEpoch`. Common events are `chat.received`, `chat.prepared`,
`chat.model_pass`, `chat.stream_created`, `chat.stream_finished`, `chat.error`,
`chat.client_issue`, and `chat.secrets_redacted`.

See [Troubleshooting and observability](docs/troubleshooting.md) for event meanings
and an incident workflow.

---

## Tech stack

- **Cloudflare Workers** + **Durable Objects** (SQLite-backed)
- **[Agents SDK](https://developers.cloudflare.com/agents/)** and `@cloudflare/ai-chat`
  for stateful, streaming chat with synced state
- **Workers AI** via `workers-ai-provider` and the Vercel **AI SDK** (`ai`, `@ai-sdk/react`)
- **[Vectorize](https://developers.cloudflare.com/vectorize/)** for semantic
  retrieval (RAG) of both team-guidance docs and the Cloudflare developer docs
- **React 19** + **Vite** for the client
- **Zod** for tool input schemas
- **TypeScript** throughout
- **UI:** inline React styles + a hand-written `index.css` atmosphere layer
  (aurora backdrop, glass, gradient wordmark) and Google Fonts — Space Grotesk
  (display), Inter (body), JetBrains Mono (code). No CSS framework.

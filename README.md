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
- **A human reviews and applies it.** The action card shows the method, target,
  request body, and any safety warning before its controls. The real Cloudflare
  write happens only when someone clicks **Apply**. Until then, nothing is live.
- **Risky retries are never bulk-applied.** Interrupted writes are marked
  uncertain and require a live-state check plus an explicit individual retry.
  **Apply reviewed changes** sends the exact reviewed action IDs and skips any
  action that became active or uncertain before the server received the request.

This makes Glide safe to use collaboratively: the LLM proposes, humans dispose.

---

## Documentation

This README is the overview. In-depth docs live in [`docs/`](docs/):

| Doc | What's inside |
| --- | --- |
| [Architecture](docs/architecture.md) | Worker + `GlideAgent` Durable Object, abuse-control layers, the chat-turn lifecycle, source map, synced state, SQLite tables, and the API clients. |
| [Setup & configuration](docs/setup.md) | Prerequisites, local dev, every var/secret and binding, production rate-limit tuning, token permissions, and deploying. |
| [Tools & RPC reference](docs/tools.md) | Every LLM tool and every `@callable` Durable Object RPC. |
| [Onboarding & migration](docs/onboarding-and-migration.md) | The guided wizard and the read-only provider-migration pipeline. |
| [Security model](docs/security.md) | Verified Access identity, durable room membership, at-rest token encryption, production abuse controls, and the writes-through-a-human guarantee. |
| [Troubleshooting & observability](docs/troubleshooting.md) | Connection recovery, rate-limit responses, delivery diagnostics, structured log queries, and incident handling. |

---

## Features

- **Real-time collaborative rooms.** Everyone in a room shares the same live chat
  transcript and the same pending-action queue, synced over a WebSocket.
- **Verified message delivery.** A **live** / **reconnecting** badge prevents sends
  into a closed socket. Interrupted sends are checked by message id; missing text
  returns to the composer and incomplete assistant turns can be retried safely.
- **Verified identity and private rooms.** The Worker validates Cloudflare Access
  application JWTs before dynamic routing. Verified `@cloudflare.com` employees
  can create or claim rooms; current members can grant another verified email
  access. Membership is durable, server-only, and checked on every WebSocket frame.
- **Per-room roles (RBAC) with an exportable audit trail.** Every member holds one
  of three roles: an **owner** (creator — grants roles, removes members, deletes
  the room), a **member** (chat, queue proposals, **Apply**, invite other members),
  or a read-only **viewer** (chat and queue proposals, but blocked from every
  commit — Apply, token changes, invites). Only an owner can grant a viewer or flip
  a member ↔ viewer. Every sensitive action (invites, removals, role changes,
  applies, token changes, deletion) is written to an append-only, owner-viewable
  **Audit** trail that lives only in SQLite — never synced to clients.
- **Nameable rooms with an owner-only delete.** Any member can give a room a
  human-friendly name (e.g. "arubhe.com go-live") that labels it in the header,
  invites, and admin view without changing its routing id. The room **owner** can
  permanently delete a room — wiping all of its Durable Object storage — behind a
  typed `DELETE THIS ROOM` confirmation. A verified employee can browse an **all
  rooms** list in `/admin` (`GET /api/rooms`), backed by a deployment-wide room
  registry that is a convenience index only — per-room membership still gates every
  room.
- **Layered production abuse controls.** Cloudflare Rate Limiting bounds dynamic
  HTTP requests to 120/minute per hashed client network and WebSocket frames to
  120/minute per verified identity. AI chat is stricter at 20 submissions/minute
  both per verified identity and per room. Hashed JS/CSS and non-root asset
  requests are not counted; the authenticated root document is.
- **Broad Cloudflare API coverage.** Dedicated tools add a domain/zone and manage
  DNS, zone settings, and WAF custom rules. Generic `cf_write`/`cf_get` tools cover
  Cloudflare v4 JSON REST endpoints for products such as Gateway, Access, Tunnels,
  Load Balancing, and cache rules; raw, multipart, binary, GraphQL, and nonstandard
  response APIs are outside their contract. Zone creation is intentionally reserved for
  `add_domain`, which deduplicates approvals and, when the room has a token,
  checks the target account for an existing zone first.
- **Answers grounded in the live Cloudflare docs.** A system-owned background job
  scrapes the official Cloudflare developer docs, embeds them into **Vectorize**
  (a shared `__cfdocs_v2__` namespace), starts on first use, and refreshes them weekly. Each chat
  turn retrieves the most relevant excerpts into the prompt so Glide cites current,
  authoritative guidance instead of guessing. Pages surfaced during the
  conversation accumulate into a deduplicated **Cloudflare docs** reading list in
  the sidebar and read-only admin view.
- **Persistent room memory.** Durable facts (account IDs, zone defaults, naming
  conventions) survive restarts and are shared with everyone in the room.
- **Guided, chat-led onboarding.** Glide greets a new room and walks a team
  through going live **one question at a time** — _migrate from a provider_ or
  _start fresh_ — recording each answer and **auto-completing a checklist**
  grounded in Cloudflare's recommended go-live path. The checklist ticks itself
  from the domain's **real live Cloudflare state** too: once `find_zone` /
  `list_dns_records` see the zone, an already-active zone auto-checks activation
  and nameservers and marks "lower TTLs" **N/A**, `Full`/`Full (strict)` SSL checks
  the SSL step, a deployed managed WAF checks security, and any proxied record
  checks proxy status. Understanding the **nature of the business** is a required,
  interleaved part of that flow (not an optional extra), so onboarding never
  finishes with an empty business profile. A click-through form wizard is available
  as an opt-in.
- **Business-aware recommendations.** Glide asks probing questions about the
  _nature of the business_ — industry, app type, logins/API, audience & traffic,
  sensitive data, compliance, and top concerns — one at a time, and stores them as
  a room **business profile**. A deterministic recommendation engine
  (`src/recommendations.ts`) then maps that profile to tailored, priority-ranked
  Cloudflare performance/security/reliability settings (PCI-aware TLS, login rate
  limits, bot protection, API Shield, tiered cache/Argo, and more), each with a
  rationale and a docs citation. It runs during onboarding **and on-demand any
  time** ("what should we turn on?"). A **Recommendations** panel in the sidebar
  renders the live suggestions grouped by priority with a one-click **Queue**
  button for the concrete settings (and an **Ask Glide** hand-off for the ones
  that need discovery or a paid plan). Like everything else, it only ever
  **queues** changes for a human to Apply — the server rebuilds each call from its
  own catalog, so a button can't inject an arbitrary API request.
- **Provider migration (read-only first).** Translate an exported Akamai / Fastly /
  Imperva / Zscaler / Prisma Access / Cisco Umbrella / Proofpoint config into
  Cloudflare rules, with pre-flight permission checks, a target-zone diff, and
  Terraform & CSV export. Automated post-migration validation and zone snapshot
  operations are disabled fail-closed; verify the reviewed live configuration directly.
- **Team guidance (semantic RAG).** Admins add per-room "guidance" docs (house
  rules, preferred defaults, onboarding questions to ask). They're embedded with
  Workers AI and stored in **Vectorize**; at chat time Glide retrieves only the
  most relevant docs into the system prompt. Falls back to injecting all enabled
  docs when Vectorize isn't configured — so it always works.
- **Read-only admin dashboard (`/admin`).** A per-room control room to review the
  full transcript, the pending/After-Apply action log, invites, onboarding and
  migration status, exports, the audit trail, and a build-time docs tracker — plus
  one editable surface for room-scoped **Team guidance**. A verified Cloudflare
  employee who is **not** a member can still open any room's dashboard through an
  audited, read-only inspection snapshot (`POST /api/room-inspect`) that never opens
  a socket and exposes no write controls — so oversight never widens the write
  surface. Each inspection is itself recorded to the room's audit trail.
- **Encrypted-at-rest tokens.** A Cloudflare API token can be set in the GUI and
  is stored AES-256-GCM encrypted in the Durable Object — never synced, logged, or
  returned (only a masked last-4 is shown).
- **Secret-safe chat and telemetry.** API-token-shaped chat input is blocked,
  persisted history is redacted, and privacy-safe `glideEvent` logs correlate
  rooms, turns, messages, model stages, outcomes, and client connection epochs.
- **Friendly errors.** API failures are classified and, where relevant, suggest
  the likely read/write token permission group to verify.
- **A responsive control-plane interface.** Neutral dark operational surfaces,
  restrained Cloudflare-orange accents, explicit connection/token states, and a
  color-coded safety model (green = applied, amber = pending, red = failed).
  Desktop keeps chat and approvals side by side; tablet and mobile collapse into
  one scrollable workspace. Motion respects `prefers-reduced-motion`.

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
   │                               ├── SQLite: encrypted token, queues, and migration source
   │                               ├── secret-redacted history + structured chat events
   │                               ├── LLM tools (reads run; writes queue)
   │                               ├── Team guidance RAG ──► AI embed + Vectorize (guidance-rag.ts)
   │                               ├── Cloudflare-docs RAG ──► scrape + embed + Vectorize (docs-scraper.ts)
   │                               └── Apply/Reject RPCs ──► Cloudflare API (cf-api.ts)
   ├── env.ASSETS.fetch()   ──►  static React build (dist/client)
    └── fetch bootstrap / scheduled() ──► initial + weekly Cloudflare-docs reindex

                 (optional) MIGRATION service binding / MIGRATION_API_URL
                                      │  read-only endpoints
                                      ▼
                          Switchflare / migration tool Worker
```

A **room** is a single `GlideAgent` instance. The display id in the URL hash is
mapped to the same Agent path segment PartySocket historically used, preserving
existing custom-room storage. Current ACL members who open the same link share the
same chat, queue, and memory; the link alone grants nothing. Append
`/admin#<room>` for a dashboard of that same room. Admin admission is inspect-only:
it cannot create a new room or claim an unowned legacy room.

### Source layout

| File | Responsibility |
| --- | --- |
| `src/server.ts` | Worker entry + the `GlideAgent` Durable Object: chat brain, LLM tool definitions, the Apply/Reject approval RPCs, at-rest token encryption, the guidance RPCs, and all migration helpers. |
| `src/access-auth.ts` | Cloudflare Access JWT verification, cached remote JWKS resolution, identity canonicalization, trusted internal headers, and fail-closed responses. |
| `src/client/main.tsx` | The React client: join screen, room UI, the chat-led onboarding opener + opt-in form wizard, the sidebar, and the read-only `/admin` dashboard. Holds all component styling in one inline `S` styles object. |
| `src/client/index.css` | Global visual layer the inline styles can't do: font wiring, restrained ambient light and pointer glow, hover/focus/entrance motion, responsive layouts, custom scrollbars, and the `prefers-reduced-motion` reset. |
| `src/shared.ts` | Client-safe shared types plus room display-id validation and the shared PartySocket-compatible display-to-storage-name mapping. |
| `src/system-prompt.ts` | Builds the LLM system prompt, injecting room memory, onboarding status, the migration plan, and the retrieved team-guidance docs. Encodes the safety contract. |
| `src/guidance-rag.ts` | Team-guidance RAG helper: embeds docs with `GLIDE_EMBED_MODEL`, upserts/queries **Vectorize** per-room (namespace-isolated), and degrades gracefully when the index is absent. |
| `src/docs-scraper.ts` | Cloudflare-docs RAG: scrapes the developer docs (`llms.txt` index), cleans + chunks pages, embeds them into a shared `__cfdocs_v2__` Vectorize namespace with deterministic ids, and retrieves the top matches per chat turn. |
| `src/cf-api.ts` | Cloudflare API client: retry/backoff, typed error classification, permission hints, and ruleset safety reads. |
| `src/chat-delivery.ts` | Server-authoritative delivery classification and admission validation plus Cloudflare token detection and persistence redaction. |
| `src/chat-message-ledger.ts` | Durable accepted-user-message ID ledger schema and trigger, preventing replay after transcript pruning. |
| `src/rate-limits.ts` | Pure abuse-control policy helpers: opaque client/room keys, binding outcomes, route selection, and retryable HTTP responses. |
| `src/migration.ts` | Client for the Switchflare / migration tool Worker (preview, Terraform/CSV, pre-flight, and diff), with fail-closed guards for disabled validation and snapshot mutation endpoints. |
| `src/env.d.ts` | Augments the generated `Cloudflare.Env` with secrets not declared in `wrangler.jsonc`. |
| `vite.config.ts` | Builds the client to `dist/client` and exposes the build-time docs manifest (`virtual:glide-docs`) that powers the admin **Dev docs** tab. |
| `wrangler.jsonc` | Worker config: Durable Object, AI, Vectorize, rate-limit, optional MIGRATION, and static-asset bindings plus the model vars. |

> Deep dive: [docs/architecture.md](docs/architecture.md) — request/chat-turn
> lifecycle, the full `GlideState`, the SQLite tables, and the API clients.

---

## Prerequisites

- **Node.js** `^22.18.0` or `>=24.11.0` and npm (also pinned in `.nvmrc`)
- A **Cloudflare account** with **Workers AI** enabled
- **[Wrangler](https://developers.cloudflare.com/workers/wrangler/)** (installed as a dev dependency)
- A **Cloudflare Zero Trust organization and Access application** protecting the
  complete production hostname
- A **Cloudflare API token** (create one at
  [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens))
- _Optional:_ a running [Switchflare](https://developers.cloudflare.com/) migration
  tool Worker if you want the provider-migration features

---

## Quick start (local development)

```bash
# 1. Install dependencies
npm install

# 2. Configure local secrets and the loopback-only development identity
cp .dev.vars.example .dev.vars
#   then edit .dev.vars and set GLIDE_TOKEN_KEY + GLIDE_DEV_ACCESS_EMAIL

# 3. Build the client bundle the Worker serves from ./dist/client
npm run build

# 4. Run the Worker locally (serves the SPA + the GlideAgent Durable Object)
npm run dev
```

Open the loopback URL Wrangler prints. Glide uses `GLIDE_DEV_ACCESS_EMAIL` only
for loopback requests; use an `@cloudflare.com` development address to create a
fresh room. Keep Wrangler bound to loopback and do not expose it through a LAN
listener or reverse proxy. Deployed hostnames always require a signed Access
assertion.

> **Tip:** Do not put a Cloudflare API token in `.dev.vars`. Set only
> `GLIDE_TOKEN_KEY`, then enter each room's Cloudflare API token directly into the GUI
> (**Connection → Set token**); it's stored encrypted in the Durable Object.

### npm scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | `wrangler dev` — runs the full Worker (DO + AI + assets) locally. |
| `npm run build` | `vite build` — builds the client to `dist/client`. |
| `npm run deploy` | `npm run build && wrangler deploy` — build, then deploy the Worker. |
| `npm test` | Runs the Node regression suite and Workers-runtime Durable Object integration tests. |
| `npm run test:workers` | Runs the Workers-runtime integration tests with Vitest. |
| `npm run types` | `wrangler types` — regenerate binding types. |
| `npm run types:check` | Verifies that committed Worker binding types match `wrangler.jsonc`. |
| `npm run check` | Checks generated bindings, then type-checks the app and Workers-runtime tests. |

---

## Configuration

### Non-secret vars (`wrangler.jsonc`)

| Var | Default | Purpose |
| --- | --- | --- |
| `GLIDE_MODEL` | `@cf/openai/gpt-oss-120b` | The Workers AI model that powers the chat brain. A full-precision, 128k-context model with reliable function calling. |
| `GLIDE_EMBED_MODEL` | `@cf/baai/bge-base-en-v1.5` | The Workers AI text-embedding model for team-guidance **and** Cloudflare-docs RAG. Its output dimensionality (768) **must** match the Vectorize index. |

### Rate-limit bindings (public deployment)

`wrangler.jsonc` declares two Cloudflare Rate Limiting bindings:

| Binding | Limit | Enforcement |
| --- | --- | --- |
| `AGENT_RATE_LIMITER` | 120 per 60 seconds | Authenticated dynamic HTTP requests use a SHA-256 digest of `CF-Connecting-IP`; inbound WebSocket frames use a separate bucket keyed by the verified Access subject. |
| `CHAT_RATE_LIMITER` | 20 per 60 seconds | Each validated chat submission, first per verified Access identity and then per hashed room. The same budget covers response retries and guidance writes/reindexing. |

Exceeded HTTP requests return `429` with `Retry-After: 60`; a temporarily
unavailable binding fails closed on dynamic authenticated traffic with `503` and
`Retry-After: 10`. Apart from the authenticated root document, static asset
requests remain outside these buckets. These controls
reduce abuse; Access JWT verification and durable room membership provide
authentication and authorization.
See [Setup & configuration](docs/setup.md#workers-rate-limiting-bindings) for
namespace IDs, tuning, locality, and local-test behavior.

### Secrets / environment

Set these via `.dev.vars` locally or `wrangler secret put <NAME>` in production.

| Name | Required | Purpose |
| --- | --- | --- |
| `TEAM_DOMAIN` | Required in production | Canonical Access team URL, for example `https://your-team.cloudflareaccess.com`; used as the JWT issuer and JWKS origin. |
| `POLICY_AUD` | Required in production | Audience tag of the Access application protecting Glide. |
| `GLIDE_DEV_ACCESS_EMAIL` | Local development only | Explicit identity accepted only when the request URL is loopback. Keep Wrangler bound to loopback; it is ignored on deployed hostnames and must not replace production Access. |
| `GLIDE_TOKEN_KEY` | Required for Cloudflare API access | Key used to derive the AES-256-GCM key that encrypts each room's GUI-provided token at rest. **Without it, token storage is disabled.** Generate one with e.g. `openssl rand -base64 32`. There is no deployment-wide token fallback. |
| `MIGRATION_API_URL` | Optional | Base URL of the Switchflare / migration tool Worker. Used as a fallback when the `MIGRATION` service binding isn't present. |

### Cloudflare Access (required in production)

Create a self-hosted Access application for the Worker's complete production
hostname, not only `/agents/*`. Allow identity-provider sign-in and/or One-time
PIN for prospective invitees. The broad Access policy authenticates an email;
Glide's server-side room table decides which authenticated emails may enter each
room. Copy the application audience to `POLICY_AUD` and the standard
`https://<team>.cloudflareaccess.com` URL to `TEAM_DOMAIN`.

The Worker accepts only signed RS256 application tokens with the configured
issuer/audience, a verified email, non-empty subject, and current expiry. Service
tokens and global-session tokens cannot become room users. Missing configuration
returns `503`; missing or invalid assertions return `401`/`403` before Agent
routing. The issuer-scoped `jose` resolver reuses its remote JWKS cache. A signing-key
endpoint outage returns no-store `503 access_keys_unavailable` with
`Retry-After: 10`; an unknown key remains an invalid-token `403`. See
[Setup & configuration](docs/setup.md#cloudflare-access-and-room-membership)
for the complete policy and rollout sequence.

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

Each room's guidance queries are scoped to a deterministic per-room Vectorize
`namespace`; this is storage/query partitioning, not an authentication boundary.
Access identity plus the room's server-only membership table is the authorization
boundary. If the binding or index is absent, Glide safely falls back to injecting **all** enabled guidance
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
- **Zone discovery** — Zone > Zone > Read, scoped to the target zones
- **Add a new domain/zone** — Zone > Zone > Edit, scoped to **All zones/domains**.
  For an Account API Token, add a separate zone/domain-scoped policy; this
  permission is not available under an **Entire Account** policy. A zone that
  does not exist yet cannot be selected as a specific-zone resource.
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
Do not paste a token into chat. The client blocks recognizable `cfat_...`,
`cfut_...`, and `cfk_...` values plus legacy 40-character credentials in
token/bearer contexts. The server also redacts the room's exact stored token
before persistence, but any token exposed
outside the connection form should still be revoked and rotated.

---

## Deploying

```bash
# Create the Vectorize index for team-guidance RAG (once)
wrangler vectorize create glide-guidance --dimensions=768 --metric=cosine

# Set production secrets (once)
wrangler secret put TEAM_DOMAIN          # Access issuer / team URL
wrangler secret put POLICY_AUD           # Access application audience
wrangler secret put GLIDE_TOKEN_KEY      # enables encrypted per-room token storage
wrangler secret put MIGRATION_API_URL    # optional, if not using the service binding

# Build + deploy
npm run deploy
```

Configure the Access application and its policy before exposing this version. The
Worker serves the built SPA from `./dist/client` via the `ASSETS` binding and
routes authorized `/agents/*` traffic to the `GlideAgent` Durable Object. `npm run deploy` runs
`vite build` first, which also refreshes the admin **Dev docs** snapshot from the
current Markdown. Wrangler deploys both rate-limit binding configurations with the
Worker; no separate WAF rule is required.

A deployment can interrupt an in-flight Durable Object response. Deploy outside
active conversations when possible; after a deploy, wait for the **live** badge or
hard-refresh the room before sending another message.

If upgrading from a release that used the deployment-wide `CF_API_TOKEN` secret,
follow the room-by-room migration and secret-removal steps in
[Setup & configuration](docs/setup.md#upgrading-from-cf_api_token).

---

## How a room works

1. **Authenticate.** Cloudflare Access verifies the browser identity; Glide uses
   the signed token's canonical email for chat and action attribution.
2. **Open or create.** A room is identified by the URL hash. New room ids must
   match `^[A-Za-z0-9_-]{1,128}$`; the default is a 32-character hyphenless UUIDv4.
   Older non-control ids up to 200 characters remain lookup-only. A same-origin
    `POST /api/room-access` may let a Cloudflare employee create a canonical empty
    room or claim an existing legacy room. Agent routing itself never creates or
    claims a room. The admin gate uses the endpoint's inspect-only intent and also
    cannot create or claim. Everyone else must already be in the server-side membership table.
3. **Invite.** Any current member can grant another canonical email membership,
   up to 100 members. New members join as **member** by default; only the owner can
   grant a read-only **viewer** or change an existing member's role. The recipient
   must authenticate to Access as that exact email; possessing the URL alone grants
   nothing. Only the owner can remove a non-owner; removal immediately closes all of
   that member's room sockets. Any member can also **name** the room from the header
   (a display-only label, capped at 60 characters, that never changes the routing
   id).
4. **Chat.** Wait for the **live** badge, then ask Glide to inspect or change your
   Cloudflare setup. Reads stream back immediately; changes appear in the
   **Pending approvals** panel.
5. **Approve.** Review the method, path, body, and warning, then click **Apply** or
   **Reject**. For several actions, **Apply reviewed changes** confirms and sends
   only the IDs visible in that reviewed queue snapshot. Failed actions stay
   queued for correction; uncertain network/interruption outcomes are excluded
   from bulk apply and require a live-state check before **Retry anyway**.
   Outcomes also land in **Recent results**, and Glide receives the result in chat.
6. **Delete (owner only).** The room owner can permanently delete the room from the
   sidebar **Danger zone**. It requires a typed `DELETE THIS ROOM` confirmation,
   then wipes every trace of the room — chat history, pending approvals, memory,
   business profile, invites, and the encrypted Cloudflare token — deregisters it
   from the room registry, and drops all connected clients. This is irreversible.

If the WebSocket drops during a send, Glide checks the persisted transcript by
message id. A missing message is removed from the optimistic transcript and
restored to the composer. If the user message arrived but the assistant response
did not, Glide offers **Retry response** once the connection is live. A **Stop**
button and 20-second stall escape hatch keep a hung response from permanently
disabling the composer.

### Synced room state (`GlideState`)

Everything in the sidebar is live-synced read-only to every client: the optional
`roomName`, room `memory`,
`pendingActions`, `recentResults`, `invites`, `defaultAccountId` / `defaultZone`,
token status (`tokenConfigured`, masked `tokenLast4`, `tokenValid`), the
`onboarding` progress (whose checklist steps carry a `done` flag and an optional
`na`), the captured `businessProfile`, the current `migrationPlan`, `terraform` /
`csv` exports, the latest pre-flight/diff `migrationCheck`, the best-effort
`liveZone` facts that drive checklist auto-ticking, the team `guidance` docs, and
whether migration import is configured (`migrationToolConfigured`). The decrypted
token, the raw provider config, the guidance **vectors**, and the **audit trail**
are **not** synced — they live only in the Durable Object's SQLite (or Vectorize).

Room authorization is also not synced state. The canonical email, role
(`owner`/`member`/`viewer`), inviter, and join time live in the server-only
`glide_room_members` SQLite table. `glide_room_invites` is the durable invitation
audit and `glide_room_audit` is the append-only trail of sensitive actions (both
owner/employee-viewable, never synced), while `GlideState.invites` is a bounded UI
projection; none of them grant access without an ACL row. Legacy invite records are
retained only as audit data and must be re-issued before those guests can return.

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

### Business discovery & tailored recommendations

Alongside the mechanical go-live, Glide asks about the **nature of the business**
— one question at a time — to recommend the settings that actually fit the team:
industry/vertical, app type (website / web app / API / static site / UGC), whether
users log in and whether an API is exposed, audience reach and traffic profile,
sensitive data (PII / payments / health / credentials), compliance
(PCI DSS / HIPAA / GDPR / SOC 2 / …), and top concerns (bots, DDoS, scraping,
credential stuffing, card testing, latency, downtime, cost). Answers are recorded
with `update_business_profile` into a room-level `businessProfile` (a chat
backfill parser also recovers obvious answers from free text, and the opt-in form
has a matching step).

A deterministic engine in [`src/recommendations.ts`](src/recommendations.ts) then
maps that profile to priority-ranked recommendations — grouped as
security / performance / reliability / privacy / bots / API / TLS — each with a
plain-English rationale, the profile signals that triggered it, a docs citation,
and a queue hint (SSL Full (strict), min TLS 1.2 + TLS 1.3 + HSTS for PCI/HIPAA,
login/checkout/API rate limits, WAF managed rules, Bot Fight Mode, leaked-credential
checks, API Shield schema/JWT/mTLS, Cache Rules, Tiered Cache, Argo, Load
Balancing, Access for internal apps, Data Localization for GDPR, …). Glide invokes
`recommend_configuration` (read-only), presents the relevant items, explains why
each fits, and offers to **queue** the important ones via the normal write
builders — so recommendations still pass through the human-Apply safety contract,
and nothing plan-gated or destructive is queued without confirmation. This runs
during onboarding **and on-demand at any time** (e.g. "how should we harden this?").

The same engine drives a **Recommendations** panel in the sidebar: each item
shows its priority, product, rationale, and a docs link. Concrete zone
settings and simple API changes get a one-click **Queue** button (via the
`queueRecommendation` RPC, which recomputes the set from the room's trusted
profile and rebuilds the exact call server-side — the client only sends the
recommendation id + target zone). Items needing discovery, a managed-ruleset id,
a real endpoint, or a paid plan instead get an **Ask Glide** button that hands the
setup to chat. Items already queued/applied are labelled as such. The captured
profile and its recommendations are also shown read-only in the `/admin`
dashboard.

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

**Supported providers:** Akamai, Fastly, Imperva (Incapsula), Zscaler ZIA,
Zscaler ZPA, Prisma Access, Cisco Umbrella, Akamai EAA, Proofpoint.

Automated post-migration validation is **disabled fail-closed** because the
migration service does not compare complete live rule and setting values. Verify
the reviewed Cloudflare configuration directly after Apply. Zone snapshot capture,
listing, restore, and rollback are also disabled because complete, fail-safe
recovery cannot be guaranteed. Glide exposes no model tools or UI controls for
these paths; compatibility RPCs return disabled errors.

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

Glide can also ground its answers in the **official Cloudflare developer docs**.
A first-use bootstrap and weekly cron invoke one fixed internal Durable Object, which
scrapes the docs index (`llms.txt`), cleans and chunks each page, and embeds it
into a **shared** `__cfdocs_v2__` Vectorize namespace with deterministic ids.
Successful pages replace vectors in place; failed pages retain their
last-known-good vectors, and removed pages are deleted only after complete product
enumeration. The job runs in bounded
batches chained via the Agents SDK scheduler (`Sun 02:00 UTC`, `scheduled()`). On each chat turn Glide retrieves the
top matching excerpts into the system prompt and is told to cite their URLs. Needs
the `VECTORIZE` binding; without it the feature is simply inert. Room clients do
not expose start, cancel, or clear controls for this deployment-wide index.

### Read-only admin dashboard (`/admin`)

Open `/admin#<room>` (there's an **Admin →** link in the room header) as a current
room member for a
read-only control room over the same `GlideAgent`. It reads the live synced state,
the chat transcript, and a build-time docs manifest — there are **no** Apply/Reject
controls here (do that from the chat room), and opening admin cannot create or
claim a room. The admin landing screen also shows verified Cloudflare employees an
**All rooms** list (from `GET /api/rooms`) so they can jump straight into any room's
dashboard; opening a room there still enforces that room's membership. A verified
employee who isn't a member gets the same read-only dashboard, hydrated from an
audited one-shot inspection snapshot (`POST /api/room-inspect`) instead of a live
WebSocket — so oversight never opens a write path. Tabs:

| Tab | Shows |
| --- | --- |
| **Comms** | The full chat transcript (with per-message tool chips) + invites. |
| **Actions** | The pending queue (view-only) and the recent apply/fail/reject results. |
| **Audit** | The append-only trail of sensitive actions (invites, removals, role changes, applies, token changes, inspections). Owner- and employee-viewable. |
| **Team guidance** | An editable surface — add / edit / enable / delete guidance docs and **Reindex for search**. |
| **Dev docs** | A "what changed" tracker of the repo's Markdown (README + `docs/`): title, last-modified, size, and an inline viewer. Refreshed on every `npm run build`. |
| **Onboarding & migration** | Onboarding checklist/progress (with live-zone auto-ticks and N/A steps), the migration plan + last pre-flight/diff check, and the Terraform / CSV exports. |

---

## LLM tools reference

The assistant has these tools. **READ** tools execute immediately; **QUEUE** tools
only add a pending action for human approval.

### Read / discovery

| Tool | Description |
| --- | --- |
| `list_accounts` | List Cloudflare accounts the token can see. |
| `list_zones` | List zones, optionally filtered to one account. |
| `find_zone` | Resolve a zone id by domain name and save it as the room default. Also captures the zone's live status/SSL/WAF state to auto-tick the go-live checklist. |
| `list_dns_records` | List DNS records for a zone (optionally by type). Folds proxy coverage into the live-zone facts (ticks the proxy-status step). |
| `cf_get` | Generic READ against Cloudflare v4 JSON REST endpoints that use the standard API envelope. |
| `recommend_configuration` | Turn the room's business profile into tailored, priority-ranked Cloudflare recommendations (rationale + docs). Read-only — it proposes; the write builders queue. |

### Memory & collaboration

| Tool | Description |
| --- | --- |
| `remember` | Store a durable fact for the room. |
| `set_defaults` | Set the room's default account id / default zone. |

### Writes (queue only)

| Tool | Description |
| --- | --- |
| `add_domain` | Queue adding a domain/zone (`POST /zones`). Resolves the account, reuses a matching approval, and performs an exact account-filtered existence check when the room has a token. With no token, an explicit account id can still be queued for later Apply. |
| `create_dns_record` | Queue creating a DNS record. |
| `set_zone_setting` | Queue changing a zone setting. |
| `create_waf_custom_rule` | Queue adding a WAF custom rule to a ruleset. |
| `cf_write` | Queue JSON REST changes (POST/PUT/PATCH/DELETE) for products without a dedicated builder. It refuses `POST /zones`; use `add_domain` for zone creation. |

### Onboarding, discovery & migration

`update_onboarding`, `update_business_profile` (record the nature-of-the-business
answers that drive `recommend_configuration`), `list_migration_providers`,
`preview_provider_migration`, `queue_migration_rules`,
`generate_migration_terraform`, `migration_preflight`, `migration_diff_report`,
`export_migration_csv`.

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
  and contextual legacy tokens cannot be submitted through the normal composer;
  the server also redacts the room's exact stored token from persisted text parts.
  Structured chat events contain identifiers and outcomes, not message
  text or token values.
- **Access identity and room membership are mandatory.** Signed Access JWTs are
  validated for issuer, audience, signature, application type, email, subject, and
  expiry. Dynamic routing then checks `glide_room_members`; the URL identifies a
  room but does not authorize its holder. Agent WebSockets require an exact
  same-origin `Origin`; initial SDK protocol frames are suppressed until admission.
  The Worker rechecks membership and expiry after asynchronous connection/frame
  admission and uses a durable per-connection schedule to close idle expired
  sockets after hibernation. Active chat turns, response retries, and privileged
  Apply/token/archive/migration operations retain the exact socket-session lease;
  revocation, expiry, close, or same-id reconnect aborts or discards unfinished
  work before further room state is persisted. Authorization closes remount the browser access gate.
  HTML responses deny framing with CSP `frame-ancestors 'none'` and
  `X-Frame-Options`.
- **Room deletion is owner-gated and confirmed.** `destroyRoom` verifies the live
  connection identity, requires the caller's role to be `owner`, and requires the
  exact `DELETE THIS ROOM` phrase before it deregisters the room and calls
  `storage.deleteAll()`. Naming a room (`setRoomName`) is any-member and
  display-only. The deployment-wide **room registry** and `GET /api/rooms` are a
  convenience index for the employee-only admin list — not an authorization
  boundary; opening any listed room still requires that room's membership, and the
  registry lives in a reserved `__registry__` Durable Object that browser routes
  cannot reach.
- **Roles are least-privilege and every sensitive action is audited.** Each commit
  path runs through `requireCommitRole()`, which reads the caller's live role from
  `glide_room_members`: a **viewer** can read, chat, and queue proposals but is
  blocked from every commit; a **member** adds Apply and member invites; only an
  **owner** grants/changes roles and deletes the room, and the owner's own role is
  immutable. Invites, removals, role changes, applies, token changes, deletions,
  and employee inspections are appended to `glide_room_audit`, which is owner-gated,
  never synced, and self-prunes at 5,000 rows.
- **Employee oversight is read-only.** A verified Cloudflare employee who is not a
  member can inspect any room via `POST /api/room-inspect`, which returns a one-shot
  read-only snapshot (`inspectRoom()`) and never opens a socket. That path is
  deliberately separate from the members-only authorization gate, so widening
  inspection can never widen writes — every write RPC still independently requires
  membership. Each inspection is itself recorded to the audit trail.
- **Unknown-room probes do not reserve storage.** The API and Agent client use one
  shared, bounded display-to-storage-name mapping. Storage created only by a
  denied probe remains provisional and is destroyed after a final serialized
  member/data recheck. First-owner activation removes that marker atomically and
  uses an idempotency record when the Worker retries across a cleanup reset.
- **Authenticated traffic is bounded.** Dynamic HTTP requests have a 120/minute
  client-network bucket; WebSocket frames use a separate 120/minute verified-user
  bucket. Chat and selected expensive RPCs also have 20/minute identity and room
  buckets. Binary protocol frames close with `1003` and byte-oversized frames close
  with `1009` before limiter I/O, and
  one room cannot retain more than one protocol-frame limit of concurrent data.
  Keys are hashed and never logged. The counters are permissive,
  eventually consistent, and Cloudflare-location-local, so they are abuse
  reduction rather than exact accounting.
- **LLM-proposed writes always pass through a human.** The model can only queue;
  the server approval path is the only place a pending action executes. Bulk
  approval uses exact reviewed IDs, and uncertain outcomes require an individual
  live-state check and confirmation. Apply does not capture a local pre-mutation
  snapshot; ruleset-phase replacements re-read current rules and fail closed if
  that safety read fails.
- **Migration previews never write.** Glide only calls the migration tool's
  enabled read-only/export endpoints; it never triggers a direct deploy. Automated
  validation and snapshot/restore/rollback paths are disabled fail-closed. Preview
  sources/plans, checks, and Terraform/CSV artifacts are saved only while the
  initiating socket-session lease remains current.

> Full threat model, the encryption scheme (HKDF → AES-256-GCM), and operator
> recommendations: [docs/security.md](docs/security.md).

---

## Troubleshooting and logs

| Symptom | Expected recovery |
| --- | --- |
| Badge says **reconnecting** | Keep the draft in the composer and wait for **live** before sending. Hard-refresh after a deployment if it does not recover. |
| Request returns `429` / chat says too many messages | Stop retrying for about one minute. The response is not cached; automatic reconnects settle after the current window. |
| Request returns `503` with `rate_limit_unavailable` | Dynamic Agent traffic is failing closed because the binding could not be checked. Retry after 10 seconds and inspect `rate_limit.unavailable` logs if it persists. |
| Message was not delivered | Glide restores the original text to the composer; send it again only after **live** returns. |
| Assistant response was interrupted | Click **Retry response** after the room reconnects. Glide continues from the persisted user turn instead of duplicating it. |
| Response spinner stops progressing | Click **Stop**. After 20 seconds without progress, the composer also becomes usable again. |
| Token remains unverified | Open **Connection → Change**, confirm its scope and permissions, then replace it if authenticated account and zone reads both fail. |
| Add domain did not create a card | The zone may already exist or a matching approval may already be queued. Follow Glide's returned zone/pending id and review DNS or the existing action. |
| Apply was skipped or says outcome uncertain | Refresh and review queue changes. Verify live Cloudflare state before retrying an uncertain action individually; bulk apply intentionally excludes it. |

Production logs are available under **Workers & Pages → glide → Observability →
Logs** or from a terminal:

```bash
npx wrangler tail glide
```

Filter structured records by `glideEvent` and `room`. Chat lifecycle records can
also include `turnId`, `messageId`, `stage`, `outcome`, `kind`, and
`connectionEpoch`. Common events are `chat.received`, `chat.prepared`,
`chat.model_pass`, `chat.stream_created`, `chat.stream_finished`, `chat.error`,
`chat.client_issue`, `chat.secrets_redacted`, `rate_limit.exceeded`, and
`rate_limit.unavailable`.

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
- **UI:** inline React styles + a hand-written responsive `index.css` layer
  (restrained ambient light, matte glass, pointer glow, status rails) and Google
  Fonts — Space Grotesk (display), Inter (body), JetBrains Mono (code). No CSS framework.

# Onboarding & migration

Glide guides a team onto Cloudflare two ways: a **chat-led guided setup** (the
default) and, for teams leaving another vendor, a **read-only provider-migration
pipeline**. Along the way it also profiles the **nature of the business** to offer
tailored, docs-cited recommendations. Everything keeps the safety contract —
nothing changes until a human Applies a queued action.

- Chat-led setup: Glide asks one question at a time and records each answer; the
  sidebar checklist fills itself in. System prompt: `src/system-prompt.ts`.
- Chat opener + branch quick-replies: `GuidedIntro` and `startGuided()`
  (`src/client/main.tsx`).
- Opt-in form wizard: `OnboardingWizard` (`src/client/main.tsx`).
- Onboarding state/RPCs: `src/server.ts` (`startOnboarding`,
  `updateOnboarding`, `completeOnboarding`, `resetOnboarding`, …). Checklist
  auto-completion: `autoDoneSteps()` + `recomputeOnboardingChecklist()`.
- Restart: the sidebar **Reset** button clears onboarding via `resetOnboarding`
  (`src/client/main.tsx`).
- Business discovery + recommendations: the `update_business_profile` and
  `recommend_configuration` tools, the engine `src/recommendations.ts`, and the
  `RecommendationsPanel` (`src/client/main.tsx`); RPCs `updateBusinessProfile`,
  `resetBusinessProfile`, `queueRecommendation` (`src/server.ts`).
- Migration client: `src/migration.ts`; queueing logic: `src/server.ts`.

---

## Guided onboarding (chat-led by default)

Onboarding is **conversational**: Glide greets a new room and asks **one focused
question at a time** — migrate vs. fresh, domain, provider, goals, DNS setup,
and whether a token is connected — explaining the *why* and recording each answer
into the synced
`OnboardingState` with the `update_onboarding` tool. It is told never to re-ask
anything already captured (`src/system-prompt.ts`).

Glide never needs a token value in chat. When a credential is missing, it directs
the user to **Connection → Set token**; recognizable `cfat_...`, `cfut_...`, and
`cfk_...` values are blocked from the normal composer and redacted before persistence.

The empty-chat opener is three-way (`src/client/main.tsx`): if onboarding is
**completed** it shows a done card, if it is **active** (already started, but no
messages have hydrated yet) it shows an *"Onboarding in progress 👉"* resume hint
rather than re-asking the first question, and otherwise it shows the `GuidedIntro`
opener (`src/client/main.tsx`) with one-tap branch replies. Choosing a branch
calls `startGuided()` (also in `src/client/main.tsx`), which starts onboarding, pins
the branch, and hands the conversation to Glide. You can also kick it off from the
sidebar (**Start in chat**) or just type. To start over, the sidebar **Reset**
button clears onboarding via `resetOnboarding` (`src/client/main.tsx`, guarded
by a `window.confirm`).

### Opt-in form wizard

Prefer clicking through a form? The `OnboardingWizard`
(`src/client/main.tsx`) is available on demand — via **Use the guided form**
in the chat opener, or **Use form** in the sidebar — but it **no longer pops up
automatically**. It writes the same `OnboardingState` via the `updateOnboarding`
RPC, and **Finish & open chat** seeds the chat with a kickoff message describing
the plan (`finish()`, `src/client/main.tsx`).

#### First branch: migrate vs. fresh

Everything is tailored from one choice (the branch question / `key === "branch"`,
`src/client/main.tsx`):

- **Migrate from another provider** — pull existing WAF/CDN/DNS config into
  Cloudflare equivalents.
- **Start fresh on Cloudflare** — set up DNS, security, and performance from
  scratch.

#### Form step sequence

The step sequence depends on the path (`stepKeys`, `src/client/main.tsx`).
The `token` step is skipped when a token is already connected:

| Path | Steps |
| --- | --- |
| **migrate** | `branch → provider → scope → domain → config → [token] → review` |
| **fresh** | `branch → scope → domain → setup → [token] → review` |

Each step shows a **why** explanation (`WIZARD_COPY`, `src/client/main.tsx`).
The `review` step summarises captured answers and reminds you Glide only queues
changes.

### Connection and delivery during onboarding

The header badge is part of the workflow, not just decoration:

- Send only while it says **live**. During **reconnecting**, Glide retains the
  composer draft and blocks a send into the closed WebSocket.
- If a disconnect occurs after Send, the client checks the Durable Object's
  persisted transcript by message id. Undelivered text returns to the composer;
  a persisted user turn with no assistant reply offers **Retry response** without
  duplicating the user's message.
- Onboarding answers and checklist state are Durable Object state, so a reconnect
  or hard refresh does not reset progress. The sidebar **Reset** action is the
  explicit way to clear onboarding state.
- A deploy can interrupt an active response. Wait for **live** or hard-refresh
  before continuing after a deployment.

When a token is entered through the Connection panel or form wizard,
`setCloudflareToken` tries `/user/tokens/verify` and then account/zone reads. This
prevents a valid account-scoped token from being mislabeled solely because the
user-scoped verification endpoint returned 401/403. A green badge confirms one
authentication check, but migration preflight can still identify missing
product-specific permissions.

See [Troubleshooting & observability](./troubleshooting.md) for recovery details.

### DNS setup choices (`setup`)

| Option | Meaning |
| --- | --- |
| **Full (primary)** | Cloudflare is your authoritative DNS. Most common; the only option on Free/Pro. **Recommended.** |
| **Partial (CNAME)** | Keep your current DNS provider and proxy only specific subdomains. Business/Enterprise only. |
| **Not sure yet** | Glide recommends Full unless you have a reason not to. (Auto-completes the "choose DNS setup" step only once Full or Partial is picked.) |

### Goals (`scope`)

The selectable goals differ by path (`MIGRATE_GOALS` / `FRESH_GOALS`,
`src/client/main.tsx`): DNS, WAF/security, cache/performance, rate limiting,
load balancing or redirects, and Zero Trust (Gateway / Access).

### Onboarding checklist (auto-completing)

Once a path is chosen, `checklistForPath()` (`src/server.ts`) fills a live
checklist mirroring Cloudflare's recommended go-live path. **The checklist
completes itself as Glide gathers the required info** — you rarely tick a box by
hand:

- `autoDoneSteps()` (`src/server.ts`) derives which steps are done from the
  captured answers (domain set, Full/Partial DNS chosen, provider config
  previewed, scanned DNS records reviewed) **and** the action queue (a
  queued/applied SSL setting, WAF rule, or migration rules).
- It's applied on every onboarding update (`applyOnboardingPatch`,
  `src/server.ts`) and re-derived whenever the queue changes
  (`recomputeOnboardingChecklist`, also in `src/server.ts`, called from
  `queuePending` / `queueMigrationRules` / `finish`).
- `find_zone` / `add_domain` establish the target before downstream work.
  `add_domain` performs an exact lookup in the resolved account; when the zone
  already exists it saves that zone as the room default, queues no Add domain
  approval, and continues with `list_dns_records`. Otherwise it queues one
  `POST /zones` approval and reuses any matching pending/failed approval instead
  of creating a duplicate. See [Tools reference](./tools.md#writes--these-only-queue-a-pending-action).
- It only ever **adds** completions — manual checks and earlier auto-checks are
  sticky and never auto-unchecked. Reviewing scanned records via
  `list_dns_records` sets `dnsReviewed`, which ticks the "review DNS records" step.
- External, human-confirmed steps (lower TTLs, change nameservers, verify
  activation, coordinate DNSSEC, set proxy status) are still checked off
  explicitly — by the model via `update_onboarding`'s `checkOff`, or by clicking
  the box (`toggleOnboardingStep`).
- A successful `list_dns_records` turn cannot silently stop after rendering the
  records. If the model asks no real follow-up, the server runs one tool-less
  narration pass against the updated `dnsReviewed` state and, if needed, appends
  a deterministic question about which records should be proxied versus DNS-only.

**Migrate path:** identify domains → choose DNS setup → preview provider config →
review scanned DNS records → queue migrated rules → set SSL/TLS to Full (strict) →
lower TTLs before cutover → change nameservers at the registrar → verify
activation → coordinate DNSSEC.

**Fresh path:** identify domains → choose DNS setup → add/review DNS records → set
proxy status → configure WAF/security → set SSL/TLS to Full (strict) → lower TTLs
→ change nameservers → verify activation.

### Existing zones and zone-creation permissions

Do not infer that a domain is new from the onboarding checklist alone. Glide first
uses the token to look up the exact domain. If it exists, no **Add domain** card
should appear; the correct next step is to review its current DNS records. The
room remembers both the zone id and owning account id so a stale account default
cannot redirect a future creation request.

Creating a genuinely new zone requires **Zone > Zone > Edit** over **All
zones/domains**, because a not-yet-created domain cannot be selected as a specific
resource. Account API Tokens need this in a separate zone/domain-scoped policy,
not under **Entire Account**. See [Setup](./setup.md#cloudflare-api-token-permissions).

---

## Business discovery & tailored recommendations

Alongside the mechanical go-live, Glide works out the **nature of the team's
business** so it can recommend the settings that actually fit them. It asks
**probing questions one at a time** (never a questionnaire dump) — industry, app
type, whether users log in and whether an API is exposed, audience reach and
traffic profile, sensitive data, compliance regimes, and top concerns — recording
each answer with the `update_business_profile` tool into the room's
`businessProfile`. Capturing a profile changes **nothing** on the account; it is
only context for the recommendation engine. The loop is driven by the
"discovery → tailored config" block of the system prompt (`src/system-prompt.ts`)
and a rendered profile snapshot (`renderBusinessProfile()`, also in `src/system-prompt.ts`)
that tells the model which dimensions are still blank, so it never re-asks.

This runs during onboarding **and on-demand at any time** — if someone asks "what
should we turn on?", "how do we harden this?", or "make it faster", Glide runs the
same loop even after go-live. The profile lives at the room level (not inside
`OnboardingState`), so the advisor keeps working once onboarding is complete.

- **Chat backfill.** `inferBusinessProfileFromText()` (`src/server.ts`)
  deterministically recovers obvious answers from free text (e.g. "we take card
  payments") and merges them via `applyBusinessProfilePatch()` (`src/server.ts`).
  It only **fills blanks and unions arrays** — it
  never overwrites an explicit tool answer or flips a boolean to `false`.
- **Form step.** The opt-in wizard has a matching "nature of the business" step
  that writes the same state through the `updateBusinessProfile` RPC
  (`patchBusinessProfile()`, `src/client/main.tsx`).
- **Reset.** The sidebar **Reset** clears the captured profile via
  `resetBusinessProfile` (`src/client/main.tsx`, guarded by `window.confirm`).

### From profile to recommendations

Once there's enough signal — or the moment someone asks for advice — Glide calls
`recommend_configuration` (**read-only**; it proposes and queues nothing). The
deterministic engine `recommendConfigurations()` (`src/recommendations.ts`) maps
the profile to priority-ranked recommendations grouped by theme (security /
performance / reliability / privacy / bots / API / TLS), each with a plain-English
rationale, the profile signals that triggered it, and a Cloudflare docs citation.
Glide presents the relevant items, explains **why each fits**, and offers to
**queue** the concrete ones through the normal write builders — so recommendations
still pass through the human-Apply safety contract, and nothing plan-gated or
destructive is queued without confirmation.

The same engine drives the sidebar **Recommendations** panel (`RecommendationsPanel`,
`src/client/main.tsx`), which runs client-side against the synced profile:

- **Queue** (one-click) appears only for concretely queueable items and calls the
  `queueRecommendation` RPC. The client sends only the recommendation id and the
  room's default zone id; the server recomputes the set from the room's trusted
  `businessProfile` and rebuilds the exact call from its own catalog
  (`recommendationToPending()`), never from client-supplied input — see
  [Tools & RPC reference](./tools.md#business-discovery--recommendations) and the
  [Security model](./security.md).
- **Ask Glide** appears for everything else and hands the setup to chat
  (`askAboutRecommendation()`, `src/client/main.tsx`) so the model can do the
  required discovery first.

Only a narrow set is one-click queueable: `set_zone_setting` for `ssl`,
`always_use_https`, `min_tls_version`, `tls_1_3`, and `brotli`, plus the concrete
`cf_write` items for HSTS (`security_header`) and Tiered Cache (`argo/tiered_caching`).
WAF managed rules, rate limits, Bot Fight Mode, API Shield, Access, Argo, Load
Balancing, Data Localization, leaked-credential checks, and anything needing
discovery or a paid plan route to **Ask Glide** instead
(`isRecommendationQueueable()`, `src/recommendations.ts`). The captured profile and
its recommendations are also shown read-only in the `/admin` dashboard.

### `BusinessProfile` reference

`BusinessProfile` (`src/shared.ts`) — every field is optional so the profile
fills in gradually; the arrays default to `[]`:

| Field | Meaning |
| --- | --- |
| `industry` / `industryLabel` | Canonical vertical key (`ecommerce`, `saas`, `fintech`, `healthcare`, `media`, `gaming`, `government`, `education`, `nonprofit`, `marketing`, `api_platform`, `other`) + its human label (auto-derived). Freeform allowed. |
| `appTypes` | `website` / `web_app` / `api` / `mobile_backend` / `static_site` / `ugc`. |
| `audience` | `global` / `regional` / `internal` — drives caching/routing and Access. |
| `trafficProfile` | `low` / `steady` / `spiky` / `high_volume` — drives rate-limit and caching urgency. |
| `hasLogin` / `hasApi` | Whether the app has user auth, and whether it exposes an API. |
| `cacheableContent` | Whether a meaningful share of content is static/cacheable. |
| `sensitiveData` | `pii` / `payments` / `health` / `credentials` / `financial`. |
| `compliance` | `pci_dss` / `hipaa` / `gdpr` / `soc2` / `iso27001` / `fedramp`. |
| `concerns` | `bots` / `ddos` / `scraping` / `credential_stuffing` / `card_testing` / `fraud` / `latency` / `downtime` / `cost`. |
| `notes` | Freeform note that doesn't fit a structured field. |
| `completed` | Discovery marked complete for now. |
| `updatedBy` / `ts` | Attribution + timestamp. |

---

## Provider migration

If a team is moving off another vendor, Glide uses the migration tool to read
their **exported** config and translate it into Cloudflare rules. The whole
preview path is **read-only** — nothing changes until queued rules are Applied.

> Requires configured migration import (the `MIGRATION` service binding or
> `MIGRATION_API_URL`). Without one, the tools explain how to enable it and the
> rest of Glide keeps working. See [Setup](./setup.md#the-migration-service-binding).

### Supported providers

`akamai`, `fastly`, `imperva` (Incapsula), `zscaler_zia`, `zscaler_zpa`,
`prisma_access`, `cisco_umbrella`, `akamai_eaa`, `proofpoint`
(`PROVIDER_OPTIONS`, `src/client/main.tsx`). `list_migration_providers`
returns the authoritative list and each provider's phases at runtime.

CDN-style providers (`akamai`, `fastly`, `imperva`) are **zone-scoped** —
preflight and queueing need a target zone id (`CDN_MIGRATION_PROVIDERS`,
`src/server.ts`).

### Config input

Accepted formats: **JSON, XML, Terraform, PAN-OS** (`auto`-detected by default).
Config can be:

- pasted inline (`config`),
- uploaded as files in the wizard (`configFiles`) — multiple `.tf`/`.tfvars`/
  `.hcl` files are merged as a Terraform directory (`resolveConfigData()`,
  `src/server.ts`; format sniffing, `src/migration.ts`).

Inline and uploaded input is capped at 850,000 UTF-8 bytes so even worst-case
JSON escaping keeps its server-side source below the Durable Object SQLite row limit.

### The pipeline

1. **`preview_provider_migration`** — parse the export into Cloudflare-equivalent
   rules and store a `MigrationPlan` in the room (up to 300 rules, or fewer when
   required by the synced-state byte budget; the full raw config is kept
   server-side for export reuse). Truncated plans show retained versus total
   counts per phase.
2. **`migration_preflight`** _(recommended)_ — probe whether the configured token
   has the permissions the plan's provider needs, per phase. Read-only.
3. **`migration_diff_report`** _(recommended)_ — show what already exists in the
   target zone (migration-owned vs. manually created), plus IP lists and load
   balancers, so nothing is clobbered.
4. **`queue_migration_rules`** — convert supported retained rules into pending
   actions for human Apply (needs a `zoneId`; optional `phases` subset). A
   truncated plan queues only the visible subset; export Terraform for the full
   source. See the translation table below.
5. **`generate_migration_terraform`** / **`export_migration_csv`** — export the
   plan as Infrastructure-as-Code or CSV for phases best managed outside the
   queue. Downloaded from the sidebar.

After Apply, verify the reviewed Cloudflare rules and setting values directly.
Automated post-migration validation is disabled fail-closed because the migration
service does not compare complete live values.

### What `queue_migration_rules` can translate

`queueMigrationRules()` (`src/server.ts`) maps plan rule types to Cloudflare
API calls:

| Plan rule type | Cloudflare target | Fidelity |
| --- | --- | --- |
| `waf_custom`, `access_control` | `http_request_firewall_custom` phase entrypoint (`PUT`) | Faithful. Action mapped via `mapWafActionToCf()` (`src/server.ts`). |
| `rate_limit` | `http_ratelimit` phase entrypoint (`PUT`) | Rate parsed from the preview detail and snapped to a supported period (`10/60/120/300/600/3600`s). |
| `redirect` | `http_request_dynamic_redirect` | **Best-effort** — flagged "review before Apply". |
| `cache` | `http_request_cache_settings` | **Best-effort.** |
| `origin` | `http_request_origin` | **Best-effort.** |
| `request_header` | `http_request_late_transform` | **Best-effort.** |
| `response_header` | `http_response_headers_transform` | **Best-effort.** |
| `zone_setting`, `ssl_tls` | `PATCH /zones/<id>/settings/<id>` | Parsed from `setting = value`. |

Anything that can't be faithfully built (no expression, unparseable detail, etc.)
is **skipped and reported** for Terraform export instead — the tool tells the room
which phases were queued and which need review. Phases like load balancing and
Zero Trust are intentionally left to `generate_migration_terraform`.

### Entrypoint merging (don't drop existing rules)

WAF, rate-limit, and the best-effort ruleset phases are queued as a whole-phase
`PUT`. To avoid overwriting rules added since queueing, each carries a
`mergeEntrypoint` (`src/shared.ts`). At **Apply** time, `applyAction` re-reads
the phase's current rules and appends the new ones (`mergeEntrypointRules()`,
`src/server.ts`). If the current phase cannot be read safely, Apply fails
without writing and retains the action for correction; it never replaces the
phase from an empty baseline. Apply does not capture a local pre-mutation
snapshot. See [Security model](./security.md).

### Disabled validation and snapshot paths

Zone snapshot capture, listing, restore, and rollback are disabled because the
migration service cannot guarantee complete, fail-safe recovery. Glide exposes no
LLM tools or UI controls for these operations. `runValidate`, `snapshotZone`,
`refreshSnapshots`, and `restoreSnapshot` remain only as compatibility RPCs and
always return `{ ok: false }`; legacy restore approvals are refused by Apply. On
room startup, Glide drops the legacy local `glide_snapshots` breadcrumb table.

---

## Onboarding state reference

`OnboardingState` (`src/shared.ts`):

| Field | Meaning |
| --- | --- |
| `active` | An onboarding flow has been started. |
| `completed` | Guided setup finished. |
| `path` | `migrate` or `fresh`. |
| `domain` | Domain(s) being onboarded. |
| `setupType` | `full` / `partial` / `unsure`. |
| `migratingFrom` / `migratingFromLabel` | Provider key + human label. |
| `configProvided` | An exported config has been previewed. |
| `dnsReviewed` | Scanned DNS records have been reviewed (`list_dns_records` ran during onboarding). Auto-ticks the "review DNS records" step. |
| `goals` | What to migrate/set up. |
| `checklist` | Ordered go-live steps (tailored to `path`). **Auto-completes** from captured answers + the action queue; see `autoDoneSteps()` (`src/server.ts`). |
| `updatedBy` / `ts` | Attribution + timestamp. |

`MigrationPlan` (`src/shared.ts`) holds `provider`/`providerLabel`,
`totalRules`, per-phase counts, the (possibly truncated) `rules`, and attribution.
Each `MigrationPlanRule` gains `queued: true` once it's been turned into a pending
action (a dedup guard).

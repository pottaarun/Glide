# Onboarding & migration

Glide guides a team onto Cloudflare two ways: a **chat-led guided setup** (the
default) and, for teams leaving another vendor, a **read-only provider-migration
pipeline**. Both keep the safety contract — nothing changes until a human Applies
a queued action.

- Chat-led setup: Glide asks one question at a time and records each answer; the
  sidebar checklist fills itself in. System prompt: `src/system-prompt.ts:52`.
- Chat opener + branch quick-replies: `GuidedIntro` (`src/client/main.tsx:1148`)
  and `startGuided()` (`src/client/main.tsx:494`).
- Opt-in form wizard: `OnboardingWizard` (`src/client/main.tsx:1339`).
- Onboarding state/RPCs: `src/server.ts:920` onward (`startOnboarding`,
  `updateOnboarding`, `completeOnboarding`, `resetOnboarding`, …). Checklist
  auto-completion: `autoDoneSteps()` (`src/server.ts:217`) +
  `recomputeOnboardingChecklist()` (`src/server.ts:900`).
- Restart: the sidebar **Reset** button clears onboarding via `resetOnboarding`
  (`src/client/main.tsx:514`).
- Migration client: `src/migration.ts`; queueing logic: `src/server.ts:2392`.

---

## Guided onboarding (chat-led by default)

Onboarding is **conversational**: Glide greets a new room and asks **one focused
question at a time** — migrate vs. fresh, domain, provider, goals, DNS setup,
and whether a token is connected — explaining the *why* and recording each answer
into the synced
`OnboardingState` with the `update_onboarding` tool. It is told never to re-ask
anything already captured (`src/system-prompt.ts:52`).

Glide never needs a token value in chat. When a credential is missing, it directs
the user to **Connection → Set token**; recognizable `cfat_...` values are blocked
from the normal composer and redacted before persistence.

The empty-chat opener is three-way (`src/client/main.tsx:605`): if onboarding is
**completed** it shows a done card, if it is **active** (already started, but no
messages have hydrated yet) it shows an *"Onboarding in progress 👉"* resume hint
rather than re-asking the first question, and otherwise it shows the `GuidedIntro`
opener (`src/client/main.tsx:1148`) with one-tap branch replies. Choosing a branch
calls `startGuided()` (`src/client/main.tsx:494`), which starts onboarding, pins
the branch, and hands the conversation to Glide. You can also kick it off from the
sidebar (**Start in chat**) or just type. To start over, the sidebar **Reset**
button clears onboarding via `resetOnboarding` (`src/client/main.tsx:514`, guarded
by a `window.confirm`).

### Opt-in form wizard

Prefer clicking through a form? The `OnboardingWizard`
(`src/client/main.tsx:1339`) is available on demand — via **Use the guided form**
in the chat opener, or **Use form** in the sidebar — but it **no longer pops up
automatically**. It writes the same `OnboardingState` via the `updateOnboarding`
RPC, and **Finish & open chat** seeds the chat with a kickoff message describing
the plan (`finish()`, `src/client/main.tsx:1495`).

#### First branch: migrate vs. fresh

Everything is tailored from one choice (the branch question / `key === "branch"`,
`src/client/main.tsx:1548`):

- **Migrate from another provider** — pull existing WAF/CDN/DNS config into
  Cloudflare equivalents.
- **Start fresh on Cloudflare** — set up DNS, security, and performance from
  scratch.

#### Form step sequence

The step sequence depends on the path (`stepKeys`, `src/client/main.tsx:1367`).
The `token` step is skipped when a token is already connected:

| Path | Steps |
| --- | --- |
| **migrate** | `branch → provider → scope → domain → config → [token] → review` |
| **fresh** | `branch → scope → domain → setup → [token] → review` |

Each step shows a **why** explanation (`WIZARD_COPY`, `src/client/main.tsx:1272`).
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
`src/client/main.tsx:149`): DNS, WAF/security, cache/performance, rate limiting,
load balancing or redirects, and Zero Trust (Gateway / Access).

### Onboarding checklist (auto-completing)

Once a path is chosen, `checklistForPath()` (`src/server.ts:175`) fills a live
checklist mirroring Cloudflare's recommended go-live path. **The checklist
completes itself as Glide gathers the required info** — you rarely tick a box by
hand:

- `autoDoneSteps()` (`src/server.ts:217`) derives which steps are done from the
  captured answers (domain set, Full/Partial DNS chosen, provider config
  previewed, scanned DNS records reviewed) **and** the action queue (a
  queued/applied SSL setting, WAF rule, or migration rules).
- It's applied on every onboarding update (`applyOnboardingPatch`,
  `src/server.ts:844`) and re-derived whenever the queue changes
  (`recomputeOnboardingChecklist`, `src/server.ts:900`, called from
  `queuePending` / `queueMigrationRules` / `finish`).
- Adding the zone itself is queued with the `add_domain` tool (`POST /zones`),
  which resolves the target account for you; see [Tools reference](./tools.md#writes--these-only-queue-a-pending-action).
- It only ever **adds** completions — manual checks and earlier auto-checks are
  sticky and never auto-unchecked. Reviewing scanned records via
  `list_dns_records` sets `dnsReviewed`, which ticks the "review DNS records" step.
- External, human-confirmed steps (lower TTLs, change nameservers, verify
  activation, coordinate DNSSEC, set proxy status) are still checked off
  explicitly — by the model via `update_onboarding`'s `checkOff`, or by clicking
  the box (`toggleOnboardingStep`).

**Migrate path:** identify domains → choose DNS setup → preview provider config →
review scanned DNS records → queue migrated rules → set SSL/TLS to Full (strict) →
lower TTLs before cutover → change nameservers at the registrar → verify
activation → coordinate DNSSEC.

**Fresh path:** identify domains → choose DNS setup → add/review DNS records → set
proxy status → configure WAF/security → set SSL/TLS to Full (strict) → lower TTLs
→ change nameservers → verify activation.

---

## Provider migration

If a team is moving off another vendor, Glide uses the migration tool to read
their **exported** config and translate it into Cloudflare rules. The whole
preview path is **read-only** — nothing changes until queued rules are Applied.

> Requires a connected migration tool (the `MIGRATION` service binding or
> `MIGRATION_API_URL`). Without one, the tools explain how to enable it and the
> rest of Glide keeps working. See [Setup](./setup.md#the-migration-service-binding).

### Supported providers

`akamai`, `fastly`, `imperva` (Incapsula), `zscaler_zia`, `zscaler_zpa`,
`prisma_access`, `cisco_umbrella`, `akamai_eaa`, `proofpoint`
(`PROVIDER_OPTIONS`, `src/client/main.tsx:137`). `list_migration_providers`
returns the authoritative list and each provider's phases at runtime.

CDN-style providers (`akamai`, `fastly`, `imperva`) are **zone-scoped** —
preflight and queueing need a target zone id (`CDN_MIGRATION_PROVIDERS`,
`src/server.ts:146`).

### Config input

Accepted formats: **JSON, XML, Terraform, PAN-OS** (`auto`-detected by default).
Config can be:

- pasted inline (`config`),
- fetched from a URL (`configUrl`, read-only, capped at 2 MB), or
- uploaded as files in the wizard (`configFiles`) — multiple `.tf`/`.tfvars`/
  `.hcl` files are merged as a Terraform directory (`resolveConfigData()`,
  `src/server.ts:2297`; format sniffing, `src/migration.ts:152`).

### The pipeline

1. **`preview_provider_migration`** — parse the export into Cloudflare-equivalent
   rules and store a `MigrationPlan` in the room (rules capped at 300 in synced
   state; the full raw config is kept server-side for reuse). Summarises counts
   per phase.
2. **`migration_preflight`** _(recommended)_ — probe whether the configured token
   has the permissions the plan's provider needs, per phase. Read-only.
3. **`migration_diff_report`** _(recommended)_ — show what already exists in the
   target zone (migration-owned vs. manually created), plus IP lists and load
   balancers, so nothing is clobbered.
4. **`queue_migration_rules`** — convert supported rules into pending actions for
   human Apply (needs a `zoneId`; optional `phases` subset). See the translation
   table below.
5. **`generate_migration_terraform`** / **`export_migration_csv`** — export the
   plan as Infrastructure-as-Code or CSV for phases best managed outside the
   queue. Downloaded from the sidebar.
6. **`migration_validate`** — after Apply, verify the queued rule types actually
   exist in the zone (verified vs. missing).

Also: **`snapshot_zone`** captures a restore point before applying; restoring is a
human-only UI action (never automated).

### What `queue_migration_rules` can translate

`queueMigrationRules()` (`src/server.ts:2392`) maps plan rule types to Cloudflare
API calls:

| Plan rule type | Cloudflare target | Fidelity |
| --- | --- | --- |
| `waf_custom`, `access_control` | `http_request_firewall_custom` phase entrypoint (`PUT`) | Faithful. Action mapped via `mapWafActionToCf()` (`src/server.ts:311`). |
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
`mergeEntrypoint` (`src/shared.ts:28`). At **Apply** time, `applyAction` re-reads
the phase's current rules and appends the new ones (`mergeEntrypointRules()`,
`src/server.ts:2594`). If the current phase cannot be read safely, Apply fails
without writing and retains the action for correction; it never replaces the
phase from an empty baseline. A best-effort zone snapshot is also captured. See
[Security model](./security.md).

### Zone snapshots

`snapshotZone` / `restoreSnapshot` capture and roll back a full read-only zone
snapshot (rulesets, settings, IP lists, load balancers) via the migration tool's
store. **Restoring is destructive** and always a human-confirmed UI action
(`window.confirm`, `src/client/main.tsx:1024`) — Glide never auto-restores.

---

## Onboarding state reference

`OnboardingState` (`src/shared.ts:242`):

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
| `checklist` | Ordered go-live steps (tailored to `path`). **Auto-completes** from captured answers + the action queue; see `autoDoneSteps()` (`src/server.ts:217`). |
| `updatedBy` / `ts` | Attribution + timestamp. |

`MigrationPlan` (`src/shared.ts:291`) holds `provider`/`providerLabel`,
`totalRules`, per-phase counts, the (possibly truncated) `rules`, and attribution.
Each `MigrationPlanRule` gains `queued: true` once it's been turned into a pending
action (a dedup guard).

# Glide documentation

Deep-dive docs for **Glide** — a multi-user, real-time chat room that drives the
Cloudflare API with persistent memory. For the project overview, the safety
contract, and a quick start, see the [top-level README](../README.md).

These pages document how Glide actually works, drawn directly from the source in
[`src/`](../src). They're aimed at people running, extending, or auditing Glide.

## Contents

| Doc | What's inside |
| --- | --- |
| [Architecture](./architecture.md) | The Worker + `GlideAgent` Durable Object, room-name mapping, Access authorization and provisional-room lifecycle, room naming/deletion + the room registry (`GET /api/rooms`), per-room roles + audit table, the audited employee room-inspection path (`POST /api/room-inspect`), layered rate limiting, request/chat-turn and delivery lifecycles, the source-file map, synced state (incl. the governance & change-safety fields), SQLite tables, structured events, both RAG paths, the weekly cron, and `/admin`. |
| [Setup & configuration](./setup.md) | Prerequisites, local development, Access application and membership setup, every env var / secret and binding, rate-limit namespace/tuning details, Cloudflare-docs RAG, API-token permissions, and production deployment. |
| [Tools & RPC reference](./tools.md) | Every LLM tool (reads run, writes queue), rate-limited active client RPCs, and fail-closed compatibility stubs: approvals, token setup, invites + roles (`setMemberRole`) + audit log, room naming/deletion, delivery reports, onboarding, recommendations, migration, the governance & change-safety controls (posture, drift, blast-radius, auto-rollback, scheduled Apply, four-eyes, notifications), and guidance. |
| [Onboarding & migration](./onboarding-and-migration.md) | The guided wizard, rate-limit-safe retries, onboarding checklists (auto-ticked from live-zone state, with N/A steps), business discovery, tailored recommendations, and the read-only provider-migration pipeline. |
| [Security model](./security.md) | Signed Access identity, durable room ACLs and denied-probe cleanup, per-room roles (owner/member/viewer) + the audit trail, owner-gated room deletion, the employee-only room registry and read-only room inspection, at-rest token encryption, redaction, authenticated-traffic abuse controls, writes-always-through-a-human, the governance & change-safety controls, post-migration verify vs. the disabled recovery paths, and the threat model. |
| [Troubleshooting & observability](./troubleshooting.md) | LIVE/RECONNECTING recovery, `429`/`503` handling, authoritative delivery checks, structured events, production log queries, and incident workflow. |

## The one thing to remember

Glide's safety contract underpins every page here:

> **Reads run immediately. Every change is only _queued_. A human reviews and applies it.**

The LLM can inspect your Cloudflare account freely, but it can never call a
mutating Cloudflare endpoint. Creating/updating/deleting only appends a
`PendingAction` to the room's shared queue; an LLM-queued write reaches Cloudflare
only through the server approval path after a person reviews its request and
clicks **Apply**. Uncertain outcomes cannot be bulk retried. See [Security
model](./security.md) for the full guarantee, the governance & change-safety
controls, and the fail-closed disabled snapshot/recovery paths.

## Operational quick links

- A send vanished or the assistant never answered: [message delivery](./troubleshooting.md#message-delivery).
- A production turn needs tracing: [structured chat events](./troubleshooting.md#structured-chat-events).
- A request is returning `429` or `rate_limit_unavailable`: [rate limiting](./troubleshooting.md#rate-limiting).
- A token is unexpectedly unverified: [token verification](./troubleshooting.md#token-verification).
- A zone already exists, Add domain did not queue, or Apply was skipped:
  [approval and zone-creation recovery](./troubleshooting.md#approvals-and-zone-creation).
- The application stays on "Loading room...": [setup troubleshooting](./setup.md#troubleshooting).

## Conventions in these docs

- File references name the source path and usually the relevant symbol. Existing
  line numbers are snapshots and can drift as the implementation changes.
- "READ" vs "QUEUE" labels on tools mirror the safety contract: READ tools
  execute against Cloudflare now; QUEUE tools only add a pending action.
- Code-derived constants (caps, timeouts, retry counts) are cited with their
  source so they stay easy to verify when the code changes.

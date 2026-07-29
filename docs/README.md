# Glide documentation

Deep-dive docs for **Glide** — a multi-user, real-time chat room that drives the
Cloudflare API with persistent memory. For the project overview, the safety
contract, and a quick start, see the [top-level README](../README.md).

These pages document how Glide actually works, drawn directly from the source in
[`src/`](../src). They're aimed at people running, extending, or auditing Glide.

## Contents

| Doc | What's inside |
| --- | --- |
| [Architecture](./architecture.md) | The Worker + `GlideAgent` Durable Object, request/chat-turn and delivery lifecycles, the source-file map, synced state, SQLite tables, structured events, both RAG paths, the weekly cron, and the read-only `/admin` dashboard. |
| [Setup & configuration](./setup.md) | Prerequisites, local development, every env var / secret, the `VECTORIZE` and (optional) `MIGRATION` bindings, the Cloudflare-docs RAG + weekly cron, API-token permissions, and deploying to production. |
| [Tools & RPC reference](./tools.md) | Every LLM tool (reads run, writes queue), active client RPCs, and fail-closed migration compatibility stubs — approvals, token setup/re-verification, client delivery reports, onboarding, business discovery/recommendations, migration, and guidance. |
| [Onboarding & migration](./onboarding-and-migration.md) | The guided wizard, the onboarding checklists, business discovery → tailored recommendations, and the read-only provider-migration pipeline (preview → preflight → diff → queue → export). |
| [Security model](./security.md) | At-rest token encryption, chat and log redaction, the room-link-as-credential model, the writes-always-through-a-human guarantee, disabled migration recovery paths, and the threat model. |
| [Troubleshooting & observability](./troubleshooting.md) | LIVE/RECONNECTING recovery, authoritative delivery checks, structured event fields, production log queries, and an incident workflow. |

## The one thing to remember

Glide's safety contract underpins every page here:

> **Reads run immediately. Every change is only _queued_. A human reviews and applies it.**

The LLM can inspect your Cloudflare account freely, but it can never call a
mutating Cloudflare endpoint. Creating/updating/deleting only appends a
`PendingAction` to the room's shared queue; an LLM-queued write reaches Cloudflare
only through the server approval path after a person reviews its request and
clicks **Apply**. Uncertain outcomes cannot be bulk retried. See [Security
model](./security.md) for the full guarantee and the fail-closed disabled
validation/snapshot paths.

## Operational quick links

- A send vanished or the assistant never answered: [message delivery](./troubleshooting.md#message-delivery).
- A production turn needs tracing: [structured chat events](./troubleshooting.md#structured-chat-events).
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

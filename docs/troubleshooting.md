# Troubleshooting & observability

This runbook covers room connectivity, message delivery, token status, and the
privacy-safe events Glide emits in production. For implementation detail, see
[Architecture](./architecture.md); for credential handling, see
[Security](./security.md).

## Quick triage

| Symptom | First action |
| --- | --- |
| Header says **reconnecting** | Keep the draft in the composer and wait for **live**. Hard-refresh if this follows a deploy and the socket does not recover. |
| Sent text disappears | Wait for Glide's delivery check. An undelivered message is restored to the composer automatically. |
| User message remains but no assistant reply appears | Wait for **live**, then click **Retry response**. This continues the persisted turn without adding a duplicate user message. |
| Thinking indicator stops progressing | Click **Stop**. After 20 seconds without progress, Glide also unlocks the composer. |
| Token says **unverified** | Open **Connection → Change**, verify its account/resource scope, and replace it if account and zone reads both fail. |
| Add domain produced no approval | Check whether Glide found the zone already or returned an existing pending/failed approval. If it exists, review DNS instead of creating it again. |
| `POST /zones` says permission denied | Add Zone > Zone > Edit in an **All zones/domains** resource policy. For Account API Tokens, this must be a separate zone/domain-scoped policy, not Entire Account. |
| **Apply reviewed changes** skipped work | Refresh the queue. New, applying, stale-interrupted, or uncertain actions are deliberately excluded from the reviewed bulk snapshot. |
| Action says **outcome uncertain** | Inspect the live Cloudflare resource first, then use the individual **Retry anyway** control only if the change is absent. |
| A token was pasted outside the Connection form | Revoke and rotate it immediately, even if the transcript now shows a redaction marker. |

## Connection state

The header badge reflects the underlying Agent WebSocket:

- **live** means `readyState === WebSocket.OPEN`; chat sends are allowed.
- **reconnecting** means the socket is not open; Send is blocked and the current
  draft remains in the composer.
- **connecting...** in the token/status area means room state has not hydrated
  yet, which is distinct from chat transport readiness.

The client checks the socket twice: once before starting a send and again inside
the actual transport `send()` call. The second check catches a disconnect during
the asynchronous gap between clicking Send and writing the WebSocket frame.

A Worker deployment can interrupt an active Durable Object response. Avoid
deploying during live turns where practical. After deployment, wait for **live**
or hard-refresh before sending again.

## Message delivery

Every normal user send gets a generated message id and the current connection
epoch. If the connection changes or the local response is incomplete, Glide asks
the Durable Object for its persisted transcript and classifies the send:

| Status | Authoritative transcript | UI recovery |
| --- | --- | --- |
| `delivered` | The user message id exists and the next message is from the assistant. | Clear any delivery warning. |
| `not_delivered` | The user message id is absent. | Remove the optimistic bubble, restore its text to the composer, and wait for **live** before sending again. |
| `response_interrupted` | The user message exists with no following assistant message. | Show **Retry response**; retry continues from that user turn without duplicating it. |

If both the WebSocket and the transcript check are unavailable, delivery remains
unconfirmed. Do not manually paste and resend the same text while reconnecting;
wait for **live**, then use the offered retry path. Client incident reporting is
best-effort because its RPC also needs a working connection.

The **Stop** button cancels a live or wedged response. A 20-second no-progress
timer also marks the turn stalled and re-enables the composer; it does not delete
the persisted user message.

## Token verification

Token status uses a layered authentication check:

1. Try `/user/tokens/verify`.
2. If it fails, try an authenticated `/accounts` read.
3. If that fails, try an authenticated `/zones` read.
4. Mark the token unverified only when all three checks fail.

The fallbacks are required because `/user/tokens/verify` is user-scoped and can
return 401/403 for a valid account-scoped token. When a room connects with a
stored token already marked unverified, the client calls `reverifyToken` once so
an old false negative can repair itself.

A verified badge means authentication succeeded, not that the token can access
every product or resource. If one operation fails, use its permission hint and
confirm that the token's account/zone resource scope includes the target.

Enter tokens only under **Connection**. The chat client blocks recognizable
`cfat_...`, `cfut_...`, and `cfk_...` strings, and the server redacts matching
values before persistence and when old rooms wake. Redaction is not revocation:
rotate any exposed credential.

## Approvals and zone creation

### Add domain did not queue

`add_domain` intentionally returns without creating a new card in these cases:

- The exact domain already exists in the resolved Cloudflare account. Glide saves
  it as the room default; continue with DNS-record review.
- A matching Add domain action is already pending, applying, or retained after a
  failure. Use the existing card and its displayed pending id.
- The account cannot be resolved safely, the selected legacy zone cannot be
  verified, or the duplicate lookup fails. Fix the target/token instead of
  asking Glide to queue blindly.

If a genuinely new domain fails at Apply with a permission error, do not look for
an internal `com.cloudflare.api.account.zone.create` permission. For an Account
API Token, add a separate policy scoped to **All zones/domains** and grant **DNS &
Zones > Zone > Edit**. For a user API token, use **Zone > Zone > Edit** with Zone
Resources set to **All zones**. A domain that does not exist yet cannot be selected
as a specific-zone resource.

### Apply and Retry behavior

**Apply reviewed changes** is snapshot-based. The browser sends only the IDs shown
when you confirmed; the server never adds newly queued actions. It also excludes
an action if another teammate started it, its prior attempt became stale, or its
outcome is uncertain. Refresh and review again when the UI reports that the queue
changed.

An uncertain outcome means Cloudflare may have committed the write even though
Glide did not receive a definitive response. Bulk apply never retries it. Inspect
the live zone/account configuration first. If the requested state is absent, use
the individual **Retry anyway** button and confirm the warning; otherwise reject
or leave the historical result without sending a duplicate write.

## Structured chat events

Workers Observability is enabled in `wrangler.jsonc`. View production records at
**Workers & Pages → glide → Observability → Logs**, or stream them locally:

```bash
npx wrangler tail glide
```

Filter by `glideEvent` and `room` first, then correlate one turn or message with
the optional fields below.

| Field | Meaning |
| --- | --- |
| `glideEvent` | Stable event name. |
| `room` | Durable Object room name; normally the URL hash value. |
| `turnId` | Server-generated id shared by lifecycle events for one assistant turn. |
| `messageId` | Client-generated user-message id or `unknown`. |
| `stage` | Last model/orchestration stage reached. |
| `outcome` | `completed`, `aborted`, or `error` for a finished stream. |
| `kind` | Client classification: `not_delivered`, `response_interrupted`, or `unknown`. |
| `connectionEpoch` | Client-side disconnect generation captured when the message was sent. |

| Event | Meaning |
| --- | --- |
| `chat.received` | The server received a turn and assigned a `turnId`. |
| `chat.prepared` | Onboarding inference and both RAG lookups completed; includes guidance/docs counts. |
| `chat.model_pass` | A model pass completed; includes stage, chunk count, text length, and queued-action count. |
| `chat.onboarding_nudge` | A successful DNS-record read ended without a concrete user hand-off, so Glide forced the next onboarding question. |
| `chat.stream_created` | The server returned the UI message stream. |
| `chat.stream_finished` | Stream execution ended; inspect `stage` and `outcome`. |
| `chat.error` | Stream execution threw; includes a bounded error name/message, not chat text. |
| `chat.client_issue` | The browser classified a send as missing or response-interrupted. Best-effort only. |
| `chat.secrets_redacted` | Startup scrub rewrote historical messages containing recognizable Cloudflare API tokens. |

These application events intentionally omit user/assistant message text and token
values. Do not add ad hoc body logging during an incident. Platform-generated
request or exception metadata should still be protected with normal dashboard
access and retention controls.

## Incident workflow

1. Record the UTC time, room hash, visible connection badge, and user-visible
   error. Never ask for or record the token value.
2. Filter logs to that `room` and a narrow time range. Find `chat.received`, then
   follow its `turnId` through the lifecycle events.
3. If there is no `chat.received`, the turn did not reach `onChatMessage`; look for
   a client delivery warning. `chat.client_issue` may also be absent when the
   connection was too broken to report it.
4. If `chat.received` exists without `chat.stream_created`, inspect preparation or
   model errors. If a stream was created without `chat.stream_finished`, suspect a
   deployment, Durable Object eviction, or connection interruption.
5. If `chat.stream_finished` has `outcome: "error"`, use the matching `chat.error`
   stage and bounded error metadata. If it completed, inspect the authoritative
   transcript in the room or `/admin#<room>` before assuming the UI bubble is real.
6. Recover through the UI: wait for **live**, resend a restored draft, use **Retry
   response** for a persisted user turn, or use **Stop** for a stalled stream.
7. If secret exposure is involved, revoke and rotate the credential after the
   transcript scrub; do not rely on redaction alone.

Before deploying a fix, run:

```bash
npm run check
npm test
npm run build
```

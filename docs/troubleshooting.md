# Troubleshooting & observability

This runbook covers room connectivity, rate limiting, message delivery, token
status, and the privacy-safe events Glide emits in production. For implementation detail, see
[Architecture](./architecture.md); for credential handling, see
[Security](./security.md).

## Quick triage

| Symptom | First action |
| --- | --- |
| Header says **reconnecting** | Keep the draft in the composer and wait for **live**. Hard-refresh if this follows a deploy and the socket does not recover. |
| HTTP response is `429` / chat says too many messages | Stop retrying for about one minute. Respect `Retry-After: 60`; let a closed WebSocket reconnect before submitting once. |
| HTTP response is `503` with `rate_limit_unavailable` | Retry after 10 seconds. If it persists, confirm both rate-limit bindings exist on the active version and inspect `rate_limit.unavailable` logs. |
| HTTP response is `503` with `access_not_configured` | Set the active Worker's `TEAM_DOMAIN` and `POLICY_AUD` from the Access application; do not enable the local bypass in production. |
| HTTP response is `503` with `access_keys_unavailable` | Respect `Retry-After: 10`, then verify the team cert endpoint and inspect `access.jwks_unavailable`. Do not recategorize it as an invalid user session. |
| HTTP response is `401`/`403` before a room opens | Complete Access login, then verify the app hostname, team domain, audience, and token expiry. |
| HTTP response is `403 invalid_origin` | Use Glide from its own hostname. Room activation and Agent WebSockets reject missing or foreign browser origins. |
| Access login succeeds but the room denies membership | Use the exact invited email. External users cannot create rooms; another employee also needs an invite once the room has an owner. |
| A custom legacy room id returns `404 legacy_room_not_found` | Confirm the old link. Route-compatible non-control display ids up to 200 characters are lookup-only, must serialize within the 1,024-byte storage-name limit, and cannot create a new empty room. |
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

The connection carries canonical Access email, JWT expiry, schedule metadata, and
opaque subject/client digests; it never persists the raw subject. Initial SDK
protocol frames are suppressed until same-origin membership admission. The server
checks membership and expiry before and after every inbound frame's asynchronous
limiter and creates a durable schedule at JWT `exp`, so an idle socket is closed
even after room hibernation.

A `1008` close with `Room membership or Access session expired` requires a fresh
Access session or restored ACL membership. `1008 Room membership revoked` means
the owner removed that member. `1011 Unable to enforce Access session expiry`
means schedule creation failed; retry only after the service is healthy.
`1003` means a client sent an unsupported binary protocol frame; `1009` means one
frame or the room's concurrently admitted protocol data exceeded its byte budget.
The browser remounts the access gate and clears room-scoped UI state after `1008`.
For `1006`, it lets the SDK reconnect while performing a bounded inspect-only
membership check; only a definitive `401`/`403`/`404` remounts the gate. A network
outage therefore does not turn every transient disconnect into an activation POST.

The client checks the socket twice: once before starting a send and again inside
the actual transport `send()` call. The second check catches a disconnect during
the asynchronous gap between clicking Send and writing the WebSocket frame.

A Worker deployment can interrupt an active Durable Object response. Avoid
deploying during live turns where practical. After deployment, wait for **live**
or hard-refresh before sending again.
An authorization close, revocation, expiry, or same-id reconnect also aborts the
old socket's active chat/retry work and discards late tool or migration results.

## Rate limiting

Access and durable room membership authorize users; rate limiting independently
bounds dynamic work. Hashed JavaScript and CSS assets do not consume these counters.

| Surface | Limit and rejection | Recovery |
| --- | --- | --- |
| Dynamic HTTP routes requiring auth, including root/session/room checks, WebSocket handshakes, and `/get-messages` | 120 per 60 seconds per hashed client network. Exhaustion returns non-cacheable JSON `429` with `Retry-After: 60`. | Stop refresh/reconnect loops and wait one minute. The browser keeps drafts local and retries authoritative hydration. |
| Inbound Agent WebSocket frames, including callable RPCs | A separate 120 per 60 seconds per verified Access identity. Exhaustion closes the socket with code `1013`. | Let automatic reconnection restore **live**; do not repeatedly click the same control while disconnected. The rejected frame was not dispatched. |
| Chat submissions | 20 per 60 seconds per verified Access identity, then 20 per 60 seconds per hashed room. | The server returns a chat error before persistence. Wait one minute, confirm **live**, and submit the preserved text once. |
| Response retry and guidance add/delete/reindex RPCs | The same 20-per-60-second identity and room budgets, checked before mutation or expensive work. | Wait one minute; the rejected RPC returns a bounded error and leaves transcript/guidance state unchanged. |
| Any dynamic binding check that throws | HTTP returns non-cacheable JSON `503` with `Retry-After: 10`; a socket closes with `1013`, or chat receives a bounded unavailable error. | Retry after 10 seconds. Persistent failures indicate a deployment/binding problem, not a reason to bypass the check. |

The network, Access-subject, and room rate-limit identifiers are SHA-256 digests;
no raw `CF-Connecting-IP`, Access subject, room name, or rate-limit digest is logged.
Structured events use an opaque Durable Object id for room correlation. Cloudflare Rate Limiting is
permissive, eventually consistent, and location-local, so a short burst may pass
over the nominal value. Corporate/mobile NAT users can share the HTTP-admission
bucket, but authenticated frame/chat buckets are separated by Access subject.
If legitimate teams routinely hit a limit, use `scope` in structured events to
identify the layer, confirm expected traffic, then tune both Wrangler configs and
`src/rate-limits.ts`; do not disable the check ad hoc.

Useful scopes are:

| `scope` | Gate |
| --- | --- |
| `agent_request` | Worker-entry dynamic authenticated-route request check. |
| `agent_protocol` | Inbound WebSocket frame check. |
| `chat_client` | Chat submissions or selected expensive RPCs across one Access identity's rooms. |
| `chat_room` | Aggregate chat submissions in one room. |

## Message delivery

Every normal user send gets a generated message id and the current connection
epoch. If the connection changes or the local response is incomplete, Glide asks
the Durable Object for its persisted transcript and classifies the send:

| Status | Authoritative transcript | UI recovery |
| --- | --- | --- |
| `delivered` | The user id exists and a correlated assistant message records `responseTo: <user id>` plus `delivery: "completed"`. | Clear any delivery warning. |
| `not_delivered` | The user id is absent from both retained history and the permanent accepted-id ledger. | Remove the optimistic bubble, restore its text to the composer, and wait for **live** before sending again. |
| `response_interrupted` | The user message exists without a correlated completed assistant response. | Show **Retry response**; retry continues from that user turn without duplicating it. |
| `accepted_pruned` | The id has aged out of retained history but remains in the accepted-id ledger. | Do not restore or resend it; explain that Glide already accepted the older turn. |

If both the WebSocket and the transcript check are unavailable, delivery remains
unconfirmed. Do not manually paste and resend the same text while reconnecting;
wait for **live**, then use the offered retry path. Client incident reporting is
best-effort because its RPC also needs a working connection.

The **Stop** button cancels a live or wedged response. A 20-second no-progress
timer also marks the turn stalled and re-enables the composer; it does not delete
the persisted user message.

## Legacy room-history migration

An upgraded room can temporarily show **migration** instead of **live**. During
this state Glide returns a structured 503 for transcript reads, rejects chat
submissions server-side, and keeps the composer draft safe. The client polls the
durable migration status and reloads authoritative history automatically when it
becomes ready.

| Status | Meaning | Operator action |
| --- | --- | --- |
| `migrating` | The quarantined legacy transcript is being redacted in bounded scheduled batches, or `GLIDE_TOKEN_KEY` is unavailable. | Wait. If the message mentions `GLIDE_TOKEN_KEY`, restore the correct Worker secret instead of deleting history. |
| `recovery_required` | A stored token exists but cannot decrypt, so exact-token redaction cannot continue. | Confirm the old key cannot be restored, then use the recovery control under **Connection**. |
| `discarding` | Confirmed recovery is deleting only the unrecoverable legacy archive in bounded background batches. | Keep the room open; status polling recreates a missing schedule and unlocks the room when complete. |
| `ready` | Sanitization and the durable completion marker both succeeded. | No action; Glide rehydrates the authoritative transcript. |

Recovery is intentionally destructive. It appears only for the durable
token-decryption-failed state and requires typing
`DISCARD LEGACY CHAT ARCHIVE` exactly. It preserves current retention archives
and permanent replay tombstones, but the old legacy transcript itself cannot be
restored through Glide. If the previous `GLIDE_TOKEN_KEY` is recoverable, restore
that key and let migration continue instead.

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

Filter by a narrow time range and `glideEvent`, identify the relevant opaque `room`
value, then correlate one turn or message with the optional fields below.

| Field | Meaning |
| --- | --- |
| `glideEvent` | Stable event name. |
| `room` | Opaque Durable Object id used only for stable log correlation; never the display/storage room name. |
| `turnId` | Server-generated id shared by lifecycle events for one assistant turn. |
| `messageId` | Client-generated user-message id or `unknown`. |
| `stage` | Last model/orchestration stage reached. |
| `outcome` | `completed`, `aborted`, or `error` for a finished stream. |
| `kind` | Client classification: `not_delivered`, `response_interrupted`, or `unknown`. |
| `connectionEpoch` | Client-side disconnect generation captured when the message was sent. |
| `scope` | Rate-limit gate: `agent_request`, `agent_protocol`, `chat_client`, or `chat_room`. |

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
| `rate_limit.exceeded` | A configured bucket denied work. Includes only `scope` and safe request/room correlation already used by Glide logs. |
| `rate_limit.unavailable` | A binding call failed and dynamic traffic failed closed. Persistent occurrences require deployment/binding inspection. |
| `access.jwks_unavailable` | The configured Access signing-key endpoint timed out or returned unusable data. The request failed closed with retryable `503`. |

These application events intentionally omit user/assistant message text and token
values. Do not add ad hoc body logging during an incident. Platform-generated
request or exception metadata should still be protected with normal dashboard
access and retention controls.

## Incident workflow

1. Record the UTC time, room hash, visible connection badge, and user-visible
   error. Never ask for or record the token value.
2. Filter a narrow time range for `chat.received`, identify the matching opaque
   `room`, then follow its `turnId` through the lifecycle events.
3. If there is no `chat.received`, the turn did not reach `onChatMessage`; check
   `rate_limit.exceeded` / `rate_limit.unavailable` before treating it as a lost
   delivery, then look for a client warning. `chat.client_issue` may also be absent
   when the connection was too broken to report it.
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

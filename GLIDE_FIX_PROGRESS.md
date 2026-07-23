# Glide — Fix & Redesign Progress

> Living work log so this task can be resumed if the session is lost.
> Last updated by the coding agent. Check the checklist boxes below for current state.
> Original fix + redesign is COMPLETE. Latest product change: **Follow-up 11** at the bottom — delivery-aware chat transport, **live/reconnecting** state, server-authoritative send verification, **Retry response**, privacy-safe structured logs, and chat-token redaction. Production Version `4c424a24-f116-4f60-b84c-e40fbe2ab1e4`, client bundle `index-BYMoMOJD.js`; `npm run check` and all **17/17** tests passed.

## Goal
1. Fix raw tool-call JSON leaking into the assistant chat message.
2. Make the Glide chat UI polished/appealing — **fuller redesign** on the current dark + orange brand.

## Decisions (confirmed for the original redesign; later follow-ups supersede where noted)
- **Deploy:** Build & deploy now to `glide.arunpotta1024.workers.dev` (`npm run build` then `npm run deploy`).
- **Original tool-reliability decision (superseded):** The first redesign kept `@cf/meta/llama-3.3-70b-instruct-fp8-fast`; a later follow-up moved production to `@cf/openai/gpt-oss-120b` for reliable function calling.
- **UI scope:** Fuller redesign (rework layout + visual language), stay on brand (dark `#0a0e1a`, orange `#f97316` / amber `#fbbf24`, Inter + JetBrains Mono).

## Diagnosis (root cause)
- The model intermittently emits a tool call as **plain text** (schema-shaped params like `{"type":"string","value":"fresh"}`), instead of a structured tool call.
- Because it's text, the AI SDK never parses/executes it → `update_onboarding` never runs → the right-side checklist never ticks. So the JSON leak AND the "checklist stuck" symptom share ONE root cause.
- The model *does* support function calling; this is a known intermittent failure of the quantized `fp8-fast` variant.
- Client `stripToolCalls` already detects/strips this shape; the **deployed build is stale** (screenshot chips `⊙` vs current code `⚙`), so a rebuild+redeploy also removes the visible leak.

## Fix plan
- **Server** (`src/system-prompt.ts`): add an explicit rule — never print tool-call JSON / `<tool_call>` / `{"type":"function",...}` in chat; use the native tool mechanism only.
- **Client** (`src/client/main.tsx`): verify + harden `stripToolCalls` / `toolCallName` / `scanJsonObject` to robustly strip the exact leaked shape (handle both `parameters` and `arguments`, and any leading prose).
- **UI** (`src/client/main.tsx` inline `S` styles + `src/client/index.css`): fuller redesign of layout, message bubbles, tool chips, checklist, composer, sidebar.
- **Ship:** `npm run build`, then `npm run deploy`.

## Task checklist
- [x] Map the UI: full client render, `S` styles object, `index.css`, `index.html`
- [x] Server: add system-prompt guard forbidding tool-call JSON as text
- [x] Client: harden `stripToolCalls` for the exact leaked shape (strips empty code-fence scars too)
- [x] Fuller UI redesign: layout + bubbles + tool chips + checklist + composer + sidebar (S chunks 1–4)
- [x] Update `index.css` global layer to match redesign (animated thinking dots)
- [x] `npm run build` — verify compile/types
- [x] `npm run deploy` — push live

**STATUS: COMPLETE ✅** — all boxes done; live at https://glide.arunpotta1024.workers.dev

## Key files
- `src/server.ts` — Worker + `GlideAgent` DO: model orchestration, tools/RPCs, approvals, persistence sanitization, and structured chat events.
- `src/client/main.tsx` — React chat/admin client: delivery-aware transport, connection recovery, onboarding, approvals, and inline UI styles.
- `src/chat-delivery.ts` — delivery classification plus Cloudflare token detection/redaction helpers.
- `src/cf-api.ts` — Cloudflare API client and layered token verification.
- `src/client/index.css` — global visual layer (fonts, aurora, interactions, motion, scrollbars).
- `src/system-prompt.ts` — room-aware system prompt and safety/tool-use contract.
- `src/shared.ts` — shared room, action, onboarding, migration, and docs-index types.
- `tests/` — action lifecycle, chat integrity, Cloudflare API verification, and delivery/redaction regressions.
- `wrangler.jsonc` — DO, AI, Vectorize, assets, observability, cron, and model bindings.

## How to resume
1. Read the latest follow-up at the bottom; the original checklist is historical and complete.
2. Run `npm run check`, `npm test`, and `npm run build` before shipping changes.
3. Deploy outside active chat turns, then hard-refresh and wait for **live** before production verification.

## Notes / log
- **Edit 1** `src/system-prompt.ts`: added guard bullet — never write a tool call as chat text (`{"type":"function",…}`, `{"name":…,"parameters":…}`, `"arguments":…`, `<tool_call>`/`<function_call>`, schema echoes); a text tool call does NOT run.
- **Edit 2** `src/client/main.tsx` `stripToolCalls`: final return now also cleans empty code-fence scars — `.replace(/```[a-zA-Z0-9]*\s*```/g,"").replace(/\n{3,}/g,"\n\n").trim()`.
- **Redesign** `S` object (main.tsx L1755+) rewritten in 4 chunks to a unified palette: base `#0a0e1a`, surface `#0d1424`, card `#111a2e`, AI bubble `#131d33`, user bubble `#18233b`/`#2c3a57`, mine/selected warm `#2a1c0c`/`#7c4a12`, hairline `#1e2a44`, text `#e5e7eb`/muted `#94a3b8`/faint `#64748b`, accent gradients `#f97316→#fbbf24` with ink `#0a0e1a`. Added `avatar`/`avatarAi`/`avatarUser`/`avatarMine` (were referenced, never defined) and `bubble.animation:"glideIn …"`.
- **Thinking indicator**: busy JSX now renders `<div className="glide-dots">` (3 spans); `index.css` gained `.glide-dots` + `@keyframes glideBounce` (replaced the unused `glidePulse`). `glideIn` keyframe already fade+translateY+scale.
- **Build**: clean (`vite build`, 167 modules; only the >500 kB chunk-size warning, benign).
- **Deploy**: `wrangler 4.105.0` → https://glide.arunpotta1024.workers.dev — Version ID `9c1476ac-6480-4c6f-9965-181fb60cef4e`; assets `index-C8rvEey3.css`, `index-B5XMBOE-.js`. Bindings intact (GlideAgent DO, AI, ASSETS, GLIDE_MODEL=llama-3.3-70b-instruct-fp8-fast). Fresh build replaces the stale `⊙` bundle → visible JSON leak gone.

---

## Follow-up: onboarding stall after `list_migration_providers`

### Symptom
User reported the assistant getting "stuck" right after `list_migration_providers` during first-run onboarding.

### Diagnosis
1. **Stale cached bundle (primary).** The screenshot showed the old `⊙` tool-chip glyph; current source (`main.tsx` `⚙ {t}`) and the deployed JS both use `⚙`. Prod was already serving the fixed bundle (`index-B5XMBOE-.js` → HTTP 200, contains `⚙` only). → user needs a hard refresh (Cmd+Shift+R / incognito).
2. **Not a thrown tool.** `list_migration_providers` uses `migrationTransport()` → `listMigrationProviders()` → `call()` in `src/migration.ts`, which **never throws** — it always resolves `{ok:false,message}` (NOT_CONFIGURED / timeout via AbortController / non-OK). So the tool didn't kill the turn.
3. **Multi-step is enabled.** `streamText` has `stopWhen: stepCountIs(8)` (server.ts:807), so it wasn't a missing-maxSteps stall.
4. **Migration tooling is disabled in this workspace by design.** `MIGRATION` service binding is commented out (`wrangler.jsonc:20`) and `MIGRATION_API_URL` is unset → `migrationConfigured()` false → every migration tool returns NOT_CONFIGURED. The onboarding prompt led its migration sub-flow with `list_migration_providers` (a disabled tool) as Step 1 → poor first-run.

### Fix (user chose "reorder onboarding")
- `src/system-prompt.ts` **Edit A** (onboarding Q3, L44): softened "This unlocks the migration flow" → "*If provider-config import is connected (see 'Migration tool' below), this unlocks the migration flow; either way you can still run a standard DNS-first go-live.*"
- `src/system-prompt.ts` **Edit B** (migration sub-flow, L60–65): added a leading **Not-connected guard** — if the "Migration tool" status is *Not connected*, do NOT call any migration tool; explain import isn't enabled and continue on the standard DNS-first go-live path. **Reordered** the steps so Step 1 is now **"Establish the target first"** (`list_accounts`/`list_zones`/`find_zone` — all working tools), and `list_migration_providers` is demoted to an optional aside inside Step 2 (`preview_provider_migration`), only when the tool is connected.
- Server-only change → client bundle byte-identical (asset hashes unchanged; "No updated asset files to upload" on deploy).

### Ship
- `npm run build` clean (167 modules). `npm run deploy` → **Version ID `44469f3c-092e-4a79-a8d2-710336dc49b1`**. Prod verified: HTML → `index-B5XMBOE-.js`, JS HTTP 200.
- **User action still required:** hard-refresh the browser tab to drop the stale cached client bundle.

---

## Follow-up 2: onboarding stall generalized (bare tool call → lone chip)

### Symptom
Assistant still looked "stuck" on first-run onboarding (and could recur on migration), showing a lone `⚙` tool chip with no message.

### Diagnosis (confirmed by reading code, not guessing)
- The chip renders from a **real structured tool part** (`tool-update_onboarding`), not from stripped text — `messageText()` in `main.tsx` pushes tool NAMES from `dynamic-tool`/`tool-*` parts, and the render guard `{text && …}` (main.tsx:572) hides the text div when there is none, leaving only the chip (main.tsx:574).
- Root cause is **model-side**: the fp8-fast model ends its turn *on* the `update_onboarding` tool call and never emits follow-up prose. Multi-step IS enabled (`stopWhen: stepCountIs(8)`, server.ts:807) and the tool returns a clean non-throwing string (server.ts:1085), so the SDK loops fine — the model's next generation is just empty. This lives on the Durable Object, so it stalls even with a fresh client.
- Secondary: `env.ASSETS.fetch` set no `Cache-Control`, so `index.html` could be served stale → the recurring "old `⊙` bundle" confusion.

### Fix (4 durable edits)
1. **`src/system-prompt.ts`** — new hard rule right after the "never write tool calls as chat text" bullet: *"Always end your turn with words — never with a bare tool call,"* explicitly calling out `update_onboarding` (record → narrate next step). Escaped backticks used.
2. **`src/server.ts` `update_onboarding` execute return (L1083–1090)** — reworded to a model-directed nudge: `"…Now reply to <actor> in plain conversational prose: confirm what you recorded, briefly explain this step, and ask the single next question. Do NOT emit JSON or call another tool unless their next answer requires one."` (uses `this.currentActor`).
3. **`src/client/main.tsx` render (~L576)** — safety net: when a non-user message has tool chips but empty text, render a muted italic line *"Working on that… say 'continue' if this pauses."* so it never looks dead.
4. **`src/server.ts` `fetch` (L2046)** — wrap `env.ASSETS.fetch`; if `content-type` is `text/html`, set `Cache-Control: no-cache` (hashed JS/CSS stay immutable). Kills stale-bundle recurrence.

### Ship
- `npm run build` clean (167 modules) → new client bundle **`index-D2lnmkgS.js`** (was `index-B5XMBOE-.js`; CSS unchanged `index-C8rvEey3.css`). `npm run check` shows only the pre-existing tsc-only `./index.css` side-effect-import warning (main.tsx:29) — Vite handles it; unrelated to these edits.
- `npm run deploy` → **Version ID `4a8bcfd2-7c04-44bc-85fa-d8eadf7c7d6f`**.
- Prod verified via curl: `/` → `cache-control: no-cache` + references `index-D2lnmkgS.js`; new JS HTTP 200 and contains the "Working on that" fallback. (Old `index-B5XMBOE-.js` still 200 — Wrangler retains prior assets — but is no longer referenced, so it's harmless.)
- **One-time user action:** hard-refresh ONCE (Cmd+Shift+R / incognito) to drop the stale cached client. The new `no-cache` header prevents this from recurring on future deploys.

### If it still stalls
- The prompt+tool-result nudge is the strongest lever available without a model change. If empty post-tool turns persist, the remaining options are: (a) add an `onStepFinish`/`onError` hook or a server-side "empty final step → synthesize a short prose reply" fallback in `onChatMessage`, or (b) revisit the model choice (fp8-fast quantization is the known culprit). Client fallback line already prevents a dead-looking UI in the meantime.

---

## Follow-up 3: server-side two-pass narration (the durable fix)

### Why
Incognito testing confirmed Follow-up 2's prompt nudges (edits A + B) did **not** change fp8-fast's behavior — it still ended its turn on the `update_onboarding` tool call with zero follow-up prose. The client fallback line (edit C) and `no-cache` header (edit D) worked, but the underlying empty-turn remained. This is option (a) from "If it still stalls," implemented properly.

### How it works (confirmed by reading `@cloudflare/ai-chat` + `ai` source, not guessing)
- **Persistence contract:** `onChatMessage`'s returned `Response` body is read by the runtime's `_reply()` (`@cloudflare/ai-chat/dist/index.js:3508`), which accumulates **all** UI-message parts into **one** assistant message and persists via `persistMessages([...this.messages, message])`. The `onFinish` internal callers pass is a no-op (index.js:304/1289/1348) — persistence is driven entirely by the returned stream. So merging two `streamText` passes into one UI-message stream persists as a **single** assistant message.
- **Merge API** (`ai` v6.0.214): `createUIMessageStream({ execute })` gives a `writer` with `.merge(stream)` and `.write(chunk)`; `result.toUIMessageStream({ sendStart?, sendFinish? })` toggles the message-boundary chunks (the SDK docs literally say to set these false "if you are using additional streamText calls"). `handleUIMessageStreamFinish` does **not** auto-append a terminal `finish` — the streams (or a manual `writer.write({type:"finish"})`) must supply exactly one.

### Fix (`src/server.ts` `onChatMessage`, L793+)
Rewrote the single `streamText(...).toUIMessageStreamResponse()` into a two-pass merged stream:
1. **Pass 1** = the original call (tools on, `stopWhen: stepCountIs(8)`, forwards `onFinish`), merged with **`sendFinish: false`**.
2. `await first.text`; if it's **empty** (and not aborted) → **Pass 2**: a tool-less `streamText` (**`toolChoice: "none"`**) seeded with `[...messages, ...(await first.response).messages]` (so it sees the assistant tool-call + tool-result) plus a system nudge telling it to narrate what was captured and state the next onboarding step to `this.currentActor`. Merged with **`sendStart: false`** so it reuses pass 1's `start` and, being the **last** stream, carries the single `finish`.
3. If pass 1 **did** produce prose (or errored/aborted) → `writer.write({ type: "finish" })` to close the one message. Exactly one `start` + one `finish` in every branch; `await first.text` before merging pass 2 sequences the two passes so their chunks don't interleave.
- Returns `createUIMessageStreamResponse({ stream })`. Added `createUIMessageStream` + `createUIMessageStreamResponse` to the `ai` import.

### Ship
- `npm run build` clean (167 modules); **server-only change → client bundle byte-identical** (`index-D2lnmkgS.js` / `index-C8rvEey3.css` unchanged, "No updated asset files to upload"). `npm run check` shows only the pre-existing `./index.css` side-effect warning (main.tsx:29) — server.ts type-checks clean.
- `npm run deploy` → **Version ID `9ef2e0ab-0827-4fad-9559-81bbbc61562f`**. Prod verified: `/` → HTTP 200, `cache-control: no-cache`.
- **User action:** hard-refresh once (or incognito), start a fresh onboarding, and confirm that after the checklist updates the assistant now writes guidance prose instead of a lone `⚙` chip.

### Notes
- `toolChoice: "none"` is the key lever — quantized fp8-fast tends to "finish empty" while tools are still offered; removing them forces pure text.
- Pass 2 only fires on empty pass-1 turns, so normal replies keep their original single-pass latency; the extra model round-trip is spent only when it would otherwise stall.

---

## Follow-up 4: dangling-promise continuation (the reported "no question, chat ended" bug) — SHIPPED

### Symptom
User screenshot: after choosing **Full (primary) DNS setup**, the assistant wrote a full paragraph ending in *"Let me add your domain now."*, showed a lone `⚙ update_onboarding` chip, and then **the turn ended with no next question and no action** — the room is stranded.

### Diagnosis (root cause = a NOT-DEPLOYED fix)
- This is the *mirror* of the empty-turn bug: pass 1 produced **non-empty prose**, but that prose only **promises** an action ("Let me add your domain now.") — the model ended the turn without calling the tool to do it. Follow-up 3's narration pass only fires when pass-1 prose is **empty**, so a non-empty dangling promise slips straight through → dead-end.
- The local source ALREADY contained the fix for this (`promisesToolAction` / `containsToolCallText` at `server.ts` ~L502–539, plus a forced continuation pass in `onChatMessage`), but **it had never been built/deployed**. Confirmed by pulling the live worker via the CF MCP: prod contained Follow-up 3's `"Now reply to"` + `"The tool result above is already recorded"` narration, but **none** of the Follow-up 4 strings. Prod client was `index-dHf9v4H3.js`; local `dist` was ahead. So the bug was live purely because the existing fix was sitting undeployed.

### How the fix works (`src/server.ts` `onChatMessage`, ~L1576–1631)
After pass 1 (tools on, `stopWhen: stepCountIs(8)`):
- `prose = assistantProse(firstText)` strips any tool-call-shaped JSON so we judge only real words.
- **If `containsToolCallText(firstText)` OR `promisesToolAction(prose)`** → run ONE continuation WITH tools and **`toolChoice: "required"`**, seeded with `[...messages, ...(await first.response).messages]` + a nudge ("you said you'd act but called no tool — do it NOW"). Forces the model to actually perform what it promised, then narrate. If that continuation still emits no prose → `runNarration` (tool-less). Bounded to a single retry, so it can't loop.
- `promisesToolAction` only inspects the **final sentence**, ignores sentences ending in `?` (a question is a deliberate hand-off), and matches an intent phrase (`let me` / `I'll` / `next, I'll` …) followed by an action verb (`add`, `check`, `find`, `create`, `queue`, `scan`, …). Verified: the screenshot's exact last sentence *"Let me add your domain now."* → `promisesToolAction` returns **true**.
- Belt-and-suspenders prompt rule already exists (`system-prompt.ts:50`): "Never promise an action without performing it in the SAME turn."

### Ship
- `npm run check` → clean (exit 0); the undeployed fix compiled fine all along.
- `npm run deploy` → **Version ID `b6eea7b3-61f7-4a69-827c-895cb48d99d8`**. New client bundle **`index-Bl7mNc0c.js`** (CSS unchanged `index-Cyd-h-AD.css`).
- Verified against prod by re-pulling the live worker (CF MCP): all Follow-up 4 markers present — `"you would take an action"`, `"ended your turn WITHOUT calling any tool"`, `"Carry out exactly what you said"`, `"perform it by calling the tool"`. New JS asset HTTP 200; `/` serves `cache-control: no-cache` and (after brief edge propagation) references `index-Bl7mNc0c.js`.
- **User action:** hard-refresh once (Cmd+Shift+R / incognito) to drop the stale cached client, then re-run the DNS-setup step — after "Full (primary)" the assistant now actually performs the next action (or asks the next question) instead of dead-ending on the promise.

---

## Follow-up 5: checklist self-completes + mid-message promises no longer stall

### Symptoms (second screenshot, fresh onboarding, NO token set)
1. **Stuck again, differently.** After the team answered goals ("dns, waf and cache"), Glide wrote *"…The next step is to add your domain to Cloudflare. **I will now queue an action to add your domain.** Please note that someone in the room needs to click Apply…"* — but **Pending approvals was empty** (nothing was queued) and no question was asked → dead-end.
2. **The right-hand checklist was entirely unchecked** even though path=fresh, DNS setup="full", and goals were given. The onboarding panel showed only `path: Start fresh` — no `setupType`, no `domain`.

### Diagnosis (two independent root causes, both = fp8-fast unreliability)
1. **Checklist never ticks because the model calls `update_onboarding` with EMPTY arguments.** The chip renders (the call happened) but `setupType`/`domain`/`goals` never reach the tool, so `ob.setupType` stays undefined and `autoDoneSteps` (server.ts) never adds the `setup`/`domain` steps. The model *narrates* "You've chosen Full" but never passes `setupType:"full"` to the tool. This is the quantized model fumbling structured tool args — a prompt tweak won't fix it.
2. **Mid-message promise slipped past `promisesToolAction`.** Follow-up 4's detector only inspected the **final** sentence; here the promise ("I will now queue…") is the *third* sentence and the last sentence is boilerplate ("…click Apply"), so no recovery fired. Worse, forcing a `toolChoice:"required"` write here (no token, no domain) would only junk the queue.

### Fix (4 edits, `src/server.ts` + `src/system-prompt.ts`)
1. **`inferOnboardingFromText(text)`** (server.ts, after `autoDoneSteps`) — a deterministic parser that extracts `setupType` (full/partial/primary/cname), `path` (migrate/fresh), `goals` (dns/waf/cache/rate_limiting/load_balancing/zero_trust), and a `domain` (first non-cloudflare hostname) straight from the user's words. Conservative — only reports what it's confident about.
2. **Backfill in `onChatMessage`** (right after `convertToModelMessages`) — when onboarding is active, fold the inferred answers into state, filling ONLY unset fields (goals unioned) so it never fights an explicit tool call. This makes the checklist **self-complete from what the user actually typed**, regardless of how the model formats its tool call, and keeps the prompt's "Onboarding status" accurate so it stops re-asking. Verified: `infer("full")→{setupType:"full"}`, `infer("dns, waf and cache")→{goals:[dns,waf,cache]}`, `infer("continue")→{}`.
3. **Broadened `promisesToolAction`** — still bails if the FINAL sentence is a question (deliberate hand-off), but otherwise scans **every** sentence for an action-intent phrase. Verified `true` on the exact stuck message, `false` on a normal question and on a plain statement.
4. **Recovery reshaped + prompt guard.** The `promisesToolAction` branch no longer forces a blind write — it runs a **corrective narration** (`toolChoice:"none"`) that forbids claiming un-done actions ("do NOT claim anything was queued/added/created unless it truly happened — the pending queue is the source of truth"), demands the turn **end with one clear question**, and tells it to ask for the domain/token when those are what's missing. (`containsToolCallText` still forces a real structured call — that case genuinely tried to call a tool.) `system-prompt.ts` gained a matching rule: recording an answer is not queuing; never say you queued/added a domain without a real queue tool + a token.

### Ship
- `npm run check` → clean (exit 0). `npm run deploy` → **Version ID `b2d74962-cca4-4117-a083-00b98098c39d`**, client bundle **`index-DFxnHWWT.js`** (CSS unchanged).
- Verified against prod (CF MCP pull): markers present — `inferOnboardingFromText`, `"You ended your turn implying an action"`, `"the only source of truth"`, `"You wrote a tool call as plain text"`, `"Never claim you queued, added, or created"`; the old Follow-up 4 forced-promise nudge (`"you would take an action"`) is **gone**. `/` serves `index-DFxnHWWT.js` (HTTP 200), `cache-control: no-cache`.
- **User action:** hard-refresh once (Cmd+Shift+R / incognito). Now: picking "full" ticks **Choose DNS setup** immediately; giving a domain ticks **Identify the domain(s)**; and instead of falsely claiming a queued domain-add, Glide asks for the domain / an API token and ends with a question.

### Note
- These are deterministic guards around a model that mis-formats tool args and over-promises. They make onboarding reliable without a model change; the durable long-term lever remains swapping off `llama-3.3-70b-fp8-fast` if perfect first-try tool-arg fidelity is ever required.

---

## Follow-up 6: swap off the quantized model + dedicated `add_domain` tool (the durable fix)

### Symptoms (third report, "got stuck again", two screenshots, fresh onboarding)
1. **Two empty "GLIDE" bubbles** — a turn produced no visible prose at all.
2. **Still claims to queue but nothing appears** — Glide wrote *"I will now queue an action to add your domain / Let's proceed with adding your domain"* while **Pending approvals stayed empty**.
3. (From Follow-up 5, now working) the checklist DID tick — the deterministic backfill held up.

### Diagnosis (confirmed via live Workers Observability logs, not guessing)
- Pulled `glide` logs for the live Follow-up 5 version `b2d74962`: **every chat `websocket:message` turn returned `outcome: "ok"`** (11–29 s wall time, i.e. multiple LLM passes) — **no exceptions**. The one `outcome:"exception"` in range was on the *old* version `b6eea7b3`. So the failure mode is **empty completions from the model**, not a thrown error — and the multi-pass recovery (Follow-ups 3–5) can't help because it re-invokes the *same* flaky model, which also returns empty.
- `queuePending` (server.ts:2191) is **NOT token-gated** — it only appends a `PendingAction` to state; the token is used at Apply time. So "no approval requests" was never structural: the model simply **never emitted the write tool call** (it narrated the intent instead), and Follow-up 5's Case-C corrective narration deliberately does not blind-write, so nothing queued.
- Root cause of all three symptoms = **`@cf/meta/llama-3.3-70b-instruct-fp8-fast` quantization**. This is the "durable lever" the Follow-up 5 note called out.

### Decision (asked the user)
- **Model → `@cf/openai/gpt-oss-120b`** (user pick). Full-precision reasoning model, **128k context** (fits the big system prompt + RAG), function-calling **Yes**, $0.35/$0.75 per M.
- **Add a dedicated `add_domain` builder tool** (user: yes).

### Compatibility check (read `workers-ai-provider@3.2.1` source before committing)
- gpt-oss does **NOT** support `/ai/run` streaming; the provider transparently retries **non-streaming** and synthesizes the AI-SDK stream (`doStream` fallback, index.mjs ~L1281–1345). So `streamText` + `tools` + `toolChoice` all work — just non-incremental (whole message appears at once; higher per-pass latency with a reasoning model — watch item).
- The provider has explicit **gpt-oss/harmony** handling incl. `salvageToolCallsFromText` — recovers a forced tool call the model leaks as JSON text (only under `toolChoice: required`/named). Dovetails with our `containsToolCallText` → forced-continuation path.
- gpt-oss emits a **`reasoning`** channel; `toUIMessageStream`'s `sendReasoning` defaults to **true**, and the client (`main.tsx:291`) concatenates `reasoning` parts into the **visible** message text → would leak raw chain-of-thought. **Fixed by `sendReasoning:false`.**
- `dedupAIBinding` (server.ts:685) only transforms `ReadableStream` results, so it's a **harmless no-op** for gpt-oss's non-streaming response.

### Fix
1. **`wrangler.jsonc`** — `GLIDE_MODEL` → `@cf/openai/gpt-oss-120b` (+ comment explaining the why and the non-streaming/reasoning caveats).
2. **`src/server.ts` `onChatMessage`** — `sendReasoning:false` on all three `toUIMessageStream` merges (pass 1, forced continuation, narration) so the harmony reasoning channel never reaches the client.
3. **`src/server.ts` new `add_domain` tool** (top of the WRITES section) — inputs `name` (required), `accountId?`, `setupType?` (full/partial). Normalizes the domain (strips scheme/path/trailing dot, lowercases; rejects non-domains). Resolves the account: explicit `accountId` → room `defaultAccountId` → else, if a token exists, `listAccounts` (auto-uses the sole account and saves it as default; asks which if several; errors if none); **if no token, it does NOT fake a queue — it asks for a token/account**. With an account it `queuePending` a real `POST /zones` (`{name, account:{id}, type}`) → shows up in Pending approvals. Reads run now; the write only queues.
4. **`src/system-prompt.ts`** — added `add_domain` to the builder-tool list; reworded the anti-false-claim rule to require calling `add_domain` (and to relay exactly what it reports missing); go-live "Add the zone" step now says to call `add_domain`.
5. **Comment cleanup** — the four `fp8-fast`/`llama-3.3`-naming comments reworded to be model-agnostic (recovery kept as a general safety net) so they don't imply the quantized model is still in use.

### Ship
- `npm run check` → clean. `npm run deploy` → first **Version `1c6e77e3-df2d-40fe-9b62-8de3f12a23f2`** (functional), then comment-cleanup redeploy **Version `09ab182c-d06f-4647-8f54-e4c89df53f7b`** (live == source). Client bundle **`index-CoLePAym.js`**.
- Verified against prod (CF MCP worker-code pull): `GLIDE_MODEL="@cf/openai/gpt-oss-120b"` in the deploy binding list; markers present — `add_domain`, `Add domain `, `doesn't look like a domain`, `sendReasoning`, `there's no API token in this room yet to look that up`, `Add the zone** by calling`, and the reworded `queued an action to add your domain` prompt rule. `/` serves `index-CoLePAym.js` (HTTP 200), `cache-control: no-cache`.
- **User action:** hard-refresh once (Cmd+Shift+R / incognito), start a fresh onboarding. Expect: real prose every turn (no empty bubbles, no visible reasoning), and when you give a domain + a token is set, an **Add domain …** entry appears in Pending approvals; with no token it asks for one instead of falsely claiming a queue.

### Watch items
- **Latency:** gpt-oss is non-streaming + reasoning; a turn that fires recovery passes = 2–3 sequential full inferences. Logs already showed ~30 s turns on the old model. If turns time out (look for `outcome:"exception"` on the new version), reduce `stepCountIs(8)` or the number of recovery passes.
- If the model still leaks tool calls as text in pass 1 (auto toolChoice, so no provider salvage), `containsToolCallText` should catch it and force the salvaged continuation — verify in logs.

---

## Follow-up 7: "Reset onboarding" control + fix the misleading welcome card

### Symptom (screenshot after a hard refresh)
- The user hard-refreshed to "start fresh" (per the F6 instruction) but the room still showed prior progress: the ONBOARDING panel had `path: Start fresh`, `domain: arubhe.com`, `setup: Full (primary)`, goals, **2 ticked steps and a partly-filled progress bar** — while the chat pane showed the brand-new *"migrating or starting fresh?"* welcome card. Contradictory, and not fresh.

### Diagnosis (two things; neither is the F6 model swap regressing)
1. **Rooms are durable + keyed by the URL hash.** `main.tsx:346` sets `room = readRoomFromHash() || newRoomId()`; the URL still ended in `#5890f65a2618…`, so a hard refresh **reconnects to the same room** and its persisted onboarding state stands. Hard refresh only reloads the browser (to pick up the new client bundle) — it never resets server-side state. **The F6 "hard-refresh to start fresh" instruction was wrong.**
2. **Misleading welcome card.** `main.tsx` gated the `GuidedIntro` "question 1" card on `messages.length === 0 && !onboarding?.completed` — with **no** check for whether onboarding was already *partway*. The prior state was set via the guided **form** (populates state, posts no chat messages), so 0 messages + partway state → the "start fresh?" card rendered over a half-filled progress bar.
- There was also **no reset/new-room affordance** — the only control was the editable `#room` pill.

### Decision (asked the user)
- **Reset onboarding in place** (chosen) — a button that wipes THIS room's onboarding so the same URL starts over; pending approvals + chat history kept. (Not a new-room button.) Plus fix the welcome card either way.

### Fix
1. **`src/server.ts` new `resetOnboarding` callable** — `setState({ ...this.state, onboarding: undefined })`. Dropping the key returns the room to the brand-new state (`INITIAL_GLIDE_STATE` has no `onboarding`); JSON state-sync omits `undefined`, so clients see `state.onboarding === undefined`. Leaves `pendingActions`, chat history, token, memory, defaults intact.
2. **`src/client/main.tsx` `resetOnboarding` callback** — `window.confirm(...)` then `runRpc("resetOnboarding", [name])` + `setFormOpen(false)`.
3. **`src/client/main.tsx` `Reset` button** — added next to the Onboarding section's existing action (beside **Use form** when active, beside **Re-run** when completed).
4. **`src/client/main.tsx` welcome-card fix** — reordered the 0-messages branch to: `showWizard` → completed (`Say hello`) → **`onboarding?.active` → new "Onboarding in progress 👉" resume hint** → else `GuidedIntro`. So the "question 1" card shows only for a truly-fresh room (not active, not completed); a form-started room shows the resume hint instead.

### Ship
- `npm run check` → clean. `npm run deploy` → **Version `1a01ef94-f524-491a-a060-676a596f3984`**, client bundle **`index--bwtGDFr.js`** (was `index-CoLePAym.js`).
- Verified against prod (CF MCP pull): `resetOnboarding` present in the deployed worker (5 refs); `/` serves the new bundle `index--bwtGDFr.js`.
- **User action:** in the existing room, click **Reset** in the Onboarding panel (top-right, next to Use form) → the checklist/domain/goals/progress clear and the chat shows the fresh "migrating or starting fresh?" card. No hard refresh needed. (To keep old state but test separately, edit the `#…` room pill to a new name for a brand-new room instead.)

---

## Follow-up 8: onboarding "stuck right away" — recovery guard clobbered the first reply

### Symptom (screenshot)
Fresh onboarding, first message. The user picked **Starting fresh** and sent *"I'm setting up Cloudflare fresh — walk me through it one step at a time."* Glide replied with just **"That step did not run. What domain would you like to onboard to Cloudflare?"** — an alarming, terse line on the very first turn (plus the pre-existing "saved API token failed verification" banner). It looked broken immediately.

### Diagnosis (confirmed by reading code + reproducing the regex, then verifying prod)
- That exact sentence is the first branch of `unfulfilledActionNarration()` (`server.ts:2438`), reached only when a recovery guard fires. The guard is **Case C** in `onChatMessage` (`server.ts:1851`): `if (promisesToolAction(prose)) { writeChunks(firstChunks, false); appendText(this.unfulfilledActionNarration()); … }` — it **discards the model's real prose** (the `false` drops text chunks) and replaces it with the deterministic line.
- Root cause = a **false positive** in `promisesToolAction` (`chat-integrity.ts`). It returned `false` only when the *final* sentence literally ended with `?`; otherwise any sentence matching `ACTION_INTENT` ("I'll add…", "let's begin…", "let me start by adding…") tripped it. But on this step the system prompt (`system-prompt.ts` onboarding Q2 + "NEXT REQUIRED STEP") tells the model to **ask for the domain** — so the model correctly explains the plan and asks for the domain, frequently phrasing the ask as "…tell me your domain." / "…let me know your domain (e.g. example.com)." / "What domain…? For example, example.com." None of those *end* in `?`, so the guard clobbered a perfectly good reply.
- Reproduced with the live regex: 4 of 5 realistic gpt-oss-120b first replies were CLOBBERED (only the one whose final char was `?` survived). The Follow-up 6 model swap (gpt-oss writes warmer, multi-sentence prose) made this fire almost every first turn.
- Verified prod (CF MCP `workers_get_worker_code`) contained the old clobber string before the fix. (The `llama-3.3-70b` string in the bundle is just the `workers-ai-provider` AI-Search default; the deploy binding list confirms `GLIDE_MODEL=@cf/openai/gpt-oss-120b`.)

### Fix (2 edits + tests)
1. **`src/chat-integrity.ts`** — added `solicitsUserInput(prose)` (exported) and made `promisesToolAction` bail early when it's true. A reply that asks the user for anything is a deliberate hand-off, not a dead-end: `solicitsUserInput` = a `?` **anywhere** (not just the last sentence) **or** an explicit input request (`let me/us know`, `tell me`, `provide/share/send/paste/upload …`, `which…`, `what's…`, `could you`, `go ahead and tell…`, …). True dead-ends ("Let me add your domain now.", "I will now queue an action to add your domain. …click Apply.") ask for nothing, so they're still caught.
2. **`src/server.ts` `unfulfilledActionNarration()`** — softened only the onboarding-no-domain branch: no more "That step did not run."; now *"Let's start with your domain — which domain would you like to onboard to Cloudflare? (for example, example.com)"*. The token-invalid / no-token / generic branches keep "That step did not run." (they really are a failed step).
3. **`tests/chat-integrity.test.ts`** — added a regression test (4 onboarding replies stay un-clobbered) and a dead-end case; existing assertions unchanged.

### Ship
- `npm run test` → 9/9 pass. `npm run check` → clean. `npm run deploy` → **Version `e0e79cd4-ddd0-420b-b0e5-53f6dc090a03`**, client bundle **`index-BmmcB5mY.js`**, CSS `index-D8g-MXlg.css`. Binding list confirms `GLIDE_MODEL ("@cf/openai/gpt-oss-120b")`.
- Verified against prod (CF MCP pull): new `"Let's start with your domain"` present; old `"That step did not run. What domain would you like to onboard"` **gone**; `solicitsUserInput` regex literal (`go ahead and (?:tell…`) present; the token-failed-verification recovery branch still present.
- **User action:** hard-refresh once (Cmd+Shift+R / incognito) to drop the stale client, then in the stuck room click **Reset** in the Onboarding panel (or edit the `#…` room pill to a new name) and re-send. The first turn should now be Glide's warm walkthrough that asks for your domain — no "That step did not run."

### Separate note — the token banner
The orange banner ("saved Cloudflare API token failed verification") is **independent** of the stuck bug. It means this room has a saved token whose live verification failed (`state.tokenValid === false`), not that onboarding is broken. Onboarding/chat and queueing still work; only **Apply** and account discovery are blocked until the token is fixed in **Connection → Change**. If it keeps failing with a token you believe is valid, the verification path (`cf-api.ts`) is the next thing to inspect — not the chat flow.

---

## Follow-up 9: composer wedged on a never-terminating turn (eternal thinking-dots, Send disabled)

### Symptom (screenshot)
Mid-onboarding (token perms flow), the last GLIDE bubble showed the animated thinking-dots (`●●●`) indefinitely, the user had typed "retry now", and **Send was greyed out** — "stuck at a step and does not let me send more messages." The turn never completed from the client's point of view.

### Diagnosis (logs + library source, not guessing)
- The composer's Send is `disabled={!draft.trim() || busy}` and the thinking-dots render `{busy && …}`. `busy` (main.tsx) is `chat.status === "submitted" | "streaming" || chat.isStreaming || chat.isServerStreaming || chat.isToolContinuation || chat.isRecovering` — all from `@cloudflare/ai-chat`'s `useAgentChat` (re-exported from `agents/chat/react`). If any stays true with no terminal, the composer is locked **with no escape** (there was no Stop/cancel control and no timeout).
- Workers Observability (CF MCP): every chat `websocket:message` on the live version completed `outcome: "ok"` (6–8s) — **no server exception**. So this is a *client wedge*, not a crash: a stream that stopped terminalizing left `status`/`isServerStreaming` stuck true.
- Root cause of the non-terminating stream: `GlideAgent` runs with the SDK's durable-recovery and stall-watchdog **both off by default** — `chatStreamStallTimeoutMs` defaults to `0` (disabled; ai-chat `index.d.ts:188`) and `chatRecovery` is opt-in (`index.d.ts:168-179`), and `GlideAgent` sets neither. So when a stream is interrupted (a **deploy evicted the DO mid-response** — I had just deployed twice while the user was live — or the WebSocket dropped, or the **non-streaming gpt-oss** provider hung with no inter-chunk progress), nothing server-side kills the spinner and the client sits at `streaming` forever. The docs confirm: with recovery disabled and no watchdog, an interrupted/stalled stream neither self-terminalizes nor recovers.

### Fix (client escape hatch — safe for ANY wedge cause; `src/client/main.tsx`)
1. **Stall detection**: `STALL_MS = 20000`; a `progressSig` (`messages.length` + serialized last-message parts length) restarts a timer whenever tokens/parts stream in. If `busy` stays true with no progress for 20s → `stalled = true`. Resets when `busy` clears or progress advances (a steadily-streaming turn never trips it).
2. **`stop()` callback**: calls `chat.stop?.()` (aborts the active turn, resets AI-SDK status to ready) and sets `stalled` locally so the composer unblocks immediately even if the library flags lag.
3. **Composer**: a **Stop** button renders whenever `busy` (calls `stop`); **Send** is now `disabled={!draft.trim() || (busy && !stalled)}` — so once a turn looks stuck (20s), Send re-enables. `send()` was updated: if `busy && !stalled` it still waits; if `busy && stalled` it calls `stop()` first, then sends a fresh message (which starts a new stream).
4. **Indicator**: after the stall timeout the thinking-dots swap to a muted hint — *"Still working on the last step. If it looks stuck, press **Stop** and send your message again."* — so the escape is discoverable. New `stopBtn` + `stallHint` styles.

### Ship
- `npm run check` clean; `npm run test` 9/9; `npm run build` clean. `npm run deploy` → **Version `da5d2289-1f01-4492-b640-b499e494c42f`**, client bundle **`index-P_ikUitP.js`** (CSS unchanged `index-D8g-MXlg.css`). Model binding still `@cf/openai/gpt-oss-120b`.
- Verified against prod: the new asset (`/assets/index-P_ikUitP.js`, HTTP 200) contains `"Still working on the last step"` and `"Stop the current response"`. Note: a cache-busted `/` already serves the new `index-P_ikUitP.js`; the plain `/` briefly returned a stale **edge** `cf-cache-status: HIT` of the old HTML (`index-BmmcB5mY.js`) right after deploy — `cache-control: no-cache` makes browsers revalidate, so a hard refresh picks it up.
- **User action:** hard-refresh once (Cmd+Shift+R / incognito). To clear the currently-wedged room: after refresh, click **Stop** in the composer (it appears while the dots spin) — Send re-enables and you can send "retry now". If a room is truly stuck before the new bundle loads, editing the `#…` room pill to a new name gives a fresh room.

### Deferred (not done — would need testing)
- The durable server-side hardening is to enable `chatRecovery` (auto-resume an interrupted turn after a deploy/eviction) and possibly `chatStreamStallTimeoutMs`. Both were left off because (a) enabling durable `runFiber` execution could interact with the custom two-pass `createUIMessageStream` merge in `onChatMessage`, and (b) a stall watchdog is risky with a **non-streaming** model (gpt-oss emits one late chunk, so the inter-chunk gap can look like a stall and abort healthy turns). The client escape hatch fixes the user-visible lock-out without those risks; revisit server recovery if deploy-time interruptions need to auto-heal rather than needing a Stop click.

---

## Follow-up 10: right side "not up to date" — token stuck "unverified" though it works

### Symptom (screenshot)
Header showed the amber **"token unverified"** badge + the banner *"The saved Cloudflare API token failed verification"* (`tokenConfigured=true`, `tokenValid=false`), while in the same session the token had clearly **listed accounts and zones** (it saw zone `arubhe.com`). The right-side RECENT RESULTS also still showed a **2-day-old** failed *"Add domain arubhe.com (full setup)"* whose message — *"Set it with `wrangler secret put CF_API_TOKEN`"* — **no longer exists anywhere in the codebase** (proof it was persisted DO state from an old deploy). User read this as "the right side is not up to date." **Chosen target (asked): the token status badge/banner.**

### Diagnosis (read code + confirmed the state-sync model)
- The whole right side is **live-synced from DO state** via `onStateUpdate` (`main.tsx:435`); `recentResults` renders at `main.tsx:1345`. So "not up to date" = the DO **state** was stale, not a browser/bundle cache issue.
- **`tokenValid` was only ever set at save time** — inside `setCloudflareToken` (`server.ts:1145`). Nothing re-checked it, so a token that failed its *first* verify stayed `false` forever even as reads plainly succeeded. Retries ("try now") never refreshed it.
- **`verifyToken` was a false-negative** (`cf-api.ts:213`): it only called `GET /user/tokens/verify`, a **user-scoped** endpoint that 401s for **account-scoped** API tokens (the common onboarding case) even when they're perfectly valid. The old code comment literally said *"Some valid tokens 401 on the verify endpoint; treat as informational"* — then returned `valid:false` anyway. That single wrong bit cascaded: badge/banner wrong, and the token-invalid recovery branch (`unfulfilledActionNarration`, F8) could fire.
- The user's real remaining issue is a **DNS-edit permission gap** (`list_dns_records` 403), which is a *scope* problem, **not** a token-validity problem — so the badge must not treat it as "invalid".

### Fix (3 edits + tests)
1. **`src/cf-api.ts` `verifyToken`** — when `/user/tokens/verify` fails, **fall back to a real authenticated read**: if the token can `listAccounts` (or, failing that, `listZones`), report `valid:true` ("verified via account/zone access"). Only when it can touch neither is it `valid:false`. (`listAccounts`/`listZones` are declared below `verifyToken`; only *called* at runtime, so no TS/runtime ordering issue.)
2. **`src/server.ts` `noteTokenOutcome(res)`** — keeps synced `tokenValid` honest as the token is *used*: a successful read → `true`; a **401 (`auth`)** → `false`; **anything else (a permission gap, 404, 5xx) leaves it alone** (so a DNS-403 never un-verifies a good token). Wired into `readError` (covers every read tool's failure path) + the success path of `list_accounts` / `list_zones` / `find_zone`.
3. **`src/server.ts` new `reverifyToken()` callable** + **`src/client/main.tsx` connect trigger** — a `useEffect` (guarded by a `reverifiedToken` ref, deps `tokenConfigured`/`tokenValid`/`runRpc`) calls `reverifyToken` **once per mount when the badge says unverified**, so an already-stored token self-corrects via the read-based fallback **without the user re-entering it**. The ref guard prevents a loop if the token really is bad.
4. **`tests/cf-api.test.ts` (new)** — 4 `fetch`-mocked cases: active verify (no extra reads); verify-401→accounts-ok; verify-401→accounts-403→zones-ok; all-401→invalid.

### Ship
- `npm run check` clean; `npm run test` **13/13** (9 prior + 4 new). `npm run deploy` → **Version `f334827d-a569-479a-b95f-0e785da6f17f`**, client bundle **`index-BvGtnekG.js`** (CSS unchanged `index-D8g-MXlg.css`). Binding list still `GLIDE_MODEL ("@cf/openai/gpt-oss-120b")`.
- Verified against prod (CF MCP pull): server bundle contains `reverifyToken` (×4), `noteTokenOutcome` (×5), `verified via account access` / `verified via zone access`; `/` serves the new `index-BvGtnekG.js` and its bundle contains `reverifyToken`.
- **User action:** hard-refresh once (Cmd+Shift+R / incognito). On reconnect the app auto-re-checks the stored token; since it can list accounts/zones, the badge should flip **"token unverified" → "token ✓"** and the banner clear — no re-entry. The DNS step will still return a specific *"likely missing token permission: DNS — Edit (Zone)"* until that scope is added to the token; that's expected and no longer marks the whole token invalid.

### Not fixed (out of chosen scope)
- The **stale RECENT RESULTS** entry (2-day-old "Add domain" failure with the obsolete `wrangler secret put` text) and the **checklist not advancing** were the other two candidate readings of "right side not up to date." Left as-is per the chosen target (token badge). If they resurface: RECENT RESULTS needs a clear/expire affordance (it's persisted DO state, never pruned), and the checklist only ticks from *successful* pending/results via `recomputeOnboardingChecklist` (`server.ts:932`), so it won't advance until Apply actually succeeds (blocked today by the DNS-edit scope gap, not by Glide).

---

## Follow-up 11: optimistic "try now" bubble never reached the server + missing diagnostic logs

### Symptom (screenshot)
- Room `[redacted-production-room]` showed a final user bubble, **"try now"**, with no assistant response and no useful error. The composer was idle rather than visibly streaming, so the prior 20-second stall/Stop escape hatch did not apply. The real hash is omitted because a room link is an access credential.
- The user asked where the logs were for troubleshooting.

### Production evidence and root cause
- Logs are in **Workers & Pages -> glide -> Observability -> Logs**; live CLI equivalent: `npx wrangler tail glide`. The Cloudflare Observability API found this exact room, but its hash is redacted here because the room link is a credential. The SDK's stock events only said `Chat message received/completed`, connection lifecycle, and RPC calls; they had no client message id, turn id, model stage, or tool/error stage.
- Pulled the server-authoritative transcript from `/agents/glide-agent/<room>/get-messages`. It ended with the prior assistant DNS-permission response (29 messages total). The visible final **"try now" was absent**. Therefore `onChatMessage` never ran for that bubble; there was no model/tool failure to find in server logs.
- Confirmed in installed source: `PartySocket.send()` returns `false` when a frame is buffered rather than transmitted, but `WebSocketChatTransport` types `AgentConnection.send()` as `void`, unconditionally sets `requestSent=true`, ignores the boolean, and closes its local response stream on socket close. AI SDK `sendMessage()` adds the user message optimistically first. Result: a deploy/reconnect race can display a sent bubble even though the frame never reaches the DO.
- This happened around the F10 deployment while the user's old bundle remained loaded. That also explains why the screenshot still showed `TOKEN UNVERIFIED`: the new reverify-on-connect code had not loaded.

### Fix
1. **Transport send guard (`src/client/main.tsx`)**: wrap the agent passed to `useAgentChat`; at the exact transport send point, require `readyState === WebSocket.OPEN` and `PartySocket.send(...) === true`. Otherwise throw a connection error instead of silently buffering a supposedly submitted turn.
2. **Visible connection state**: track socket open/close, add a header `LIVE` / `RECONNECTING` badge, pause Send while disconnected, retain drafts, and show an inline reconnect notice rather than an unexplained idle bubble.
3. **Delivery verification**: assign each new user message a client id. If the socket changed or no assistant followed, fetch server-authoritative `/get-messages` and classify via new `src/chat-delivery.ts`:
   - id absent: remove the false optimistic bubble, restore its text to the composer, and tell the user to resend once Live;
   - id present but no assistant next: show **Retry response**, which resubmits the existing final user turn without adding a duplicate;
   - assistant next: delivered, clear the warning.
4. **Structured production logs (`src/server.ts`)**: privacy-safe objects (no message text/token) now emit `glideEvent` values `chat.received`, `chat.prepared`, `chat.model_pass`, `chat.stream_created`, `chat.stream_finished`, `chat.error`, and `chat.client_issue`. Server turn events correlate with `room`, `turnId`, `messageId`, `stage`, and `outcome`; client incidents add `kind` and `connectionEpoch`.
5. **Secret safety**: diagnosis found a `cfat_...` token previously pasted into chat and persisted in history. Added a client guard directing tokens to **Connection -> Set token**, an `AIChatAgent.sanitizeMessageForPersistence` override that redacts token-shaped text, and idempotent on-wake cleanup of old messages. The encrypted sidebar token is untouched. The exposed token still needs rotation.
6. **Tests**: new `tests/chat-delivery.test.ts` covers delivered, not-delivered, interrupted, and token-detection/redaction cases.

### Ship and verification
- `npm run check` clean; `npm run test` **17/17**. Deployed **Version `4c424a24-f116-4f60-b84c-e40fbe2ab1e4`**, client bundle **`index-BYMoMOJD.js`**; model binding remains `@cf/openai/gpt-oss-120b`.
- Production HTML serves `index-BYMoMOJD.js`; bundle contains `Retry response`, the reconnect notice, and token-send guard.
- Woke the reported room after deploy: still 29 authoritative messages, last role `assistant`, and **zero `cfat_...` patterns**. This both confirms the false final bubble was never server-side and confirms existing secret text was scrubbed.
- End-to-end observability test in disposable room `glide-log-verification`: synthetic content-free incident returned `{ok:true}` and produced searchable fields `glideEvent=chat.client_issue`, `room=glide-log-verification`, `kind=not_delivered`, `messageId=diagnostic-message`, `connectionEpoch=0`.
- **User action:** hard-refresh once (Cmd+Shift+R). The false local-only "try now" bubble will disappear because it was never persisted. Wait for **LIVE**, then resend. Also revoke/rotate the API token that was pasted into chat, save the replacement only via **Connection -> Change**, and never paste tokens into chat.

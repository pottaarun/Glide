/**
 * Glide — React chat client.
 *
 * A room is one `GlideAgent` instance (named by the URL hash). Everyone who
 * opens the same room shares the same live chat + the same pending-action
 * queue, synced over the Agents SDK WebSocket.
 *
 * - `useAgent` gives us the live {@link GlideState} (memory, pending actions,
 *   results) and the RPC `call()` used to Apply/Reject.
 * - `useAgentChat` gives us the streaming transcript and `sendMessage`.
 */

import {
  Component,
  StrictMode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ErrorInfo, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { UIMessage } from "ai";

// Build-time snapshot of the project's Markdown docs (README + fix-progress log
// + docs/*.md), injected by the `glide-docs-manifest` Vite plugin. Powers the
// Admin page's "Dev docs updates" tracker.
import { docsManifest } from "virtual:glide-docs";

import "./index.css";

import type {
  ActionResult,
  DocsIndexState,
  GlideMessageMetadata,
  GlideState,
  GuidanceDoc,
  MigrationPlan,
  OnboardingPath,
  OnboardingState,
  PendingAction,
  SetupType,
} from "../shared";
import { isActionApplying, pendingActionStatus } from "../action-lifecycle";
import { containsCloudflareApiToken, persistedDeliveryStatus } from "../chat-delivery";

const CHAT_CONNECTION_ERROR = "Glide's live connection closed before the message was sent.";

// ---------------------------------------------------------------------------
// Room + identity helpers
// ---------------------------------------------------------------------------

function readRoomFromHash(): string {
  const raw = decodeURIComponent(location.hash.replace(/^#/, "")).trim();
  return raw.replace(/^room=/, "").trim();
}

/**
 * Mint a high-entropy, unguessable room id. The room URL is effectively the
 * access credential (there is no separate login), so the DEFAULT room must not
 * be guessable — otherwise strangers could land in a shared room that already
 * has a Cloudflare token and Apply changes. Sharing the link is the (intended)
 * way to collaborate.
 */
function newRoomId(): string {
  // 128 bits, URL-safe.
  return crypto.randomUUID().replace(/-/g, "");
}

const NAME_KEY = "glide:name";

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

const METHOD_COLORS: Record<string, string> = {
  POST: "#16a34a",
  PUT: "#0891b2",
  PATCH: "#ca8a04",
  DELETE: "#dc2626",
  GET: "#6b7280",
};

const STATUS_COLORS: Record<ActionResult["status"], string> = {
  applied: "#16a34a",
  failed: "#dc2626",
  rejected: "#9ca3af",
};

/** Includes snapshot reads, one retried write, and transport overhead. */
const APPLY_RPC_TIMEOUT_MS = 6 * 60 * 1_000;

type RenderedToolStatus = "unknown" | "running" | "waiting" | "complete" | "failed";

interface RenderedTool {
  id: string;
  name: string;
  status: RenderedToolStatus;
}

/** Trigger a client-side download of a text file (used for Terraform export). */
function downloadText(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Compact relative time, e.g. "just now", "3m ago", "2h ago", "5d ago". */
function relTime(ms?: number): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** Absolute local timestamp for tooltips / precise reads. */
function fmtWhen(ms?: number): string {
  return ms ? new Date(ms).toLocaleString() : "";
}

/** Human-readable byte size. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Onboarding wizard options (provider keys mirror the migration tool)
// ---------------------------------------------------------------------------

const PROVIDER_OPTIONS: Array<{ key: string; label: string }> = [
  { key: "akamai", label: "Akamai" },
  { key: "fastly", label: "Fastly" },
  { key: "imperva", label: "Imperva (Incapsula)" },
  { key: "zscaler_zia", label: "Zscaler ZIA" },
  { key: "zscaler_zpa", label: "Zscaler ZPA" },
  { key: "prisma_access", label: "Prisma Access" },
  { key: "cisco_umbrella", label: "Cisco Umbrella" },
  { key: "akamai_eaa", label: "Akamai EAA" },
  { key: "proofpoint", label: "Proofpoint" },
];

const MIGRATE_GOALS: Array<{ id: string; label: string }> = [
  { id: "dns", label: "DNS records" },
  { id: "waf", label: "WAF / security rules" },
  { id: "cache", label: "Cache / performance" },
  { id: "rate_limiting", label: "Rate limiting" },
  { id: "load_balancing", label: "Load balancing" },
  { id: "zero_trust", label: "Zero Trust (Gateway / Access)" },
];

const FRESH_GOALS: Array<{ id: string; label: string }> = [
  { id: "dns", label: "DNS records" },
  { id: "waf", label: "WAF / security" },
  { id: "cache", label: "Cache / performance" },
  { id: "rate_limiting", label: "Rate limiting" },
  { id: "redirects", label: "Redirects" },
  { id: "zero_trust", label: "Zero Trust (Gateway / Access)" },
];

const SETUP_OPTIONS: Array<{ id: SetupType; label: string; desc: string }> = [
  {
    id: "full",
    label: "Full (primary)",
    desc: "Cloudflare is your authoritative DNS. Most common; the only option on Free/Pro. Recommended.",
  },
  {
    id: "partial",
    label: "Partial (CNAME)",
    desc: "Keep your current DNS provider and proxy only specific subdomains. Business/Enterprise only.",
  },
  { id: "unsure", label: "Not sure yet", desc: "We'll recommend Full setup unless you have a reason not to." },
];

function goalLabel(id: string): string {
  return (
    [...MIGRATE_GOALS, ...FRESH_GOALS].find((g) => g.id === id)?.label ?? id.replace(/_/g, " ")
  );
}

function setupLabel(s?: SetupType): string {
  return s === "full" ? "Full (primary)" : s === "partial" ? "Partial (CNAME)" : "to be decided";
}

/** Infer the migration tool's config format from an uploaded file's name. */
function formatFromName(filename: string): "json" | "xml" | "terraform" | "panos" | "auto" {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "json") return "json";
  if (ext === "xml") return "xml";
  if (ext === "tf" || ext === "tfvars" || ext === "hcl") return "terraform";
  if (ext === "conf" || ext === "set" || ext === "cfg") return "panos";
  return "auto";
}

// Llama-family models sometimes emit a tool call as *literal assistant text*
// (e.g. `<|python_tag|>{"type":"function","name":"find_zone",...}`) instead of
// a structured tool part. Left alone it renders as raw JSON in the bubble — and
// when a real tool part also exists it shows a duplicate chip. We strip the
// serialized call out of the text and surface just the tool name.

const LLAMA_TOKENS =
  /<\|(?:python_tag|eom_id|eot_id|start_header_id|end_header_id|begin_of_text)\|>/g;

/** Index just past the balanced `{…}` starting at `start`, or -1 if unbalanced. */
function scanJsonObject(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Tool name if `obj` looks like a serialized tool call, else null. */
function toolCallName(obj: string): string | null {
  if (!/"(?:type|name|function|parameters|arguments)"\s*:/.test(obj)) return null;
  const isToolShape =
    /"type"\s*:\s*"function"/.test(obj) ||
    (/"name"\s*:/.test(obj) && /"(?:parameters|arguments)"\s*:/.test(obj));
  if (!isToolShape) return null;
  try {
    const parsed = JSON.parse(obj) as Record<string, unknown>;
    const fn = (parsed.function ?? parsed) as Record<string, unknown>;
    const name = fn?.name ?? parsed.name;
    return typeof name === "string" ? name : "tool";
  } catch {
    const m = obj.match(/"name"\s*:\s*"([^"]+)"/);
    return m ? m[1] : "tool";
  }
}

/** Remove serialized tool calls from assistant text, capturing their names. */
function stripToolCalls(raw: string): { text: string; tools: string[] } {
  const tools: string[] = [];
  const s = raw
    .replace(LLAMA_TOKENS, "")
    .replace(/<\/?(?:tool_call|function_call)>/g, "");
  let out = "";
  let i = 0;
  while (i < s.length) {
    const brace = s.indexOf("{", i);
    if (brace === -1) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, brace);
    const end = scanJsonObject(s, brace);
    if (end === -1) {
      out += s.slice(brace);
      break;
    }
    const candidate = s.slice(brace, end);
    const name = toolCallName(candidate);
    if (name) tools.push(name);
    else out += candidate;
    i = end;
  }
  // Llama sometimes wraps the leaked call in a ```json fence; once the JSON
  // object above is removed the fence is empty, so drop those scars too.
  const text = out
    .replace(/```[a-zA-Z0-9]*\s*```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, tools };
}

function renderedToolStatus(state: unknown): RenderedToolStatus {
  const value = typeof state === "string" ? state : "";
  if (value === "output-error" || value === "output-denied") return "failed";
  if (value === "output-available") return "complete";
  if (value === "approval-requested") return "waiting";
  if (value === "input-streaming" || value === "input-available") return "running";
  return "unknown";
}

function messageText(m: UIMessage): { text: string; tools: RenderedTool[] } {
  let text = "";
  const tools = new Map<string, RenderedTool>();
  const priority: Record<RenderedToolStatus, number> = {
    unknown: 0,
    complete: 1,
    waiting: 2,
    running: 3,
    failed: 4,
  };
  const addTool = (id: string, name: string, status: RenderedToolStatus) => {
    const current = tools.get(id);
    if (!current || priority[status] > priority[current.status]) tools.set(id, { id, name, status });
  };
  for (const part of m.parts as Array<Record<string, unknown>>) {
    const type = part.type as string;
    if (type === "text") {
      text += (part.text as string) ?? "";
    } else if (type === "dynamic-tool") {
      const name = String(part.toolName ?? "tool");
      addTool(String(part.toolCallId ?? name), name, renderedToolStatus(part.state));
    } else if (type.startsWith("tool-")) {
      const name = type.slice("tool-".length);
      addTool(String(part.toolCallId ?? name), name, renderedToolStatus(part.state));
    }
  }
  // Only sanitize assistant output; never rewrite what a teammate typed.
  const cleaned =
    m.role === "user" ? { text, tools: [] as string[] } : stripToolCalls(text);
  for (const name of cleaned.tools) {
    if (![...tools.values()].some((rendered) => rendered.name === name)) {
      addTool(`leaked-${name}`, name, "unknown");
    }
  }
  // Real tool parts win; leaked duplicates collapse away.
  return { text: cleaned.text, tools: [...tools.values()] };
}

function isSystemEvent(message: UIMessage): boolean {
  return (message.metadata as GlideMessageMetadata | undefined)?.systemEvent === "action_result";
}

function ToolChip({ tool: rendered }: { tool: RenderedTool }) {
  const display: Record<RenderedToolStatus, { icon: string; label: string; color?: string }> = {
    unknown: { icon: "⚙", label: "Tool call" },
    running: { icon: "↻", label: "Running", color: "#fbbf24" },
    waiting: { icon: "○", label: "Waiting", color: "#fbbf24" },
    complete: { icon: "✓", label: "Completed", color: "#86efac" },
    failed: { icon: "×", label: "Failed", color: "#fda4af" },
  };
  const item = display[rendered.status];
  return (
    <span style={{ ...S.toolChip, ...(item.color ? { color: item.color } : null) }} title={item.label}>
      {item.icon} {rendered.name}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Join screen
// ---------------------------------------------------------------------------

function Join({ onJoin }: { onJoin: (name: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div style={S.joinWrap}>
      <div style={S.joinCard}>
        <h1 style={S.brand} className="glide-brand">Glide</h1>
        <p style={S.tagline}>Chat your Cloudflare config into existence — together.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const name = value.trim();
            if (name) onJoin(name);
          }}
        >
          <label style={S.label}>Your display name</label>
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. Avery"
            style={S.input}
          />
          <button type="submit" style={S.primaryBtn} disabled={!value.trim()}>
            Enter room
          </button>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main room
// ---------------------------------------------------------------------------

function Room({ name }: { name: string }) {
  const [room, setRoom] = useState<string>(() => readRoomFromHash() || newRoomId());
  const [state, setState] = useState<GlideState>();
  const [notice, setNotice] = useState<string>();
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [showTokenForm, setShowTokenForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  // The guided FORM is opt-in now; onboarding is chat-led by default.
  const [formOpen, setFormOpen] = useState(false);
  const [migBusy, setMigBusy] = useState<string>();
  const [snapBusy, setSnapBusy] = useState<string>();
  const [connected, setConnected] = useState(false);
  const [deliveryIssue, setDeliveryIssue] = useState<{ message: string; retryable: boolean }>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const guidedStartInFlight = useRef(false);
  const reverifiedToken = useRef(false);
  const connectionEpoch = useRef(0);
  const messagesRef = useRef<UIMessage[]>([]);

  const roomLink = `${location.origin}/#${encodeURIComponent(room)}`;

  // Keep the URL hash in sync so the room is shareable.
  useEffect(() => {
    const onHash = () => setRoom(readRoomFromHash() || newRoomId());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (readRoomFromHash() !== room) location.hash = room;
  }, [room]);

  const agent = useAgent<GlideState>({
    agent: "GlideAgent",
    name: room,
    onStateUpdate: (s) => setState(s),
  });

  useEffect(() => {
    const update = () => setConnected(agent.readyState === WebSocket.OPEN);
    const onClose = () => {
      connectionEpoch.current += 1;
      update();
    };
    agent.addEventListener("open", update);
    agent.addEventListener("close", onClose);
    agent.addEventListener("error", update);
    update();
    return () => {
      agent.removeEventListener("open", update);
      agent.removeEventListener("close", onClose);
      agent.removeEventListener("error", update);
    };
  }, [agent, room]);

  // `WebSocketChatTransport` treats AgentConnection.send() as void, while the
  // underlying PartySocket returns false when it only buffered the frame. Do
  // the readiness check at the actual transport send, not merely on button
  // click: prepareBody awaits before send, so the socket can close in between.
  const chatAgent = useMemo(
    () => ({
      agent: agent.agent,
      name: agent.name,
      path: agent.path,
      get connectionError() {
        return agent.connectionError;
      },
      getHttpUrl: () => agent.getHttpUrl(),
      send: (data: string) => {
        if (agent.readyState !== WebSocket.OPEN || !agent.send(data)) {
          throw new TypeError(CHAT_CONNECTION_ERROR);
        }
      },
      addEventListener: agent.addEventListener.bind(agent),
      removeEventListener: agent.removeEventListener.bind(agent),
    }),
    [agent],
  );

  const chat = useAgentChat({
    agent: chatAgent,
    // Don't block the initial render on the HTTP /get-messages fetch. In the
    // browser that `use()` promise suspends <Room> and never resolves, wedging
    // the UI on the Suspense fallback ("Loading room…"). History and live
    // messages hydrate over the WebSocket instead (resume + syncMessagesToServer).
    getInitialMessages: null,
    body: () => ({ name }),
    onError: (error) => {
      setDeliveryIssue({
        message:
          error.message === CHAT_CONNECTION_ERROR
            ? "The live connection dropped before Glide received your message. Checking delivery…"
            : `Glide could not complete that response: ${error.message}`,
        retryable: false,
      });
    },
  });

  const messages = chat.messages;
  messagesRef.current = messages;
  const visibleMessages = messages.filter((message) => !isSystemEvent(message));
  const busy =
    chat.status === "submitted" ||
    chat.status === "streaming" ||
    chat.isStreaming ||
    chat.isServerStreaming ||
    chat.isToolContinuation ||
    chat.isRecovering;

  // Escape hatch for a wedged turn. A chat stream can stop terminalizing —
  // e.g. the Durable Object was evicted mid-response (a deploy), the WebSocket
  // dropped, or a non-streaming model hung — leaving `busy` stuck true with no
  // final `finish`. `GlideAgent` runs with the stall watchdog + durable
  // recovery off, so nothing server-side kills the spinner. Without a client
  // out, the composer's Send stays disabled forever and the room looks frozen
  // ("won't let me send more messages"). So: (a) always offer a Stop button
  // while busy, and (b) if the turn goes quiet for STALL_MS, mark it `stalled`
  // — that re-enables Send and shows a hint, so the user can always recover.
  const STALL_MS = 20000;
  const [stalled, setStalled] = useState(false);
  const lastMessage = messages[messages.length - 1];
  // A signature that grows as tokens/parts stream in; used to restart the
  // stall timer so a genuinely-progressing turn never trips it.
  const progressSig = `${messages.length}:${lastMessage ? JSON.stringify(lastMessage.parts ?? "").length : 0}`;
  useEffect(() => {
    if (!busy) {
      setStalled(false);
      return;
    }
    setStalled(false);
    const timer = setTimeout(() => setStalled(true), STALL_MS);
    return () => clearTimeout(timer);
  }, [busy, progressSig]);

  const stop = useCallback(() => {
    // Cancel the active/wedged turn. Belt-and-suspenders: even if the library's
    // streaming flags lag behind, `stalled` unblocks the composer immediately.
    try {
      chat.stop?.();
    } catch {
      /* already stopped / nothing to abort */
    }
    setStalled(true);
  }, [chat]);

  // Autoscroll to the newest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [visibleMessages.length, busy]);

  const reportClientChatIssue = useCallback(
    (kind: "not_delivered" | "response_interrupted", messageId: string, epoch: number) => {
      void agent
        .call(
          "reportClientChatIssue",
          [{ kind, messageId, connectionEpoch: epoch }],
          { timeout: 5000 },
        )
        .catch(() => undefined);
    },
    [agent],
  );

  const verifyDelivery = useCallback(
    async (messageId: string, text: string, epoch: number) => {
      try {
        const url = new URL(agent.getHttpUrl(), location.origin);
        url.pathname = `${url.pathname.replace(/\/$/, "")}/get-messages`;
        url.searchParams.delete("_pk");
        const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const persisted = (await response.json()) as Array<{ id?: string; role?: string }>;
        const status = persistedDeliveryStatus(persisted, messageId);
        if (status === "delivered") {
          setDeliveryIssue(undefined);
          return;
        }

        reportClientChatIssue(status, messageId, epoch);
        if (status === "not_delivered") {
          chat.setMessages((current) => current.filter((message) => message.id !== messageId));
          setDraft((current) => (current.trim() ? current : text));
          setDeliveryIssue({
            message:
              "That message was not delivered. It has been restored to the composer; wait for Live, then press Send again.",
            retryable: false,
          });
          return;
        }

        setDeliveryIssue({
          message: "Your message reached Glide, but the assistant response was interrupted.",
          retryable: true,
        });
      } catch {
        setDeliveryIssue({
          message:
            "The connection was interrupted and delivery could not be confirmed. Reconnect, then retry the response.",
          retryable: true,
        });
      }
    },
    [agent, chat, reportClientChatIssue],
  );

  const finishDeliveryCheck = useCallback(
    async (messageId: string, text: string, epoch: number) => {
      // Let React publish the final streamed message before consulting the ref.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const locallyDelivered = persistedDeliveryStatus(messagesRef.current, messageId) === "delivered";
      if (connectionEpoch.current === epoch && locallyDelivered) return;
      await verifyDelivery(messageId, text, epoch);
    },
    [verifyDelivery],
  );

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    if (containsCloudflareApiToken(text)) {
      setDeliveryIssue({
        message: "For safety, API tokens cannot be sent in chat. Add it under Connection → Set token instead.",
        retryable: false,
      });
      return;
    }
    if (agent.readyState !== WebSocket.OPEN) {
      setDeliveryIssue({
        message: "Glide is reconnecting. Your draft is safe; send it when the Live badge returns.",
        retryable: false,
      });
      return;
    }
    if (busy && !stalled) return; // a live turn is still streaming — let it finish
    if (busy) stop(); // the turn looks wedged: cancel it before starting a new one
    const messageId = crypto.randomUUID();
    const epoch = connectionEpoch.current;
    chat.clearError();
    setDeliveryIssue(undefined);
    setDraft("");
    void chat
      .sendMessage({
        id: messageId,
        role: "user",
        parts: [{ type: "text", text }],
        metadata: { name } satisfies GlideMessageMetadata,
      })
      .then(() => finishDeliveryCheck(messageId, text, epoch));
  }, [draft, agent, busy, stalled, stop, chat, name, finishDeliveryCheck]);

  const retryInterruptedResponse = useCallback(() => {
    const last = messagesRef.current[messagesRef.current.length - 1];
    if (!last || last.role !== "user") {
      setDeliveryIssue({ message: "There is no interrupted user turn to retry.", retryable: false });
      return;
    }
    if (agent.readyState !== WebSocket.OPEN) {
      setDeliveryIssue({ message: "Glide is still reconnecting. Retry when the Live badge returns.", retryable: true });
      return;
    }
    const epoch = connectionEpoch.current;
    const text = messageText(last).text;
    chat.clearError();
    setDeliveryIssue(undefined);
    void chat.sendMessage().then(() => finishDeliveryCheck(last.id, text, epoch));
  }, [agent, chat, finishDeliveryCheck]);

  const runRpc = useCallback(
    async <T = unknown>(
      method: string,
      args: unknown[],
      options?: { timeout?: number },
    ): Promise<T | undefined> => {
      try {
        setNotice(undefined);
        return (await agent.call(method, args, options)) as T;
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
        return undefined;
      }
    },
    [agent],
  );

  // A token stored by an older build — or one whose `/user/tokens/verify` call
  // 401'd despite the token being perfectly usable — can get stuck showing
  // "token unverified" forever, since validity was only ever checked at save
  // time. Re-check the stored token once per mount whenever the badge says
  // unverified so it self-corrects (via the read-based fallback) without the
  // user having to re-enter it. The ref guard prevents a loop if it stays bad.
  useEffect(() => {
    if (reverifiedToken.current) return;
    if (state?.tokenConfigured && state.tokenValid === false) {
      reverifiedToken.current = true;
      void runRpc("reverifyToken", []);
    }
  }, [state?.tokenConfigured, state?.tokenValid, runRpc]);

  const saveToken = useCallback(async () => {
    const value = tokenInput.trim();
    if (!value) return;
    const res = await runRpc<{ ok: boolean; message: string }>("setCloudflareToken", [value]);
    setTokenInput("");
    setShowTokenForm(false);
    if (res) setNotice(res.message);
  }, [tokenInput, runRpc]);

  const invite = useCallback(async () => {
    const email = inviteEmail.trim();
    if (!email) return;
    const res = await runRpc<{ ok: boolean; message: string }>("inviteTeammate", [
      email,
      name,
      roomLink,
    ]);
    if (res && !res.ok) {
      setNotice(res.message);
      return;
    }
    setInviteEmail("");
    // Open the user's mail client with a prefilled invite (works for anyone).
    const subject = encodeURIComponent(`Join me in the Glide room #${room}`);
    const lines = [
      `${name} invited you to the Glide room "#${room}".`,
      "",
      `Open it here: ${roomLink}`,
      "",
      "Glide is a shared room that drives Cloudflare configuration via chat.",
    ];
    window.location.href = `mailto:${encodeURIComponent(email)}?subject=${subject}&body=${encodeURIComponent(
      lines.join("\n"),
    )}`;
  }, [inviteEmail, name, room, roomLink, runRpc]);

  const apply = useCallback(
    async (id: string) => {
      setBusyIds((prev) => new Set(prev).add(id));
      try {
        const result = await runRpc<ActionResult>(
          "applyAction",
          [id, name],
          { timeout: APPLY_RPC_TIMEOUT_MS },
        );
        if (result?.status === "failed") {
          setNotice(
            result.detail.startsWith("Outcome uncertain:")
              ? result.detail
              : `${result.detail} The action is still queued so you can retry it.`,
          );
        }
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [runRpc, name],
  );

  // ---- Onboarding wizard callbacks ----
  const patchOnboarding = useCallback(
    (patch: Record<string, unknown>) => runRpc("updateOnboarding", [patch, name]),
    [runRpc, name],
  );
  const previewMigration = useCallback(
    (args: {
      provider: string;
      config?: string;
      configUrl?: string;
      configFiles?: Array<{ filename: string; content: string }>;
      format?: string;
    }) => runRpc<{ ok: boolean; message: string; totalRules?: number }>("previewMigration", [args, name]),
    [runRpc, name],
  );
  const finishOnboarding = useCallback(
    (kickoff: string) => {
      void runRpc("completeOnboarding", [name]);
      setFormOpen(false);
      if (kickoff.trim()) {
        void chat.sendMessage({ text: kickoff, metadata: { name } satisfies GlideMessageMetadata });
      }
    },
    [runRpc, name, chat],
  );

  // Kick off the chat-led guided setup: start onboarding, optionally pin the
  // branch so the sidebar updates instantly, then let Glide ask the next
  // question. The checklist on the right auto-fills as answers come in.
  const startGuided = useCallback(
    async (path?: OnboardingPath) => {
      if (guidedStartInFlight.current) return;
      guidedStartInFlight.current = true;
      setFormOpen(false);
      try {
        const started = await runRpc<{ ok: boolean }>("startOnboarding", [name]);
        if (!started?.ok) return;
        if (path) {
          const updated = await runRpc<{ ok: boolean }>("updateOnboarding", [{ path }, name]);
          if (!updated?.ok) return;
        }
        const text =
          path === "migrate"
            ? "I'm migrating to Cloudflare from another provider — walk me through it one step at a time."
            : path === "fresh"
              ? "I'm setting up Cloudflare fresh — walk me through it one step at a time."
              : "Help me get set up on Cloudflare — ask me what you need, one question at a time.";
        await chat.sendMessage({ text, metadata: { name } satisfies GlideMessageMetadata });
      } finally {
        guidedStartInFlight.current = false;
      }
    },
    [runRpc, name, chat],
  );

  // Wipe this room's onboarding so the guided flow starts over. The room is
  // durable and keyed by the URL hash, so a hard refresh keeps prior progress;
  // this is the intended "start fresh" without opening a new room. Pending
  // approvals and chat history are kept.
  const resetOnboarding = useCallback(() => {
    if (
      !window.confirm(
        "Reset onboarding for this room? This clears the path, domain, DNS setup, goals, and checklist so the guided flow starts over. Pending approvals and chat history are kept.",
      )
    )
      return;
    void runRpc("resetOnboarding", [name]);
    setFormOpen(false);
  }, [runRpc, name]);

  const onboarding = state?.onboarding;
  // Form is opt-in: only show when the user explicitly opens it.
  const showWizard = !!state && formOpen && !onboarding?.completed;

  const pending = state?.pendingActions ?? [];
  const memory = useMemo(() => Object.entries(state?.memory ?? {}), [state?.memory]);
  const anyActionApplying = pending.some(
    (action) => busyIds.has(action.id) || isActionApplying(action),
  );

  const applyAll = useCallback(async () => {
    if (!state?.tokenConfigured) {
      setShowTokenForm(true);
      setNotice("Add a Cloudflare API token before applying queued changes.");
      return;
    }
    const ids = pending.filter((action) => !isActionApplying(action)).map((action) => action.id);
    if (!ids.length) return;
    setBusyIds((prev) => new Set([...prev, ...ids]));
    try {
      const results = await runRpc<ActionResult[]>(
        "applyAll",
        [name],
        { timeout: APPLY_RPC_TIMEOUT_MS * ids.length },
      );
      const failures = results?.filter((result) => result.status === "failed") ?? [];
      if (failures.length) {
        setNotice(
          `${failures.length} action${failures.length === 1 ? "" : "s"} failed and remain queued for retry.`,
        );
      }
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    }
  }, [name, pending, runRpc, state?.tokenConfigured]);

  return (
    <div style={S.shell}>
      <header style={S.header}>
        <div style={S.headerLeft}>
          <span style={S.brandSm} className="glide-brand">Glide</span>
          <span style={S.roomPill}>
            #
            <input
              value={room}
              onChange={(e) => setRoom(e.target.value.trim() || "lobby")}
              style={S.roomInput}
              aria-label="Room name"
            />
          </span>
          <span style={S.safetyPill} title="Reads run automatically. Writes always wait for your approval.">
            <span style={S.safetyDotRead} /> reads run
            <span style={S.safetyDivider}>·</span>
            <span style={S.safetyDotWrite} /> writes wait
          </span>
        </div>
        <div style={S.headerRight}>
          <span
            style={{
              ...S.badge,
              background: connected ? "rgba(34,197,94,.16)" : "rgba(245,158,11,.14)",
              color: connected ? "#6ee7b7" : "#fcd34d",
              border: connected ? "1px solid rgba(34,197,94,.4)" : "1px solid rgba(245,158,11,.4)",
            }}
          >
            {connected ? "live" : "reconnecting"}
          </span>
          {state ? (
            state.tokenValid === false ? (
              <span style={{ ...S.badge, background: "rgba(202,138,4,.16)", color: "#fde68a", border: "1px solid rgba(202,138,4,.5)" }}>token unverified</span>
            ) : state.tokenConfigured ? (
              <span style={{ ...S.badge, background: "rgba(34,197,94,.16)", color: "#6ee7b7", border: "1px solid rgba(34,197,94,.4)" }}>token ✓</span>
            ) : (
              <span style={{ ...S.badge, background: "rgba(244,63,94,.16)", color: "#fda4af", border: "1px solid rgba(244,63,94,.4)" }}>no token</span>
            )
          ) : (
            <span style={{ ...S.badge, background: "rgba(148,163,184,.14)", color: "#cbd5e1", border: "1px solid rgba(148,163,184,.28)" }}>connecting…</span>
          )}
          <a href={`/admin#${encodeURIComponent(room)}`} style={S.headerLink} title="Open the read-only admin dashboard for this room">
            Admin →
          </a>
          <span style={S.you}>{name}</span>
        </div>
      </header>

      {state &&
        (state.tokenValid === false ? (
          <div style={S.warnBar}>
            The saved Cloudflare API token failed verification. Review or replace it in{" "}
            <strong>Connection → Change</strong> before account discovery or Apply.
          </div>
        ) : !state.tokenConfigured ? (
          <div style={S.warnBar}>
            No Cloudflare API token yet. You can chat and queue changes, but Apply is blocked until you
            add one in <strong>Connection → Set token</strong> (right sidebar). It’s stored encrypted.
          </div>
        ) : null)}

      <div style={S.body}>
        {/* Chat column */}
        <main style={S.chatCol}>
          {showWizard && (
            <div style={S.wizPane}>
              <OnboardingWizard
                onboarding={onboarding}
                tokenConfigured={!!state?.tokenConfigured}
                migrationToolConfigured={state?.migrationToolConfigured}
                migrationPlan={state?.migrationPlan}
                onPatch={patchOnboarding}
                onPreview={previewMigration}
                onSaveToken={(t) => runRpc<{ ok: boolean; message: string }>("setCloudflareToken", [t])}
                onFinish={finishOnboarding}
                onDismiss={() => setFormOpen(false)}
              />
            </div>
          )}

          <div ref={scrollRef} style={S.messages}>
            {visibleMessages.length === 0 &&
              (showWizard ? (
                <div style={S.empty}>
                  <p style={{ margin: 0, fontWeight: 600 }}>Questions? Ask Glide here anytime 👇</p>
                  <p style={{ marginTop: 6, color: "#9ca3af" }}>
                    The guided form is above — or just chat. Ask things like “what's the difference between
                    Full and Partial DNS?” or “what token permissions do I need?”.
                  </p>
                </div>
              ) : onboarding?.completed ? (
                <div style={S.empty}>
                  <p style={{ margin: 0, fontWeight: 600 }}>Say hello 👋</p>
                  <p style={{ marginTop: 6, color: "#9ca3af" }}>
                    Try: “find the zone example.com and list its DNS records”, or “block traffic from RU on
                    example.com”. Reads run instantly; changes wait for someone to Apply.
                  </p>
                </div>
              ) : onboarding?.active ? (
                // Onboarding was already started (e.g. via the guided form) but there
                // are no chat messages yet — resume, don't re-ask the first question.
                // The checklist/progress on the right reflects what's captured; offer
                // to continue in chat or Reset to truly start over.
                <div style={S.empty}>
                  <p style={{ margin: 0, fontWeight: 600 }}>Onboarding in progress 👉</p>
                  <p style={{ marginTop: 6, color: "#9ca3af" }}>
                    Your answers so far are in the checklist on the right. Ask Glide “what's next?” to
                    continue, open <strong>Use form</strong> to edit answers, or hit <strong>Reset</strong>{" "}
                    in the Onboarding panel to start over.
                  </p>
                </div>
              ) : (
                <GuidedIntro onChoose={(p) => startGuided(p)} onUseForm={() => setFormOpen(true)} />
              ))}
            {visibleMessages.map((m) => {
              const { text, tools } = messageText(m);
              const who =
                m.role === "user"
                  ? (m.metadata as GlideMessageMetadata | undefined)?.name ?? "teammate"
                  : "Glide";
              const mine = m.role === "user" && who === name;
              return (
                <div key={m.id} style={{ ...S.msgRow, justifyContent: mine ? "flex-end" : "flex-start" }}>
                  {!mine && (
                    <div style={{ ...S.avatar, ...(m.role === "user" ? S.avatarUser : S.avatarAi) }}>
                      {m.role === "user" ? who.charAt(0).toUpperCase() : "G"}
                    </div>
                  )}
                  <div style={{ ...S.bubble, ...(m.role === "user" ? S.userBubble : S.aiBubble), ...(mine ? S.mineBubble : null) }}>
                    <div style={S.msgWho}>{m.role === "user" ? who : "Glide"}</div>
                    {text && <div style={S.msgText}>{text}</div>}
                    {tools.map((tool) => (
                      <ToolChip key={tool.id} tool={tool} />
                    ))}
                    {!text &&
                      tools.some((tool) =>
                        ["unknown", "running", "waiting"].includes(tool.status),
                      ) &&
                      m.role !== "user" && (
                      <div style={{ fontSize: 12, color: "#6b7280", fontStyle: "italic", marginTop: 6 }}>
                        Working on that… say “continue” if this pauses.
                      </div>
                    )}
                    {!text &&
                      tools.length > 0 &&
                      tools.every((tool) => tool.status === "complete" || tool.status === "failed") &&
                      m.role !== "user" && (
                        <div style={{ fontSize: 12, color: "#94a3b8", fontStyle: "italic", marginTop: 6 }}>
                          {tools.some((tool) => tool.status === "failed")
                            ? "The tool reported an error. See the next message for the recovery step."
                            : "Tool completed."}
                        </div>
                      )}
                  </div>
                  {mine && (
                    <div style={{ ...S.avatar, ...S.avatarMine }}>{who.charAt(0).toUpperCase()}</div>
                  )}
                </div>
              );
            })}
            {busy && (
              <div style={{ ...S.msgRow, justifyContent: "flex-start" }}>
                <div style={{ ...S.avatar, ...S.avatarAi }}>G</div>
                <div style={{ ...S.bubble, ...S.aiBubble }}>
                  <div style={S.msgWho}>Glide</div>
                  {stalled ? (
                    <div style={S.stallHint}>
                      Still working on the last step. If it looks stuck, press <strong>Stop</strong>{" "}
                      and send your message again.
                    </div>
                  ) : (
                    <div style={S.typing} className="glide-dots" aria-label="Glide is thinking">
                      <span />
                      <span />
                      <span />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {!connected && (
            <div style={S.connectionNotice}>
              Reconnecting to this room. Drafts remain local and Send is paused until the connection is live.
            </div>
          )}
          {deliveryIssue && (
            <div style={S.deliveryNotice}>
              <span>{deliveryIssue.message}</span>
              {deliveryIssue.retryable && (
                <button
                  style={S.deliveryRetryBtn}
                  disabled={!connected}
                  onClick={retryInterruptedResponse}
                >
                  Retry response
                </button>
              )}
            </div>
          )}

          <div style={S.composer}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={
                !connected
                  ? "Reconnecting… your draft is safe"
                  : showWizard
                  ? "Ask Glide a question while you set up…  (Enter to send)"
                  : `Message #${room}…  (Enter to send, Shift+Enter for newline)`
              }
              rows={2}
              style={S.textarea}
            />
            {busy && (
              <button onClick={stop} style={S.stopBtn} title="Stop the current response">
                Stop
              </button>
            )}
            <button onClick={send} disabled={!connected || !draft.trim() || (busy && !stalled)} style={S.sendBtn}>
              Send
            </button>
          </div>
        </main>

        {/* Sidebar */}
        <aside style={S.sidebar}>
          {notice && <div style={S.errorBox}>{notice}</div>}

          <Section title="Connection">
            {state?.tokenConfigured && !showTokenForm ? (
              <>
                <div style={S.tokenStatus}>
                  <span
                    style={{ ...S.dot, marginTop: 0, background: state.tokenValid === false ? "#ca8a04" : "#16a34a" }}
                  />
                  <span style={{ fontSize: 13 }}>
                    Token set{state.tokenLast4 ? ` ••••${state.tokenLast4}` : ""}
                    {state.tokenValid === false
                      ? " · unverified"
                      : state.tokenValid
                        ? " · verified"
                        : ""}
                  </span>
                </div>
                <div style={S.actionBtns}>
                  <button
                    style={S.rejectBtn}
                    onClick={() => {
                      setTokenInput("");
                      setShowTokenForm(true);
                    }}
                  >
                    Change
                  </button>
                  <button style={S.rejectBtn} onClick={() => runRpc("clearCloudflareToken", [])}>
                    Remove
                  </button>
                </div>
              </>
            ) : (
              <>
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveToken();
                  }}
                  placeholder="Cloudflare API token"
                  autoComplete="off"
                  spellCheck={false}
                  style={{ ...S.input, marginBottom: 8 }}
                />
                <div style={S.actionBtns}>
                  <button style={S.applyBtn} disabled={!tokenInput.trim()} onClick={() => void saveToken()}>
                    Save securely
                  </button>
                  {state?.tokenConfigured && (
                    <button style={S.rejectBtn} onClick={() => setShowTokenForm(false)}>
                      Cancel
                    </button>
                  )}
                </div>
                <p style={S.hint}>
                  Stored AES-256-GCM encrypted at rest; never shown again. Create one at
                  dash.cloudflare.com/profile/api-tokens.
                </p>
              </>
            )}
          </Section>

          <Section
            title="Onboarding"
            action={
              onboarding?.completed ? (
                <span style={{ display: "inline-flex", gap: 6 }}>
                  <button
                    style={S.miniBtn}
                    onClick={() => {
                      void runRpc("updateOnboarding", [{ completed: false }, name]);
                      setFormOpen(false);
                    }}
                  >
                    Re-run
                  </button>
                  <button style={S.miniBtn} onClick={resetOnboarding} title="Clear onboarding and start over">
                    Reset
                  </button>
                </span>
              ) : onboarding?.active ? (
                <span style={{ display: "inline-flex", gap: 6 }}>
                  <button style={S.miniBtn} onClick={() => setFormOpen(true)}>
                    Use form
                  </button>
                  <button style={S.miniBtn} onClick={resetOnboarding} title="Clear onboarding and start over">
                    Reset
                  </button>
                </span>
              ) : undefined
            }
          >
            {!onboarding?.active ? (
              <>
                <Muted>
                  Guided, Cloudflare-grounded setup. Chat with Glide one question at a time — this checklist
                  fills itself in as you answer — or click through a form.
                </Muted>
                <div style={{ ...S.actionBtns, marginTop: 10 }}>
                  <button style={S.applyBtn} onClick={() => startGuided()}>
                    Start in chat
                  </button>
                  <button style={S.rejectBtn} onClick={() => setFormOpen(true)}>
                    Use form
                  </button>
                </div>
              </>
            ) : (
              <OnboardingPanel
                onboarding={onboarding}
                onToggle={(id, done) => runRpc("toggleOnboardingStep", [id, done, name])}
              />
            )}
          </Section>

          {(state?.defaultAccountId || state?.defaultZone) && (
            <Section title="Defaults">
              {state?.defaultAccountId && <KV k="account" v={state.defaultAccountId} />}
              {state?.defaultZone && <KV k="zone" v={`${state.defaultZone.name} (${state.defaultZone.id})`} />}
            </Section>
          )}

          <Section
            title={`Pending approvals${pending.length ? ` · ${pending.length}` : ""}`}
            action={
              pending.length > 1 ? (
                <button style={S.miniBtn} disabled={anyActionApplying} onClick={() => void applyAll()}>
                  {anyActionApplying
                    ? "Applying…"
                    : state?.tokenConfigured
                      ? "Apply all"
                      : "Set token first"}
                </button>
              ) : undefined
            }
          >
            {pending.length === 0 && <Muted>Nothing queued. Ask Glide to make a change.</Muted>}
            {pending.map((a: PendingAction) => {
              const status = pendingActionStatus(a);
              const applying = busyIds.has(a.id) || isActionApplying(a);
              const failed = status === "failed" || (status === "applying" && !applying);
              const uncertain = failed && a.error?.startsWith("Outcome uncertain:");
              const statusLabel = applying
                ? "applying"
                : uncertain
                  ? "outcome uncertain"
                  : failed
                    ? "failed - retryable"
                    : "pending";
              const statusColor = applying ? "#fbbf24" : failed ? "#fda4af" : "#fdba74";
              return (
                <div
                  key={a.id}
                  style={S.actionCard}
                  className={`glide-pending glide-pending--${applying ? "applying" : failed ? "failed" : "waiting"} glide-lift`}
                >
                  <div style={S.actionTop}>
                    <span style={{ ...S.method, background: METHOD_COLORS[a.method] ?? "#6b7280" }}>{a.method}</span>
                    <span style={S.product}>{a.product}</span>
                    <span style={{ ...S.listMeta, marginLeft: "auto", color: statusColor }}>{statusLabel}</span>
                  </div>
                  <div style={S.actionSummary}>{a.summary}</div>
                  <code style={S.path}>{a.path}</code>
                  {a.body !== undefined && (
                    <details style={S.bodyDetails}>
                      <summary style={S.bodySummary}>Request body</summary>
                      <pre style={S.bodyPre}>{JSON.stringify(a.body, null, 2)}</pre>
                      {a.mergeEntrypoint && (
                        <div style={S.bodyNote}>
                          Preview only — on Apply, Glide re-reads this ruleset's current rules and appends
                          the {a.mergeEntrypoint.newRules.length} new rule(s), so existing rules aren't dropped.
                        </div>
                      )}
                    </details>
                  )}
                  {failed && a.error && <div style={{ ...S.errorBox, marginTop: 8 }}>{a.error}</div>}
                  <div style={S.actionMeta}>by {a.createdBy}</div>
                  <div style={S.actionBtns}>
                    <button
                      style={{ ...S.applyBtn, opacity: applying ? 0.6 : 1 }}
                      disabled={applying}
                      onClick={() => {
                        if (!state?.tokenConfigured) {
                          setShowTokenForm(true);
                          setNotice("Add a Cloudflare API token before applying this change.");
                          return;
                        }
                        if (
                          uncertain &&
                          !window.confirm(
                            "Cloudflare may already have applied this change. Verify the live configuration first. Retry anyway?",
                          )
                        ) {
                          return;
                        }
                        void apply(a.id);
                      }}
                    >
                      {applying
                        ? "Applying…"
                        : !state?.tokenConfigured
                          ? "Set token first"
                          : uncertain
                            ? "Retry anyway"
                            : failed
                              ? "Retry"
                            : "Apply"}
                    </button>
                    <button
                      style={S.rejectBtn}
                      disabled={applying}
                      onClick={() => void runRpc("rejectAction", [a.id, name])}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              );
            })}
          </Section>

          {state?.migrationPlan && (
            <Section title="Migration plan">
              <MigrationPlanPanel plan={state.migrationPlan} />
              <div style={{ ...S.actionBtns, marginTop: 10, flexWrap: "wrap" }}>
                <button
                  style={S.miniBtn}
                  disabled={!!migBusy}
                  onClick={async () => {
                    setMigBusy("preflight");
                    await runRpc("runPreflight", [state?.defaultZone?.id, name]);
                    setMigBusy(undefined);
                  }}
                >
                  {migBusy === "preflight" ? "Checking…" : "Pre-flight"}
                </button>
                <button
                  style={S.miniBtn}
                  disabled={!!migBusy}
                  onClick={async () => {
                    setMigBusy("diff");
                    await runRpc("runDiffReport", [state?.defaultZone?.id, name]);
                    setMigBusy(undefined);
                  }}
                >
                  {migBusy === "diff" ? "Diffing…" : "Diff zone"}
                </button>
                <button
                  style={S.miniBtn}
                  disabled={!!migBusy}
                  onClick={async () => {
                    setMigBusy("validate");
                    await runRpc("runValidate", [state?.defaultZone?.id, name]);
                    setMigBusy(undefined);
                  }}
                >
                  {migBusy === "validate" ? "Validating…" : "Validate"}
                </button>
                <button
                  style={S.miniBtn}
                  disabled={!!migBusy}
                  onClick={async () => {
                    setMigBusy("csv");
                    await runRpc("exportMigrationCsv", [name]);
                    setMigBusy(undefined);
                  }}
                >
                  {migBusy === "csv" ? "Exporting…" : "Export CSV"}
                </button>
              </div>
              {state.migrationCheck && (
                <div
                  style={{
                    ...S.checkBox,
                    borderColor: state.migrationCheck.ok ? "#14532d" : "#7c2d12",
                    background: state.migrationCheck.ok ? "#052e16" : "#422006",
                    color: state.migrationCheck.ok ? "#86efac" : "#fed7aa",
                  }}
                >
                  <b>
                    {state.migrationCheck.kind === "preflight"
                      ? "Pre-flight"
                      : state.migrationCheck.kind === "validate"
                        ? "Validation"
                        : "Diff"}
                    :
                  </b>{" "}
                  {state.migrationCheck.summary}
                </div>
              )}
            </Section>
          )}

          {state?.csv && state.csv.files.length > 0 && (
            <Section title={`CSV export · ${state.csv.files.length}`}>
              {state.csv.files.map((f) => (
                <div key={f.filename} style={S.tfRow}>
                  <code style={S.tfName}>{f.filename}</code>
                  <button style={S.miniBtn} onClick={() => downloadText(f.filename, f.content)}>
                    Download
                  </button>
                </div>
              ))}
            </Section>
          )}

          {state?.terraform && state.terraform.files.length > 0 && (
            <Section title={`Terraform export · ${state.terraform.files.length}`}>
              {state.terraform.files.map((f) => (
                <div key={f.filename} style={S.tfRow}>
                  <code style={S.tfName}>{f.filename}</code>
                  <button style={S.miniBtn} onClick={() => downloadText(f.filename, f.content)}>
                    Download
                  </button>
                </div>
              ))}
              {state.terraform.files.length > 1 && (
                <button
                  style={{ ...S.miniBtn, marginTop: 8 }}
                  onClick={() =>
                    downloadText(
                      `${state!.terraform!.provider}-cloudflare.tf`,
                      state!.terraform!.files.map((f) => `# ${f.filename}\n${f.content}`).join("\n\n"),
                    )
                  }
                >
                  Download all (.tf)
                </button>
              )}
            </Section>
          )}

          {state?.migrationToolConfigured !== false &&
            (state?.defaultZone || (state?.snapshots?.length ?? 0) > 0 || state?.migrationPlan) && (
              <Section
                title={`Zone snapshots${(state?.snapshots?.length ?? 0) ? ` · ${state!.snapshots!.length}` : ""}`}
                action={
                  <button
                    style={S.miniBtn}
                    disabled={!!snapBusy}
                    onClick={async () => {
                      setSnapBusy("new");
                      const res = await runRpc<{ ok: boolean; message: string }>("snapshotZone", [
                        state?.defaultZone?.id,
                        name,
                      ]);
                      setSnapBusy(undefined);
                      if (res) setNotice(res.message);
                    }}
                  >
                    {snapBusy === "new" ? "Saving…" : "Snapshot now"}
                  </button>
                }
              >
                {(state?.snapshots?.length ?? 0) === 0 ? (
                  <Muted>
                    No restore points yet. Capture one (read-only) before applying migration changes, so you can
                    roll back.
                  </Muted>
                ) : (
                  state!.snapshots!.map((s) => (
                    <div key={s.id} style={S.snapRow}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={S.snapZone}>{s.zoneName || s.zoneId}</div>
                        <div style={S.snapMeta}>{new Date(s.created).toLocaleString()}</div>
                      </div>
                      <button
                        style={S.snapRestore}
                        disabled={!!snapBusy}
                        onClick={async () => {
                          const ok = window.confirm(
                            `Restore ${s.zoneName || s.zoneId} to this snapshot?\n\nThis is DESTRUCTIVE: it reverts the zone to the snapshot state, removing rules/settings created since ${new Date(
                              s.created,
                            ).toLocaleString()}.`,
                          );
                          if (!ok) return;
                          setSnapBusy(s.id);
                          const res = await runRpc<{ ok: boolean; message: string }>("restoreSnapshot", [
                            s.id,
                            s.zoneId,
                            name,
                          ]);
                          setSnapBusy(undefined);
                          if (res) setNotice(res.message);
                        }}
                      >
                        {snapBusy === s.id ? "Restoring…" : "Restore"}
                      </button>
                    </div>
                  ))
                )}
                <p style={S.hint}>Restore reverts the zone to a snapshot (destructive). It's a manual action — Glide never auto-restores.</p>
              </Section>
            )}

          <Section
            title={`Invite teammates${(state?.invites?.length ?? 0) ? ` · ${state!.invites.length}` : ""}`}
          >
            <div style={S.inviteRow}>
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void invite();
                }}
                placeholder="name@company.com"
                autoComplete="off"
                style={{ ...S.input, marginBottom: 0 }}
              />
              <button style={S.miniPrimary} disabled={!inviteEmail.trim()} onClick={() => void invite()}>
                Invite
              </button>
            </div>
            <p style={S.hint}>
              ⚠ Anyone with this room link can read it and <strong>Apply changes</strong> using its token —
              there’s no separate login. Share it only with teammates. Opens a prefilled email, or copy it:
            </p>
            <div style={S.linkRow}>
              <code style={S.linkCode}>{roomLink}</code>
              <button style={S.miniBtn} onClick={() => navigator.clipboard?.writeText(roomLink)}>
                Copy
              </button>
            </div>
            {(state?.invites ?? []).map((inv) => (
              <div key={inv.email} style={S.inviteItem}>
                <span style={{ fontSize: 13, wordBreak: "break-all" }}>{inv.email}</span>
                <span style={S.inviteBy}>by {inv.invitedBy}</span>
              </div>
            ))}
          </Section>

          {memory.length > 0 && (
            <Section title="Room memory">
              {memory.map(([k, v]) => (
                <KV key={k} k={k} v={v} />
              ))}
            </Section>
          )}

          {(state?.recentResults?.length ?? 0) > 0 && (
            <Section title="Recent results">
              {state!.recentResults.map((r) => (
                <div key={`${r.id}-${r.ts}`} style={S.resultRow}>
                  <span style={{ ...S.dot, background: STATUS_COLORS[r.status] }} />
                   <div style={{ flex: 1 }}>
                     <div style={S.resultSummary}>{r.summary}</div>
                     <div style={S.resultDetail}>{r.detail}</div>
                     <div style={S.listMeta}>
                       {r.status} · by {r.by} · {relTime(r.ts)}
                     </div>
                   </div>
                </div>
              ))}
            </Section>
          )}
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny sidebar building blocks
// ---------------------------------------------------------------------------

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={S.section} className="glide-lift">
      <div style={S.sectionHead}>
        <h3 style={S.sectionTitle}>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div style={S.kv}>
      <span style={S.kvKey}>{k}</span>
      <span style={S.kvVal}>{v}</span>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: 0, color: "#6b7280", fontSize: 13 }}>{children}</p>;
}

/**
 * Chat-led onboarding opener. Renders a Glide-styled greeting that asks the
 * first branching question with one-tap quick replies; answering hands the
 * conversation to Glide, which keeps asking one question at a time while the
 * sidebar checklist auto-fills. A form remains available as an opt-in.
 */
function GuidedIntro({
  onChoose,
  onUseForm,
}: {
  onChoose: (path: OnboardingPath) => void;
  onUseForm: () => void;
}) {
  return (
    <div style={S.introWrap}>
      <div style={S.introBubble}>
        <div style={S.msgWho}>Glide</div>
        <div style={S.introTitle}>👋 Let's get you onto Cloudflare.</div>
        <div style={S.introText}>
          I'll guide you one question at a time and tick off the checklist on the right as we go. To start —
          are you <b>migrating from another provider</b>, or <b>starting fresh</b>?
        </div>
        <div style={S.introChoices}>
          <button style={S.introChoice} onClick={() => onChoose("migrate")}>
            Migrating from a provider
          </button>
          <button style={S.introChoice} onClick={() => onChoose("fresh")}>
            Starting fresh
          </button>
        </div>
        <div style={S.introFoot}>
          Prefer clicking through a form?{" "}
          <button style={S.introLink} onClick={onUseForm}>
            Use the guided form
          </button>{" "}
          · or just type your answer below.
        </div>
      </div>
    </div>
  );
}

function OnboardingPanel({
  onboarding,
  onToggle,
}: {
  onboarding: OnboardingState;
  onToggle: (id: string, done: boolean) => void;
}) {
  const done = onboarding.checklist.filter((s) => s.done).length;
  const pct = onboarding.checklist.length ? Math.round((100 * done) / onboarding.checklist.length) : 0;
  return (
    <>
      {onboarding.path && (
        <KV
          k="path"
          v={`${onboarding.path === "migrate" ? "Migrate" : "Start fresh"}${onboarding.completed ? " · done ✓" : ""}`}
        />
      )}
      {onboarding.domain && <KV k="domain" v={onboarding.domain} />}
      {onboarding.setupType && <KV k="setup" v={setupLabel(onboarding.setupType)} />}
      {(onboarding.migratingFromLabel || onboarding.migratingFrom) && (
        <KV k="from" v={onboarding.migratingFromLabel ?? onboarding.migratingFrom ?? ""} />
      )}
      {onboarding.goals.length > 0 && <KV k="goals" v={onboarding.goals.map(goalLabel).join(", ")} />}
      <div style={S.progressWrap} title={`${done}/${onboarding.checklist.length} steps`}>
        <div style={{ ...S.progressBar, width: `${pct}%` }} />
      </div>
      <div style={S.checklist}>
        {onboarding.checklist.map((s) => (
          <label key={s.id} style={S.checkItem}>
            <input
              type="checkbox"
              checked={s.done}
              onChange={(e) => onToggle(s.id, e.target.checked)}
            />
            <span
              style={{
                textDecoration: s.done ? "line-through" : "none",
                color: s.done ? "#6b7280" : "#e5e7eb",
              }}
            >
              {s.label}
            </span>
          </label>
        ))}
      </div>
    </>
  );
}

function MigrationPlanPanel({ plan }: { plan: MigrationPlan }) {
  const queued = plan.rules.filter((r) => r.queued).length;
  return (
    <>
      <KV k="provider" v={plan.providerLabel} />
      <KV k="rules" v={`${plan.totalRules}${plan.truncated ? "+" : ""} · ${queued} queued`} />
      <div style={S.phaseTags}>
        {plan.phases.map((ph) => (
          <span key={ph.key} style={S.phaseTag}>
            {ph.label}: {ph.count}
          </span>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Onboarding wizard — a guided, branching setup flow.
// ---------------------------------------------------------------------------

interface WizardProps {
  onboarding?: OnboardingState;
  tokenConfigured: boolean;
  migrationToolConfigured?: boolean;
  migrationPlan?: MigrationPlan;
  onPatch: (patch: Record<string, unknown>) => Promise<unknown>;
  onPreview: (args: {
    provider: string;
    config?: string;
    configUrl?: string;
    configFiles?: Array<{ filename: string; content: string }>;
    format?: string;
  }) => Promise<{ ok: boolean; message: string; totalRules?: number } | undefined>;
  onSaveToken: (token: string) => Promise<{ ok: boolean; message: string } | undefined>;
  onFinish: (kickoff: string) => void;
  onDismiss: () => void;
}

const WIZARD_COPY: Record<string, { title: string; why: string }> = {
  branch: {
    title: "How are you setting up Cloudflare?",
    why: "This tailors every step. Migrating pulls your existing WAF/CDN/DNS config into Cloudflare equivalents; starting fresh sets you up cleanly from scratch.",
  },
  provider: {
    title: "Which provider are you migrating from?",
    why: "We translate that provider's rules into Cloudflare's — read-only, so nothing changes until you approve it.",
  },
  scope: {
    title: "What do you want to bring over?",
    why: "We'll focus the plan on what you pick and skip the rest. You can always add more later.",
  },
  scopeFresh: {
    title: "What do you want to set up?",
    why: "Pick the products to configure first. Glide will queue each change for you to review and Apply.",
  },
  domain: {
    title: "What's your domain?",
    why: "Used to find or onboard your zone and to target rules. When you add a site, Cloudflare scans your existing DNS records so you can review them before cutover.",
  },
  config: {
    title: "Share your provider config",
    why: "We parse it read-only and show exactly what will move to Cloudflare. Paste an export or link to one — JSON, XML, Terraform, and PAN-OS are supported. You can skip and do this later.",
  },
  setup: {
    title: "Choose your DNS setup",
    why: "Full setup makes Cloudflare your authoritative DNS (recommended, required on Free/Pro). Partial (CNAME) keeps your current DNS and proxies select subdomains (Business/Enterprise).",
  },
  token: {
    title: "Connect a Cloudflare API token",
    why: "Needed to read your account and to Apply queued changes. It's stored AES-256-GCM encrypted at rest and never shown again. You can skip for now and add it later.",
  },
  review: {
    title: "You're all set",
    why: "Here's what we captured. Finishing hands off to Glide in chat, which will continue with this context — proposing changes you approve before anything goes live.",
  },
};

function ChoiceCard({
  selected,
  title,
  desc,
  onClick,
}: {
  selected: boolean;
  title: string;
  desc?: string;
  onClick: () => void;
}) {
  return (
    <button style={{ ...S.choiceCard, ...(selected ? S.choiceCardOn : null) }} onClick={onClick} className="glide-lift">
      <span style={S.choiceTitle}>{title}</span>
      {desc && <span style={S.choiceDesc}>{desc}</span>}
    </button>
  );
}

function Chip({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button style={{ ...S.chip, ...(on ? S.chipOn : null) }} onClick={onClick}>
      {on ? "✓ " : ""}
      {label}
    </button>
  );
}

function OnboardingWizard({
  onboarding,
  tokenConfigured,
  migrationToolConfigured,
  migrationPlan,
  onPatch,
  onPreview,
  onSaveToken,
  onFinish,
  onDismiss,
}: WizardProps) {
  const [path, setPath] = useState<OnboardingPath | undefined>(onboarding?.path);
  const [providerKey, setProviderKey] = useState(onboarding?.migratingFrom ?? "");
  const [goals, setGoals] = useState<string[]>(onboarding?.goals ?? []);
  const [domain, setDomain] = useState(onboarding?.domain ?? "");
  const [setupType, setSetupType] = useState<SetupType | undefined>(onboarding?.setupType);
  const [configText, setConfigText] = useState("");
  const [configUrl, setConfigUrl] = useState("");
  const [configFiles, setConfigFiles] = useState<Array<{ filename: string; content: string }>>([]);
  const [fileLabel, setFileLabel] = useState<string>();
  const [configFormat, setConfigFormat] = useState<string>("auto");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [step, setStep] = useState(onboarding?.path ? 1 : 0);
  const [busy, setBusy] = useState(false);
  const [previewMsg, setPreviewMsg] = useState<string>();
  const [tokenMsg, setTokenMsg] = useState<string>();

  const stepKeys = useMemo(() => {
    if (!path) return ["branch"];
    if (path === "migrate") {
      const keys = ["branch", "provider", "scope", "domain", "config"];
      if (!tokenConfigured) keys.push("token");
      keys.push("review");
      return keys;
    }
    const keys = ["branch", "scope", "domain", "setup"];
    if (!tokenConfigured) keys.push("token");
    keys.push("review");
    return keys;
  }, [path, tokenConfigured]);

  const idx = Math.min(step, stepKeys.length - 1);
  const key = stepKeys[idx];
  const pct = Math.round((100 * idx) / Math.max(1, stepKeys.length - 1));
  const copy = key === "scope" && path === "fresh" ? WIZARD_COPY.scopeFresh : WIZARD_COPY[key];
  const goalSet = path === "migrate" ? MIGRATE_GOALS : FRESH_GOALS;

  const valid = (): boolean => {
    switch (key) {
      case "branch":
        return !!path;
      case "provider":
        return !!providerKey;
      case "scope":
        return goals.length > 0;
      case "domain":
        return domain.trim().length > 0;
      case "setup":
        return !!setupType;
      default:
        return true;
    }
  };

  const choosePath = (p: OnboardingPath) => {
    setPath(p);
    void onPatch({ path: p });
    setStep(1);
  };

  const toggleGoal = (id: string) =>
    setGoals((g) => (g.includes(id) ? g.filter((x) => x !== id) : [...g, id]));

  const clearFiles = () => {
    setConfigFiles([]);
    setConfigText("");
    setFileLabel(undefined);
    setConfigFormat("auto");
    setPreviewMsg(undefined);
  };

  const handleFiles = async (list: FileList | null) => {
    if (!list || !list.length) return;
    const read = await Promise.all(
      Array.from(list).map(async (f) => ({ filename: f.name, content: await f.text() })),
    );
    const allTf = read.every((r) => /\.(tf|tfvars|hcl)$/i.test(r.filename));
    if (read.length > 1 && allTf) {
      // A whole Terraform directory — the tool merges them.
      setConfigFiles(read);
      setConfigText("");
      setConfigUrl("");
      setConfigFormat("terraform");
      setFileLabel(`${read.length} Terraform files`);
    } else {
      const f = read[0];
      setConfigFiles([]);
      setConfigText(f.content);
      setConfigUrl("");
      setConfigFormat(formatFromName(f.filename));
      setFileLabel(
        read.length > 1
          ? `${f.filename} (+${read.length - 1} ignored — only multiple .tf files are merged)`
          : f.filename,
      );
    }
    setPreviewMsg(undefined);
  };

  const advance = () => setStep((s) => Math.min(s + 1, stepKeys.length - 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  const commitAndNext = async () => {
    if (busy) return;
    if (key === "provider") await onPatch({ migratingFrom: providerKey });
    else if (key === "scope") await onPatch({ goals });
    else if (key === "domain") await onPatch({ domain: domain.trim() });
    else if (key === "setup") await onPatch({ setupType });
    else if (key === "config") {
      const hasConfig = !!(configText.trim() || configUrl.trim() || configFiles.length);
      if (hasConfig && providerKey) {
        if (!migrationToolConfigured) {
          setPreviewMsg("Migration tool isn't connected here — you can skip and do this in chat later.");
        } else {
          setBusy(true);
          setPreviewMsg("Parsing your config (read-only)…");
          const res = await onPreview({
            provider: providerKey,
            config: configText.trim() || undefined,
            configUrl: configUrl.trim() || undefined,
            configFiles: configFiles.length ? configFiles : undefined,
            format: configFormat,
          });
          setBusy(false);
          if (res?.ok) {
            setPreviewMsg(`Parsed ${res.totalRules ?? 0} item(s). ${res.message}`);
          } else {
            setPreviewMsg(res?.message ?? "Preview failed — fix the config or skip for now.");
            return; // stay so the user can correct it
          }
        }
      }
    }
    advance();
  };

  const saveTokenInline = async () => {
    if (!tokenInput.trim() || busy) return;
    setBusy(true);
    const res = await onSaveToken(tokenInput.trim());
    setBusy(false);
    setTokenInput("");
    setTokenMsg(res?.message);
  };

  const finish = () => {
    let kickoff: string;
    const goalsTxt = goals.map(goalLabel).join(", ");
    if (path === "migrate") {
      const prov = PROVIDER_OPTIONS.find((p) => p.key === providerKey)?.label ?? "my current provider";
      const previewed = onboarding?.configProvided || configText || configUrl;
      kickoff =
        `I'm migrating from ${prov} to Cloudflare for ${domain || "my domain"}. ` +
        `I want to migrate: ${goalsTxt || "my configuration"}. DNS setup: ${setupLabel(setupType)}. ` +
        (previewed
          ? "I've previewed my config — please summarize the plan, then queue the supported rules (ask me for the zone id if you need it) and offer a Terraform export."
          : "Help me export my provider config and build the migration plan.");
    } else {
      kickoff =
        `I'm setting up ${domain || "my domain"} fresh on Cloudflare with a ${setupLabel(setupType)} DNS setup. ` +
        `I want to set up: ${goalsTxt || "the basics"}. Walk me through it step by step and queue changes for me to Apply.`;
    }
    onFinish(kickoff);
  };

  const summaryChips: Array<{ k: string; v: string }> = [];
  if (path) summaryChips.push({ k: "path", v: path === "migrate" ? "Migrate" : "Start fresh" });
  if (providerKey) summaryChips.push({ k: "from", v: PROVIDER_OPTIONS.find((p) => p.key === providerKey)?.label ?? providerKey });
  if (goals.length) summaryChips.push({ k: "scope", v: `${goals.length} selected` });
  if (domain.trim()) summaryChips.push({ k: "domain", v: domain.trim() });
  if (setupType) summaryChips.push({ k: "DNS", v: setupLabel(setupType) });
  if (tokenConfigured) summaryChips.push({ k: "token", v: "connected ✓" });

  return (
    <div style={S.wizWrap}>
      <div style={S.wizCard}>
        <div style={S.wizHead}>
          <div>
            <div style={S.wizBrand}>Guided setup</div>
            <div style={S.wizStepMeta}>
              Step {idx + 1} of {stepKeys.length}
            </div>
          </div>
          <button style={S.wizSkip} onClick={onDismiss}>
            Hide setup ↓
          </button>
        </div>
        <div style={S.wizProgress}>
          <div style={{ ...S.wizProgressBar, width: `${pct}%` }} />
        </div>

        <h2 style={S.wizTitle}>{copy?.title}</h2>
        <div style={S.wizWhy}>
          <span style={S.wizWhyIcon}>ℹ</span>
          <span>{copy?.why}</span>
        </div>

        <div style={S.wizBody}>
          {key === "branch" && (
            <div style={S.choiceGrid}>
              <ChoiceCard
                selected={path === "migrate"}
                title="Migrate from another provider"
                desc="Akamai, Fastly, Imperva, Zscaler, Prisma Access, and more → Cloudflare."
                onClick={() => choosePath("migrate")}
              />
              <ChoiceCard
                selected={path === "fresh"}
                title="Start fresh on Cloudflare"
                desc="Set up DNS, security, and performance from scratch."
                onClick={() => choosePath("fresh")}
              />
            </div>
          )}

          {key === "provider" && (
            <div style={S.chipWrap}>
              {PROVIDER_OPTIONS.map((p) => (
                <Chip key={p.key} on={providerKey === p.key} label={p.label} onClick={() => setProviderKey(p.key)} />
              ))}
              <Chip on={providerKey === "other"} label="Other / not sure" onClick={() => setProviderKey("other")} />
            </div>
          )}

          {key === "scope" && (
            <div style={S.chipWrap}>
              {goalSet.map((g) => (
                <Chip key={g.id} on={goals.includes(g.id)} label={g.label} onClick={() => toggleGoal(g.id)} />
              ))}
            </div>
          )}

          {key === "domain" && (
            <input
              autoFocus
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid()) void commitAndNext();
              }}
              placeholder="example.com"
              style={S.wizInput}
            />
          )}

          {key === "config" && (
            <div>
              {migrationToolConfigured === false && (
                <div style={S.wizNote}>
                  The migration tool isn't connected in this environment — you can skip this and do it from chat
                  later.
                </div>
              )}

              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".json,.xml,.tf,.tfvars,.hcl,.conf,.set,.cfg,application/json,text/xml,text/plain"
                style={{ display: "none" }}
                onChange={(e) => {
                  void handleFiles(e.target.files);
                  e.currentTarget.value = "";
                }}
              />
              <div style={S.uploadRow}>
                <button style={S.uploadBtn} onClick={() => fileInputRef.current?.click()}>
                  ⬆ Upload config file(s)
                </button>
                {fileLabel && (
                  <span style={S.fileLabel}>
                    📄 {fileLabel}
                    <button style={S.clearFile} onClick={clearFiles}>
                      clear
                    </button>
                  </span>
                )}
              </div>
              <div style={S.formatHint}>
                Supported: <b>JSON</b> · <b>XML</b> · <b>Terraform</b> (.tf — select multiple to merge a whole
                directory) · <b>PAN-OS</b>. Format is auto-detected from the file.
              </div>

              {configFiles.length === 0 && (
                <>
                  <div style={{ ...S.wizMutedRow, margin: "12px 0 8px" }}>— or paste it —</div>
                  <textarea
                    value={configText}
                    onChange={(e) => {
                      setConfigText(e.target.value);
                      setFileLabel(undefined);
                      setConfigFormat("auto");
                    }}
                    placeholder={`Paste your ${
                      PROVIDER_OPTIONS.find((p) => p.key === providerKey)?.label ?? "provider"
                    } export here (JSON / XML / Terraform / PAN-OS)…`}
                    rows={6}
                    style={{ ...S.wizInput, resize: "vertical", fontFamily: "ui-monospace, monospace", fontSize: 12 }}
                  />
                  <div style={{ ...S.wizMutedRow, margin: "8px 0" }}>— or link to it —</div>
                  <input
                    value={configUrl}
                    onChange={(e) => setConfigUrl(e.target.value)}
                    placeholder="https://link-to-your-export.json"
                    style={S.wizInput}
                  />
                </>
              )}

              {previewMsg && <div style={S.wizPreviewMsg}>{previewMsg}</div>}
              {migrationPlan && (
                <div style={{ marginTop: 10 }}>
                  <MigrationPlanPanel plan={migrationPlan} />
                </div>
              )}
              <div style={S.wizHintRow}>Optional — leave blank to skip and preview later in chat.</div>
            </div>
          )}

          {key === "setup" && (
            <div style={S.choiceGrid}>
              {SETUP_OPTIONS.map((o) => (
                <ChoiceCard
                  key={o.id}
                  selected={setupType === o.id}
                  title={o.label}
                  desc={o.desc}
                  onClick={() => setSetupType(o.id)}
                />
              ))}
            </div>
          )}

          {key === "token" && (
            <div>
              {tokenConfigured ? (
                <div style={S.wizNote}>A token is already connected ✓ — you can continue.</div>
              ) : (
                <>
                  <input
                    type="password"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveTokenInline();
                    }}
                    placeholder="Cloudflare API token"
                    autoComplete="off"
                    spellCheck={false}
                    style={S.wizInput}
                  />
                  <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
                    <button style={S.wizPrimarySm} disabled={!tokenInput.trim() || busy} onClick={() => void saveTokenInline()}>
                      Save securely
                    </button>
                    <span style={S.wizHintRow}>Create one at dash.cloudflare.com/profile/api-tokens</span>
                  </div>
                  {tokenMsg && <div style={S.wizPreviewMsg}>{tokenMsg}</div>}
                </>
              )}
            </div>
          )}

          {key === "review" && (
            <div>
              <div style={S.reviewList}>
                <KV k="Path" v={path === "migrate" ? "Migrate from a provider" : "Start fresh"} />
                {providerKey && (
                  <KV k="Provider" v={PROVIDER_OPTIONS.find((p) => p.key === providerKey)?.label ?? providerKey} />
                )}
                {goals.length > 0 && <KV k="Scope" v={goals.map(goalLabel).join(", ")} />}
                {domain.trim() && <KV k="Domain" v={domain.trim()} />}
                {setupType && <KV k="DNS setup" v={setupLabel(setupType)} />}
                <KV k="Token" v={tokenConfigured ? "connected ✓" : "not set (add later to Apply)"} />
                {migrationPlan && <KV k="Migration plan" v={`${migrationPlan.totalRules} item(s) parsed`} />}
              </div>
              <div style={S.wizNote}>
                Glide never changes anything on its own — it queues each change for a human to <b>Apply</b>.
              </div>
            </div>
          )}
        </div>

        {summaryChips.length > 0 && (
          <div style={S.wizSummary}>
            {summaryChips.map((c) => (
              <span key={c.k} style={S.wizSummaryChip}>
                <b style={{ color: "#9ca3af" }}>{c.k}:</b> {c.v}
              </span>
            ))}
          </div>
        )}

        <div style={S.wizFooter}>
          <button style={S.wizBack} disabled={idx === 0 || busy} onClick={back}>
            Back
          </button>
          <div style={{ flex: 1 }} />
          {key === "review" ? (
            <button style={S.wizPrimary} disabled={busy} onClick={finish}>
              Finish & open chat
            </button>
          ) : (
            <button style={S.wizPrimary} disabled={!valid() || busy} onClick={() => void commitAndNext()}>
              {busy ? "Working…" : "Continue"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin view (/admin) — a read-only operations dashboard for one room.
// ---------------------------------------------------------------------------

/** True when the current path is the admin route (`/admin`). */
function isAdminPath(): boolean {
  return /^\/admin\/?$/i.test(location.pathname);
}

// --- Minimal, dependency-free Markdown renderer (dev-docs viewer) -----------

/** Render inline markdown (code, links, bold, italic) to React nodes. */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|\*[^*]+\*|_[^_]+_)/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith("`")) {
      nodes.push(<code key={key} style={S.mdCodeInline}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**")) {
      nodes.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (link) {
        nodes.push(
          <a key={key} href={link[2]} target="_blank" rel="noreferrer noopener" style={S.mdA}>
            {link[1]}
          </a>,
        );
      } else nodes.push(tok);
    } else {
      nodes.push(<em key={key}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}
function isTableSeparator(line: string): boolean {
  return line.includes("-") && /^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/.test(line);
}

/** Render a Markdown string into styled React nodes (headings, lists, code, tables). */
function DocMarkdown({ src }: { src: string }) {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let k = 0;

  const flushPara = () => {
    if (!para.length) return;
    blocks.push(
      <p key={`p-${k++}`} style={S.mdP}>
        {renderInline(para.join(" "), `p${k}`)}
      </p>,
    );
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Fenced code block
    if (/^```/.test(trimmed)) {
      flushPara();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) buf.push(lines[i++]);
      blocks.push(
        <pre key={`code-${k++}`} style={S.mdPre}>
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (!trimmed) {
      flushPara();
      continue;
    }

    // Headings
    const h = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (h) {
      flushPara();
      const level = h[1].length;
      const style = level <= 1 ? S.mdH1 : level === 2 ? S.mdH2 : S.mdH3;
      blocks.push(
        <div key={`h-${k++}`} style={style}>
          {renderInline(h[2], `h${k}`)}
        </div>,
      );
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara();
      blocks.push(<hr key={`hr-${k++}`} style={S.mdHr} />);
      continue;
    }

    // Blockquote (collapse consecutive `>` lines)
    if (/^>\s?/.test(trimmed)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        buf.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      i--;
      blocks.push(
        <blockquote key={`q-${k++}`} style={S.mdQuote}>
          {renderInline(buf.join(" "), `q${k}`)}
        </blockquote>,
      );
      continue;
    }

    // Table (pipe syntax with a header separator row)
    if (trimmed.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushPara();
      const header = splitTableRow(trimmed);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(splitTableRow(lines[i].trim()));
        i++;
      }
      i--;
      blocks.push(
        <div key={`tbl-${k++}`} style={S.mdTableWrap}>
          <table style={S.mdTable}>
            <thead>
              <tr>
                {header.map((c, ci) => (
                  <th key={ci} style={S.mdTh}>{renderInline(c, `th${k}-${ci}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} style={S.mdTd}>{renderInline(c, `td${k}-${ri}-${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Lists (unordered / ordered) — group consecutive items
    if (/^([-*+]|\d+\.)\s+/.test(trimmed)) {
      flushPara();
      const ordered = /^\d+\.\s+/.test(trimmed);
      const items: string[] = [];
      while (i < lines.length && /^([-*+]|\d+\.)\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^([-*+]|\d+\.)\s+/, ""));
        i++;
      }
      i--;
      const inner = items.map((it, ii) => (
        <li key={ii} style={S.mdLi}>{renderInline(it, `li${k}-${ii}`)}</li>
      ));
      blocks.push(
        ordered ? (
          <ol key={`ol-${k++}`} style={S.mdList}>{inner}</ol>
        ) : (
          <ul key={`ul-${k++}`} style={S.mdList}>{inner}</ul>
        ),
      );
      continue;
    }

    para.push(trimmed);
  }
  flushPara();
  return <div style={S.mdRoot}>{blocks}</div>;
}

// --- Admin building blocks --------------------------------------------------

type AdminTab = "comms" | "actions" | "guidance" | "cfdocs" | "docs" | "onboarding";

function Panel({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section style={S.panel}>
      <div style={S.panelHead}>
        <h3 style={S.panelTitle}>{title}</h3>
        {meta}
      </div>
      {children}
    </section>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  const numStyle = tone ? { ...S.statNum, color: tone } : { ...S.statNum, ...brandText };
  return (
    <div style={S.statCard} className="glide-lift">
      <div style={numStyle} className={tone ? undefined : "glide-brand"}>{value}</div>
      <div style={S.statLabel}>{label}</div>
    </div>
  );
}

type GuidanceDraft = { id?: string; title: string; body: string; enabled: boolean };

/**
 * Admin "Guidance" tab: add/edit/enable/delete the room's guidance docs. Enabled
 * docs are injected into Glide's system prompt (server-side), so editing here
 * changes which onboarding questions Glide asks — live, no redeploy.
 */
function GuidanceTab({
  docs,
  onSave,
  onDelete,
  onReindex,
}: {
  docs: GuidanceDoc[];
  onSave: (doc: GuidanceDraft) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onReindex: () => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<GuidanceDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [notice, setNotice] = useState<string>();

  const reindex = async () => {
    if (reindexing) return;
    setReindexing(true);
    const res = (await onReindex()) as { ok?: boolean; message?: string } | undefined;
    setReindexing(false);
    setNotice(res?.message ?? "Reindex requested.");
  };

  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    const res = (await onSave(draft)) as { ok?: boolean; message?: string } | undefined;
    setBusy(false);
    if (res?.message) setNotice(res.message);
    if (res?.ok !== false) setDraft(null);
  };

  const toggle = (d: GuidanceDoc) =>
    void onSave({ id: d.id, title: d.title, body: d.body, enabled: !d.enabled });

  const remove = (d: GuidanceDoc) => {
    if (window.confirm(`Delete guidance "${d.title}"? This can't be undone.`)) void onDelete(d.id);
  };

  return (
    <Panel
      title={`Guidance · ${docs.length}`}
      meta={<span style={S.panelMeta}>steers Glide's questions · live</span>}
    >
      <p style={S.hint}>
        Notes you add here are injected into Glide's brain for this room, so it asks relevant,
        team-specific onboarding questions — and skips what you've already answered. Enabled docs
        take effect immediately; no rebuild or redeploy needed. With many docs, Glide semantically
        retrieves only the most relevant ones per message (RAG).
      </p>

      {docs.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "0 0 12px" }}>
          <button style={S.miniBtn} disabled={reindexing} onClick={reindex}>
            {reindexing ? "Reindexing…" : "Reindex for search"}
          </button>
          <span style={S.listMeta}>Re-embed all guidance so semantic retrieval is current.</span>
        </div>
      )}

      {notice && <div style={S.guidanceNotice}>{notice}</div>}

      {draft ? (
        <div style={S.guidanceEditor}>
          <label style={S.label}>Title</label>
          <input
            autoFocus
            style={S.input}
            value={draft.title}
            placeholder="e.g. Our stack, Compliance, Preferred DNS setup"
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
          <label style={{ ...S.label, marginTop: 12 }}>Guidance for Glide</label>
          <textarea
            style={S.guidanceTextarea}
            value={draft.body}
            placeholder={
              "What should Glide know about this team so it asks the right questions?\n\ne.g. We're migrating from Akamai; we only care about WAF + rate limiting. DNS stays at Route 53 (partial/CNAME setup), so don't ask about nameserver changes. Always ask about PCI scope."
            }
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          />
          <label style={S.guidanceCheck}>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            />
            Enabled — inject into Glide's prompt
          </label>
          <div style={S.guidanceBtnRow}>
            <button style={S.guidanceSaveBtn} disabled={busy} onClick={save}>
              {busy ? "Saving…" : draft.id ? "Save changes" : "Add guidance"}
            </button>
            <button style={{ ...S.rejectBtn, flex: "0 0 auto", padding: "10px 16px" }} disabled={busy} onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          style={S.guidanceSaveBtn}
          onClick={() => setDraft({ title: "", body: "", enabled: true })}
        >
          + Add guidance
        </button>
      )}

      <div style={{ marginTop: 16 }}>
        {docs.length === 0 && <Muted>No guidance yet. Add a note above to steer Glide's questions.</Muted>}
        {docs.map((d) => (
          <div key={d.id} style={S.docRow}>
            <div style={{ padding: "12px 16px" }}>
              <div style={S.guidanceRowTop}>
                <span style={S.docTitle}>{d.title}</span>
                <span
                  style={{
                    ...S.badge,
                    background: d.enabled ? "#064e3b" : "#374151",
                    color: d.enabled ? "#6ee7b7" : "#cbd5e1",
                  }}
                >
                  {d.enabled ? "active" : "off"}
                </span>
              </div>
              {d.body && <div style={S.guidanceBody}>{d.body}</div>}
              <div style={S.guidanceActions}>
                <button style={S.miniBtn} onClick={() => setDraft({ id: d.id, title: d.title, body: d.body, enabled: d.enabled })}>
                  Edit
                </button>
                <button style={S.miniBtn} onClick={() => toggle(d)}>
                  {d.enabled ? "Disable" : "Enable"}
                </button>
                <button style={S.rejectBtnSm} onClick={() => remove(d)}>
                  Delete
                </button>
                {d.updatedBy && (
                  <span style={{ ...S.listMeta, marginLeft: "auto" }}>
                    by {d.updatedBy} · {relTime(d.ts)}
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** Prompt for a room id when `/admin` is opened without one in the hash. */
function AdminPickRoom({ onPick }: { onPick: (room: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div style={S.joinWrap}>
      <div style={{ ...S.joinCard, width: 460 }}>
        <h1 style={{ ...S.brand, fontSize: 30 }} className="glide-brand">Glide · Admin</h1>
        <p style={S.tagline}>
          Enter a room id to inspect its comms, actions, docs, and status. The room id is the value
          after <code>#</code> in a room link.
        </p>
        <label style={S.label}>Room id</label>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value.trim())}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) onPick(value.trim());
          }}
          placeholder="e.g. 6f3a9c…"
          style={S.input}
        />
        <button style={S.primaryBtn} disabled={!value.trim()} onClick={() => value.trim() && onPick(value.trim())}>
          Open admin
        </button>
      </div>
    </div>
  );
}

/** Admin entry: resolve the room (from the hash) and mount the dashboard. */
function AdminGate() {
  const name = useMemo(() => localStorage.getItem(NAME_KEY) || "admin", []);
  const [room, setRoom] = useState(() => readRoomFromHash());
  useEffect(() => {
    const onHash = () => setRoom(readRoomFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (!room) {
    return (
      <AdminPickRoom
        onPick={(r) => {
          location.hash = r;
          setRoom(r);
        }}
      />
    );
  }
  return (
    <Suspense
      fallback={
        <div style={{ ...S.shell, alignItems: "center", justifyContent: "center" }}>
          <span style={{ color: "#9ca3af", fontSize: 15 }}>Loading admin…</span>
        </div>
      }
    >
      <AdminRoom key={room} room={room} name={name} />
    </Suspense>
  );
}

/** The room-scoped admin dashboard: comms, actions, dev docs, onboarding & migration. */
const DOCS_STATUS_LABEL: Record<DocsIndexState["status"], string> = {
  idle: "Not indexed yet",
  enumerating: "Discovering pages…",
  indexing: "Indexing pages…",
  done: "Up to date",
  error: "Error",
  cancelled: "Cancelled",
};

const DOCS_STATUS_TONE: Record<DocsIndexState["status"], { background: string; color: string }> = {
  idle: { background: "#374151", color: "#d1d5db" },
  enumerating: { background: "#0c4a6e", color: "#7dd3fc" },
  indexing: { background: "#0c4a6e", color: "#7dd3fc" },
  done: { background: "#064e3b", color: "#6ee7b7" },
  error: { background: "#7f1d1d", color: "#fecaca" },
  cancelled: { background: "#374151", color: "#d1d5db" },
};

/**
 * Admin "Cloudflare docs" tab: trigger and monitor the background job that
 * scrapes the full Cloudflare developer docs into the SHARED semantic index used
 * by every room's chat. Progress lives in synced state, so this reflects the job
 * live and keeps updating even if you navigate away and come back.
 */
function CfDocsTab({
  docsIndex,
  onStart,
  onCancel,
  onClear,
}: {
  docsIndex?: DocsIndexState;
  onStart: () => Promise<unknown>;
  onCancel: () => Promise<unknown>;
  onClear: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();

  const st = docsIndex;
  const status = st?.status ?? "idle";
  const running = status === "enumerating" || status === "indexing";
  const processed = st ? st.pagesIndexed + st.pagesFailed : 0;
  const pct =
    st && st.pagesTotal > 0
      ? Math.min(100, Math.round((processed / st.pagesTotal) * 100))
      : status === "done"
        ? 100
        : 0;
  const hasProgress = !!st && (running || st.pagesTotal > 0 || status === "done");

  const act = async (fn: () => Promise<unknown>, confirmMsg?: string) => {
    if (busy) return;
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const res = (await fn()) as { message?: string } | undefined;
      if (res?.message) setNotice(res.message);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Cloudflare docs"
      meta={<span style={S.panelMeta}>shared semantic index · all rooms</span>}
    >
      <p style={S.hint}>
        Scrape the complete Cloudflare developer documentation, embed every page, and store it in the
        shared semantic index. Once indexed, Glide retrieves the most relevant excerpts for each
        message — across <strong>every</strong> room — to ground its answers. The job runs in the
        background and survives you closing this tab.
      </p>

      {notice && <div style={S.guidanceNotice}>{notice}</div>}

      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "12px 0" }}>
        <span style={{ ...S.badge, ...DOCS_STATUS_TONE[status] }}>{DOCS_STATUS_LABEL[status]}</span>
        {running && st?.currentProduct && <span style={S.listMeta}>{st.currentProduct}</span>}
        {st?.updatedAt && <span style={S.listMeta}>· updated {relTime(st.updatedAt)}</span>}
      </div>

      {hasProgress && (
        <>
          <div style={S.progressWrap}>
            <div style={{ ...S.progressBar, width: `${pct}%` }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px", margin: "4px 0 12px" }}>
            <div style={S.kv}>
              <span style={S.kvKey}>Products</span>
              <span style={S.kvVal}>{st?.productsEnumerated ?? 0}/{st?.productsTotal ?? 0}</span>
            </div>
            <div style={S.kv}>
              <span style={S.kvKey}>Pages indexed</span>
              <span style={S.kvVal}>{st?.pagesIndexed ?? 0}/{st?.pagesTotal ?? 0}</span>
            </div>
            <div style={S.kv}>
              <span style={S.kvKey}>Chunks</span>
              <span style={S.kvVal}>{st?.chunksUpserted ?? 0}</span>
            </div>
            <div style={S.kv}>
              <span style={S.kvKey}>Failed</span>
              <span style={S.kvVal}>{st?.pagesFailed ?? 0}</span>
            </div>
          </div>
        </>
      )}

      {status === "error" && st?.error && <div style={S.errorBox}>{st.error}</div>}

      <div style={S.guidanceBtnRow}>
        {!running && (
          <button style={S.guidanceSaveBtn} disabled={busy} onClick={() => void act(onStart)}>
            {busy ? "Working…" : status === "idle" ? "Start indexing" : "Reindex"}
          </button>
        )}
        {running && (
          <button style={S.rejectBtnSm} disabled={busy} onClick={() => void act(onCancel)}>
            {busy ? "Cancelling…" : "Cancel"}
          </button>
        )}
        {!running && !!st && (st.pagesIndexed > 0 || st.pagesTotal > 0) && (
          <button
            style={S.miniBtn}
            disabled={busy}
            onClick={() =>
              void act(onClear, "Remove all indexed Cloudflare docs from the shared store?")
            }
          >
            Clear index
          </button>
        )}
      </div>

      <p style={S.hint}>
        The full docs are ~100 products and thousands of pages, so a first run takes a while and uses
        Workers AI embeddings. The store is shared by all rooms — index once, then re-run occasionally
        to refresh. Requires a Vectorize index (semantic search) to be configured.
      </p>
    </Panel>
  );
}

function AdminRoom({ room, name }: { room: string; name: string }) {
  const [state, setState] = useState<GlideState>();
  const [tab, setTab] = useState<AdminTab>("comms");
  const [openDoc, setOpenDoc] = useState<string | null>(null);

  const agent = useAgent<GlideState>({
    agent: "GlideAgent",
    name: room,
    onStateUpdate: (s) => setState(s),
  });
  const chat = useAgentChat({ agent, getInitialMessages: null, body: () => ({ name }) });
  const messages = chat.messages.filter((message) => !isSystemEvent(message));

  const chatLink = `/#${encodeURIComponent(room)}`;
  const pending = state?.pendingActions ?? [];
  const results = state?.recentResults ?? [];
  const invites = state?.invites ?? [];
  const applied = results.filter((r) => r.status === "applied").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const rejected = results.filter((r) => r.status === "rejected").length;
  const onboarding = state?.onboarding;
  const plan = state?.migrationPlan;
  const guidance = state?.guidance ?? [];
  const guidanceActive = guidance.filter((d) => d.enabled).length;

  const tabs: Array<{ id: AdminTab; label: string; count?: number }> = [
    { id: "comms", label: "Comms", count: messages.length },
    { id: "actions", label: "Actions", count: pending.length },
    { id: "guidance", label: "Guidance", count: guidance.length },
    { id: "cfdocs", label: "Cloudflare docs", count: state?.docsIndex?.chunksUpserted },
    { id: "docs", label: "Dev docs", count: docsManifest.docs.length },
    { id: "onboarding", label: "Onboarding & migration" },
  ];

  return (
    <div style={S.shell}>
      <header style={S.header}>
        <div style={S.headerLeft}>
          <span style={S.brandSm} className="glide-brand">Glide</span>
          <span style={S.adminTag}>Admin</span>
          <span style={S.roomPill}>#{room}</span>
        </div>
        <div style={S.headerRight}>
          {state ? (
            state.tokenConfigured ? (
              <span style={{ ...S.badge, background: "#064e3b", color: "#6ee7b7" }}>token ✓</span>
            ) : (
              <span style={{ ...S.badge, background: "#7f1d1d", color: "#fecaca" }}>no token</span>
            )
          ) : (
            <span style={{ ...S.badge, background: "#374151", color: "#d1d5db" }}>connecting…</span>
          )}
          <a href={chatLink} style={S.headerLink}>← Chat</a>
        </div>
      </header>

      <div style={S.adminStats}>
        <StatCard label="Messages" value={messages.length} />
        <StatCard label="Pending" value={pending.length} tone={pending.length ? "#fbbf24" : undefined} />
        <StatCard label="Applied" value={applied} tone={applied ? "#4ade80" : undefined} />
        <StatCard label="Failed" value={failed} tone={failed ? "#fb7185" : undefined} />
        <StatCard label="Rejected" value={rejected} />
        <StatCard label="Invites" value={invites.length} />
        <StatCard label="Guidance" value={guidanceActive} tone={guidanceActive ? "#38bdf8" : undefined} />
        <StatCard label="Docs" value={docsManifest.docs.length} />
      </div>

      <div style={S.tabBar}>
        {tabs.map((t) => (
          <button
            key={t.id}
            style={{ ...S.tab, ...(tab === t.id ? S.tabOn : null) }}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {typeof t.count === "number" ? ` · ${t.count}` : ""}
          </button>
        ))}
      </div>

      <div style={S.adminContent}>
        {!state && <div style={S.adminLoading}>Connecting to room #{room}…</div>}

        {tab === "comms" && (
          <>
            <Panel title={`Transcript · ${messages.length}`} meta={<span style={S.panelMeta}>read-only</span>}>
              {messages.length === 0 && <Muted>No messages in this room yet.</Muted>}
              <div style={S.transcript}>
                {messages.map((m) => {
                  const { text, tools } = messageText(m);
                  const who =
                    m.role === "user"
                      ? (m.metadata as GlideMessageMetadata | undefined)?.name ?? "teammate"
                      : "Glide";
                  return (
                    <div key={m.id} style={S.commRow}>
                      <div style={{ ...S.avatar, ...(m.role === "user" ? S.avatarUser : S.avatarAi) }}>
                        {m.role === "user" ? who.charAt(0).toUpperCase() : "G"}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={S.commWho}>
                          {who} <span style={S.commRole}>{m.role}</span>
                        </div>
                        {text && <div style={S.commText}>{text}</div>}
                        {tools.length > 0 && (
                          <div>
                            {tools.map((tool) => (
                              <ToolChip key={tool.id} tool={tool} />
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Panel>

            <Panel title={`Invites · ${invites.length}`}>
              {invites.length === 0 && <Muted>No invites recorded.</Muted>}
              {invites.map((inv) => (
                <div key={`${inv.email}-${inv.ts}`} style={S.listRow}>
                  <span style={{ fontSize: 13, wordBreak: "break-all" }}>{inv.email}</span>
                  <span style={S.listMeta}>
                    by {inv.invitedBy} · {relTime(inv.ts)}
                  </span>
                </div>
              ))}
            </Panel>
          </>
        )}

        {tab === "actions" && (
          <>
            <Panel
              title={`Pending approvals · ${pending.length}`}
              meta={<span style={S.panelMeta}>view-only — Apply from the chat room</span>}
            >
              {pending.length === 0 && <Muted>Nothing queued.</Muted>}
              {pending.map((a) => (
                <div key={a.id} style={S.actionCard}>
                  <div style={S.actionTop}>
                    <span style={{ ...S.method, background: METHOD_COLORS[a.method] ?? "#6b7280" }}>{a.method}</span>
                    <span style={S.product}>{a.product}</span>
                    <span style={{ ...S.listMeta, marginLeft: "auto" }}>
                      {isActionApplying(a) ? "applying" : pendingActionStatus(a)} · {relTime(a.ts)}
                    </span>
                  </div>
                  <div style={S.actionSummary}>{a.summary}</div>
                  <code style={S.path}>{a.path}</code>
                  {a.body !== undefined && (
                    <details style={S.bodyDetails}>
                      <summary style={S.bodySummary}>Request body</summary>
                      <pre style={S.bodyPre}>{JSON.stringify(a.body, null, 2)}</pre>
                    </details>
                  )}
                  {a.error && <div style={{ ...S.resultDetail, color: "#fda4af" }}>{a.error}</div>}
                  <div style={S.actionMeta}>by {a.createdBy}</div>
                </div>
              ))}
            </Panel>

            <Panel title={`Recent results · ${results.length}`}>
              {results.length === 0 && <Muted>No results yet.</Muted>}
              {results.map((r) => (
                <div key={`${r.id}-${r.ts}`} style={S.resultRow}>
                  <span style={{ ...S.dot, background: STATUS_COLORS[r.status] }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={S.resultSummary}>{r.summary}</div>
                    <div style={S.resultDetail}>{r.detail}</div>
                    <div style={S.listMeta}>
                      {r.status} · by {r.by} · {relTime(r.ts)}
                    </div>
                  </div>
                </div>
              ))}
            </Panel>
          </>
        )}

        {tab === "guidance" && (
          <GuidanceTab
            docs={guidance}
            onSave={(doc) => agent.call("upsertGuidanceDoc", [doc, name])}
            onDelete={(id) => agent.call("deleteGuidanceDoc", [id])}
            onReindex={() => agent.call("reindexGuidance")}
          />
        )}

        {tab === "cfdocs" && (
          <CfDocsTab
            docsIndex={state?.docsIndex}
            onStart={() => agent.call("startDocsReindex", [name])}
            onCancel={() => agent.call("cancelDocsReindex")}
            onClear={() => agent.call("clearDocsIndex")}
          />
        )}

        {tab === "docs" && (
          <Panel
            title={`Dev docs · ${docsManifest.docs.length}`}
            meta={<span style={S.panelMeta}>snapshot built {relTime(Date.parse(docsManifest.generatedAt))}</span>}
          >
            <p style={S.hint}>
              Documentation captured at build time. “Modified” is each file's last change on disk when Glide
              was last built — rebuild &amp; redeploy to refresh this tracker.
            </p>
            {docsManifest.docs.map((d) => {
              const open = openDoc === d.id;
              return (
                <div key={d.id} style={S.docRow}>
                  <div style={S.docHeadRow} onClick={() => setOpenDoc(open ? null : d.id)}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={S.docTitle}>{d.title}</div>
                      <code style={S.docPath}>{d.path}</code>
                      {d.summary && <div style={S.docSummary}>{d.summary}</div>}
                    </div>
                    <div style={S.docMetaCol}>
                      <span style={S.docWhen} title={fmtWhen(d.mtimeMs)}>{relTime(d.mtimeMs)}</span>
                      <span style={S.docSize}>
                        {fmtBytes(d.bytes)} · {d.lines} lines
                      </span>
                      <span style={S.docToggle}>{open ? "Hide ▲" : "View ▼"}</span>
                    </div>
                  </div>
                  {open && (
                    <div style={S.docBody}>
                      <DocMarkdown src={d.content} />
                    </div>
                  )}
                </div>
              );
            })}
          </Panel>
        )}

        {tab === "onboarding" && (
          <>
            <Panel title="Onboarding">
              {!onboarding?.active && !onboarding?.completed ? (
                <Muted>Onboarding hasn't been started in this room.</Muted>
              ) : (
                <>
                  <KV
                    k="status"
                    v={onboarding?.completed ? "completed ✓" : onboarding?.active ? "in progress" : "—"}
                  />
                  {onboarding?.path && (
                    <KV k="path" v={onboarding.path === "migrate" ? "Migrate from a provider" : "Start fresh"} />
                  )}
                  {onboarding?.domain && <KV k="domain" v={onboarding.domain} />}
                  {onboarding?.setupType && <KV k="DNS setup" v={setupLabel(onboarding.setupType)} />}
                  {(onboarding?.migratingFromLabel || onboarding?.migratingFrom) && (
                    <KV k="from" v={onboarding.migratingFromLabel ?? onboarding.migratingFrom ?? ""} />
                  )}
                  {onboarding && onboarding.goals.length > 0 && (
                    <KV k="goals" v={onboarding.goals.map(goalLabel).join(", ")} />
                  )}
                  {onboarding && onboarding.checklist.length > 0 && (
                    <>
                      <div style={{ ...S.progressWrap, marginTop: 12 }}>
                        <div
                          style={{
                            ...S.progressBar,
                            width: `${Math.round(
                              (100 * onboarding.checklist.filter((s) => s.done).length) /
                                onboarding.checklist.length,
                            )}%`,
                          }}
                        />
                      </div>
                      <div style={S.checklist}>
                        {onboarding.checklist.map((s) => (
                          <div key={s.id} style={S.checkItem}>
                            <span style={{ color: s.done ? "#6ee7b7" : "#64748b" }}>{s.done ? "✓" : "○"}</span>
                            <span
                              style={{
                                textDecoration: s.done ? "line-through" : "none",
                                color: s.done ? "#6b7280" : "#e5e7eb",
                              }}
                            >
                              {s.label}
                            </span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </Panel>

            <Panel title="Migration">
              {!plan ? (
                <Muted>
                  No migration plan in this room
                  {state?.migrationToolConfigured === false ? " (migration tool not connected)." : "."}
                </Muted>
              ) : (
                <>
                  <MigrationPlanPanel plan={plan} />
                  {state?.migrationCheck && (
                    <div
                      style={{
                        ...S.checkBox,
                        borderColor: state.migrationCheck.ok ? "#14532d" : "#7c2d12",
                        background: state.migrationCheck.ok ? "#052e16" : "#422006",
                        color: state.migrationCheck.ok ? "#86efac" : "#fed7aa",
                      }}
                    >
                      <b>{state.migrationCheck.kind}:</b> {state.migrationCheck.summary}
                    </div>
                  )}
                </>
              )}
            </Panel>

            {(state?.snapshots?.length ?? 0) > 0 && (
              <Panel title={`Zone snapshots · ${state!.snapshots!.length}`}>
                {state!.snapshots!.map((s) => (
                  <div key={s.id} style={S.listRow}>
                    <span style={{ fontSize: 13, wordBreak: "break-all" }}>{s.zoneName || s.zoneId}</span>
                    <span style={S.listMeta}>{new Date(s.created).toLocaleString()}</span>
                  </div>
                ))}
              </Panel>
            )}

            {(state?.terraform || state?.csv) && (
              <Panel title="Exports">
                {state?.terraform?.files.map((f) => (
                  <div key={`tf-${f.filename}`} style={S.tfRow}>
                    <code style={S.tfName}>{f.filename}</code>
                    <button style={S.miniBtn} onClick={() => downloadText(f.filename, f.content)}>
                      Download
                    </button>
                  </div>
                ))}
                {state?.csv?.files.map((f) => (
                  <div key={`csv-${f.filename}`} style={S.tfRow}>
                    <code style={S.tfName}>{f.filename}</code>
                    <button style={S.miniBtn} onClick={() => downloadText(f.filename, f.content)}>
                      Download
                    </button>
                  </div>
                ))}
              </Panel>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App root
// ---------------------------------------------------------------------------

/**
 * Catches render-phase errors (e.g. inside {@link Room}'s Agents SDK hooks) so
 * a single throw surfaces a readable message instead of a silent blank page.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Glide render error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={S.joinWrap}>
        <div style={{ ...S.joinCard, width: 520 }}>
          <h1 style={{ ...S.brand, fontSize: 28 }}>Glide hit an error</h1>
          <p style={S.tagline}>The chat client failed to render. Details below.</p>
          <pre style={S.bodyPre}>{error.message}</pre>
          {error.stack ? (
            <details style={S.bodyDetails}>
              <summary style={S.bodySummary}>Stack trace</summary>
              <pre style={S.bodyPre}>{error.stack}</pre>
            </details>
          ) : null}
          <button
            style={S.primaryBtn}
            onClick={() => {
              this.setState({ error: null });
              location.reload();
            }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

function App() {
  const [name, setName] = useState<string | null>(() => localStorage.getItem(NAME_KEY));

  if (!name) {
    return (
      <Join
        onJoin={(n) => {
          localStorage.setItem(NAME_KEY, n);
          setName(n);
        }}
      />
    );
  }
  // `useAgentChat` (inside Room) calls React `use()` on a pending fetch for the
  // room's initial messages. Without a Suspense ancestor, that suspends the root
  // shell on every render (a network promise never resolves synchronously), which
  // trips React 19's shell-suspend limit and throws error #482. This boundary lets
  // React show a fallback, yield, and re-render Room once the messages resolve.
  return (
    <Suspense
      fallback={
        <div style={{ ...S.shell, alignItems: "center", justifyContent: "center" }}>
          <span style={{ color: "#9ca3af", fontSize: 15 }}>Loading room…</span>
        </div>
      }
    >
      <Room name={name} />
    </Suspense>
  );
}

/**
 * Top-level router. `/admin` renders the read-only ops dashboard; every other
 * path is the chat app. There's no history API navigation between them (each is
 * a full page load / link), but we still listen for `popstate` so back/forward
 * between the two routes re-renders the right view without a hard reload.
 */
function Root() {
  const [admin, setAdmin] = useState(() => isAdminPath());
  useEffect(() => {
    const onNav = () => setAdmin(isAdminPath());
    window.addEventListener("popstate", onNav);
    return () => window.removeEventListener("popstate", onNav);
  }, []);
  return admin ? <AdminGate /> : <App />;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

// Signature gradients — the dawn-sky wordmark sheen and the primary-action
// flare. `DISPLAY` is the characterful face reserved for wordmarks, hero
// titles, and data numerals; body/UI stays on Inter.
const GRAD_BRAND = "linear-gradient(120deg,#fb923c 0%,#f97316 20%,#ec4899 58%,#a855f7 100%)";
const GRAD_CTA = "linear-gradient(135deg,#f97316 0%,#ec4899 100%)";
const DISPLAY = '"Space Grotesk", "Inter", ui-sans-serif, system-ui, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

// Reusable "gliding gradient text" recipe for wordmarks (animated via the
// `glide-brand` class, which pans the oversized background).
const brandText: React.CSSProperties = {
  background: GRAD_BRAND,
  backgroundSize: "200% auto",
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  WebkitTextFillColor: "transparent",
  fontFamily: DISPLAY,
};

const S: Record<string, React.CSSProperties> = {
  joinWrap: { minHeight: "100vh", display: "grid", placeItems: "center", padding: 20, background: "radial-gradient(1100px 620px at 50% -8%, rgba(249,115,22,.18) 0%, transparent 55%), radial-gradient(900px 600px at 85% 110%, rgba(139,92,246,.20) 0%, transparent 55%), #070b16" },
  joinCard: { width: 400, padding: 38, borderRadius: 24, background: "rgba(15,23,42,.72)", border: "1px solid rgba(148,163,184,.16)", backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", boxShadow: "0 30px 80px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.05)" },
  brand: { ...brandText, margin: 0, fontSize: 48, fontWeight: 700, letterSpacing: -1 },
  tagline: { marginTop: 8, marginBottom: 28, color: "#93a3b8", fontSize: 14.5, lineHeight: 1.55 },
  label: { display: "block", fontSize: 12, color: "#93a3b8", marginBottom: 6, fontWeight: 600 },
  input: { width: "100%", boxSizing: "border-box", padding: "12px 14px", borderRadius: 12, border: "1px solid #24304c", background: "rgba(7,11,22,.75)", color: "#f8fafc", fontSize: 15, outline: "none" },
  primaryBtn: { marginTop: 18, width: "100%", padding: "14px", borderRadius: 12, border: 0, background: GRAD_CTA, color: "#fff", fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: DISPLAY, letterSpacing: 0.2, boxShadow: "0 12px 30px rgba(236,72,153,.32), 0 3px 10px rgba(249,115,22,.28)" },

  shell: { display: "flex", flexDirection: "column", height: "100vh", background: "transparent", color: "#e5e7eb", fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: "1px solid rgba(148,163,184,.12)", background: "rgba(9,13,24,.62)", backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)" },
  headerLeft: { display: "flex", alignItems: "center", gap: 12 },
  headerRight: { display: "flex", alignItems: "center", gap: 10 },
  brandSm: { ...brandText, fontWeight: 700, fontSize: 20, letterSpacing: -0.4 },
  safetyPill: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600, color: "#cbd5e1", background: "rgba(15,23,42,.6)", border: "1px solid rgba(148,163,184,.16)", borderRadius: 999, padding: "4px 11px", letterSpacing: 0.2, whiteSpace: "nowrap" },
  safetyDotRead: { width: 6, height: 6, borderRadius: 999, background: "#22c55e", boxShadow: "0 0 7px rgba(34,197,94,.8)" },
  safetyDotWrite: { width: 6, height: 6, borderRadius: 999, background: "#fbbf24", boxShadow: "0 0 7px rgba(251,191,36,.8)" },
  safetyDivider: { color: "#475569", margin: "0 1px" },
  roomPill: { display: "inline-flex", alignItems: "center", gap: 2, background: "rgba(7,11,22,.6)", border: "1px solid rgba(148,163,184,.16)", borderRadius: 999, padding: "5px 12px", color: "#93a3b8", fontSize: 14 },
  roomInput: { background: "transparent", border: 0, color: "#f8fafc", fontSize: 14, width: 92, outline: "none", fontWeight: 600 },
  badge: { fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 999, textTransform: "uppercase", letterSpacing: 0.5 },
  you: { fontSize: 13, color: "#cbd5e1", fontWeight: 600 },
  warnBar: { padding: "9px 18px", background: "linear-gradient(90deg, rgba(120,53,15,.85), rgba(88,28,80,.55))", color: "#fed7aa", fontSize: 13, borderBottom: "1px solid rgba(249,115,22,.3)" },

  body: { display: "flex", flex: 1, minHeight: 0 },
  chatCol: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0 },
  messages: { flex: "2 1 0", minHeight: 0, overflowY: "auto", padding: "24px 24px 8px", display: "flex", flexDirection: "column", gap: 16 },
  empty: { margin: "auto", maxWidth: 480, textAlign: "center", color: "#cbd5e1", fontSize: 14, lineHeight: 1.6 },
  msgRow: { display: "flex", alignItems: "flex-start", gap: 10 },
  avatar: { width: 32, height: 32, borderRadius: 999, display: "grid", placeItems: "center", fontSize: 12.5, fontWeight: 800, flexShrink: 0, color: "#fff", boxShadow: "0 3px 12px rgba(0,0,0,.4)", userSelect: "none", fontFamily: DISPLAY },
  avatarAi: { background: GRAD_CTA, color: "#fff", boxShadow: "0 3px 14px rgba(236,72,153,.4)" },
  avatarUser: { background: "linear-gradient(135deg,#38bdf8,#6366f1)", color: "#fff" },
  avatarMine: { background: "linear-gradient(135deg,#fb923c,#f43f5e)", color: "#fff" },
  bubble: { maxWidth: "78%", padding: "11px 15px", borderRadius: 16, fontSize: 14, lineHeight: 1.55, boxShadow: "0 4px 18px rgba(0,0,0,.32)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", animation: "glideIn .3s cubic-bezier(.22,1,.36,1)" },
  aiBubble: { background: "rgba(19,29,51,.72)", border: "1px solid rgba(148,163,184,.14)", borderTopLeftRadius: 5, borderLeft: "2px solid rgba(249,115,22,.55)" },
  userBubble: { background: "rgba(24,35,59,.72)", border: "1px solid rgba(148,163,184,.16)", borderTopRightRadius: 5 },
  mineBubble: { background: "linear-gradient(135deg, rgba(124,45,90,.5), rgba(120,53,15,.42))", border: "1px solid rgba(236,72,153,.32)" },
  msgWho: { fontSize: 11, fontWeight: 700, color: "#93a3b8", marginBottom: 4, letterSpacing: 0.3, textTransform: "uppercase" },
  msgText: { whiteSpace: "pre-wrap", wordBreak: "break-word", color: "#f1f5f9" },
  toolChip: { marginTop: 8, marginRight: 6, display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: "#f9a8d4", background: "rgba(236,72,153,.12)", border: "1px solid rgba(236,72,153,.35)", borderRadius: 999, padding: "3px 11px" },
  typing: { display: "inline-flex", alignItems: "center", height: 14 },

  // Chat-led onboarding opener (GuidedIntro)
  introWrap: { margin: "auto 0", width: "100%", maxWidth: 580, display: "flex", justifyContent: "flex-start" },
  introBubble: { width: "100%", boxSizing: "border-box", background: "rgba(19,29,51,.72)", border: "1px solid rgba(148,163,184,.14)", borderLeft: "2px solid rgba(249,115,22,.55)", borderRadius: 18, borderTopLeftRadius: 5, padding: "20px 22px", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", boxShadow: "0 8px 28px rgba(0,0,0,.35)" },
  introTitle: { fontSize: 19, fontWeight: 700, color: "#f8fafc", marginBottom: 8, fontFamily: DISPLAY, letterSpacing: -0.2 },
  introText: { fontSize: 14.5, lineHeight: 1.6, color: "#cbd5e1", marginBottom: 16 },
  introChoices: { display: "flex", gap: 10, flexWrap: "wrap" },
  introChoice: { padding: "11px 18px", borderRadius: 11, border: "1px solid transparent", background: GRAD_CTA, color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", boxShadow: "0 8px 22px rgba(236,72,153,.28)", fontFamily: DISPLAY },
  introFoot: { marginTop: 16, fontSize: 12, color: "#64748b", lineHeight: 1.5 },
  introLink: { background: "transparent", border: 0, color: "#38bdf8", fontSize: 12, cursor: "pointer", textDecoration: "underline", padding: 0 },

  composer: { display: "flex", gap: 10, padding: 14, borderTop: "1px solid rgba(148,163,184,.12)", background: "rgba(9,13,24,.62)", backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)" },
  connectionNotice: { padding: "8px 14px", background: "rgba(245,158,11,.10)", borderTop: "1px solid rgba(245,158,11,.25)", color: "#fcd34d", fontSize: 12.5 },
  deliveryNotice: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "9px 14px", background: "rgba(244,63,94,.10)", borderTop: "1px solid rgba(244,63,94,.28)", color: "#fecdd3", fontSize: 12.5 },
  deliveryRetryBtn: { flexShrink: 0, border: "1px solid rgba(244,63,94,.45)", background: "rgba(244,63,94,.16)", color: "#fff", borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontWeight: 700 },
  textarea: { flex: 1, resize: "none", padding: "12px 15px", borderRadius: 13, border: "1px solid #24304c", background: "rgba(7,11,22,.7)", color: "#f8fafc", fontSize: 14, lineHeight: 1.5, fontFamily: "inherit", outline: "none" },
  sendBtn: { alignSelf: "stretch", padding: "0 24px", borderRadius: 13, border: 0, background: GRAD_CTA, color: "#fff", fontWeight: 800, fontSize: 14, cursor: "pointer", fontFamily: DISPLAY, letterSpacing: 0.3, boxShadow: "0 8px 22px rgba(236,72,153,.3)" },
  stopBtn: { alignSelf: "stretch", padding: "0 18px", borderRadius: 13, border: "1px solid rgba(244,63,94,.5)", background: "rgba(244,63,94,.14)", color: "#fecdd3", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: DISPLAY, letterSpacing: 0.3 },
  stallHint: { fontSize: 13, color: "#cbd5e1", lineHeight: 1.5 },

  sidebar: { width: 344, flexShrink: 0, borderLeft: "1px solid rgba(148,163,184,.1)", background: "rgba(9,13,24,.45)", backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)", overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 14 },
  errorBox: { background: "rgba(244,63,94,.14)", border: "1px solid rgba(244,63,94,.5)", color: "#fecdd3", padding: "9px 12px", borderRadius: 10, fontSize: 13 },
  section: { background: "rgba(15,23,42,.55)", border: "1px solid rgba(148,163,184,.12)", borderRadius: 14, padding: "13px 14px", boxShadow: "0 2px 12px rgba(0,0,0,.22)" },
  sectionHead: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  sectionTitle: { margin: 0, fontSize: 11.5, fontWeight: 700, color: "#a5b4c9", textTransform: "uppercase", letterSpacing: 0.8, fontFamily: DISPLAY },
  miniBtn: { fontSize: 12, fontWeight: 600, border: "1px solid rgba(236,72,153,.35)", background: "rgba(236,72,153,.12)", color: "#f9a8d4", borderRadius: 8, padding: "3px 10px", cursor: "pointer" },

  actionCard: { position: "relative", background: "rgba(17,26,46,.7)", border: "1px solid rgba(148,163,184,.14)", borderRadius: 12, padding: 12, marginBottom: 10, boxShadow: "0 2px 14px rgba(0,0,0,.3)", overflow: "hidden", animation: "glidePop .28s cubic-bezier(.22,1,.36,1)" },
  actionTop: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 },
  method: { fontSize: 10, fontWeight: 800, color: "#fff", padding: "2px 7px", borderRadius: 5, letterSpacing: 0.5, boxShadow: "0 1px 6px rgba(0,0,0,.35)" },
  product: { fontSize: 12, color: "#a5b4c9", fontWeight: 600 },
  actionSummary: { fontSize: 14, marginBottom: 6, color: "#f1f5f9" },
  path: { display: "block", fontSize: 11, color: "#7dd3fc", background: "rgba(7,11,22,.7)", borderRadius: 6, padding: "5px 7px", wordBreak: "break-all", border: "1px solid rgba(56,189,248,.14)" },
  bodyDetails: { marginTop: 6 },
  bodySummary: { fontSize: 11, color: "#93a3b8", cursor: "pointer", userSelect: "none" },
  bodyPre: { margin: "6px 0 0", maxHeight: 220, overflow: "auto", fontSize: 11, lineHeight: 1.45, color: "#e5e7eb", background: "rgba(7,11,22,.7)", border: "1px solid rgba(148,163,184,.12)", borderRadius: 6, padding: "6px 8px", whiteSpace: "pre-wrap", wordBreak: "break-word" },
  bodyNote: { marginTop: 6, fontSize: 11, color: "#fbbf24", lineHeight: 1.45 },
  actionMeta: { fontSize: 11, color: "#64748b", margin: "6px 0" },
  actionBtns: { display: "flex", gap: 8 },
  applyBtn: { flex: 1, padding: "8px 0", borderRadius: 9, border: 0, background: "linear-gradient(135deg,#22c55e,#16a34a)", color: "#fff", fontWeight: 700, cursor: "pointer", boxShadow: "0 6px 16px rgba(34,197,94,.28)" },
  rejectBtn: { flex: 1, padding: "8px 0", borderRadius: 9, border: "1px solid rgba(148,163,184,.22)", background: "rgba(148,163,184,.06)", color: "#cbd5e1", cursor: "pointer" },

  kv: { display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13, padding: "5px 0", borderBottom: "1px solid rgba(148,163,184,.1)" },
  kvKey: { color: "#93a3b8" },
  kvVal: { color: "#f1f5f9", textAlign: "right", wordBreak: "break-all", fontWeight: 500 },

  resultRow: { display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 0" },
  dot: { width: 9, height: 9, borderRadius: 999, marginTop: 5, flexShrink: 0, boxShadow: "0 0 8px currentColor" },
  resultSummary: { fontSize: 13, color: "#e5e7eb" },
  resultDetail: { fontSize: 12, color: "#93a3b8" },

  tokenStatus: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10 },
  hint: { margin: "8px 0 0", fontSize: 11, color: "#64748b", lineHeight: 1.5 },
  guidanceNotice: { margin: "10px 0", padding: "9px 12px", borderRadius: 9, background: "rgba(9,13,24,.55)", border: "1px solid rgba(148,163,184,.14)", color: "#cbd5e1", fontSize: 12 },
  guidanceEditor: { border: "1px solid rgba(148,163,184,.14)", borderRadius: 13, padding: 16, background: "rgba(9,13,24,.55)", margin: "8px 0" },
  guidanceTextarea: { width: "100%", boxSizing: "border-box", resize: "vertical", minHeight: 150, padding: "12px 14px", borderRadius: 12, border: "1px solid #24304c", background: "rgba(7,11,22,.7)", color: "#f8fafc", fontSize: 14, lineHeight: 1.5, fontFamily: "inherit", outline: "none" },
  guidanceCheck: { display: "flex", alignItems: "center", gap: 8, marginTop: 12, fontSize: 13, color: "#cbd5e1", cursor: "pointer" },
  guidanceBtnRow: { display: "flex", gap: 10, marginTop: 16, alignItems: "center" },
  guidanceSaveBtn: { padding: "10px 18px", borderRadius: 10, border: 0, background: GRAD_CTA, color: "#fff", fontWeight: 800, fontSize: 14, cursor: "pointer", fontFamily: DISPLAY, boxShadow: "0 8px 20px rgba(236,72,153,.28)" },
  guidanceRowTop: { display: "flex", alignItems: "center", gap: 10 },
  guidanceBody: { marginTop: 6, fontSize: 13, color: "#cbd5e1", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" },
  guidanceActions: { display: "flex", alignItems: "center", gap: 8, marginTop: 12 },
  rejectBtnSm: { fontSize: 12, border: "1px solid #7f1d1d", background: "transparent", color: "#fca5a5", borderRadius: 6, padding: "2px 8px", cursor: "pointer" },
  inviteRow: { display: "flex", gap: 8 },
  miniPrimary: { flexShrink: 0, padding: "0 15px", borderRadius: 10, border: 0, background: GRAD_CTA, color: "#fff", fontWeight: 800, cursor: "pointer", fontFamily: DISPLAY, boxShadow: "0 6px 16px rgba(236,72,153,.28)" },
  linkRow: { display: "flex", alignItems: "center", gap: 8, marginTop: 6 },
  linkCode: { flex: 1, fontSize: 11, color: "#7dd3fc", background: "rgba(7,11,22,.7)", borderRadius: 6, padding: "6px 8px", wordBreak: "break-all", border: "1px solid rgba(56,189,248,.14)" },
  inviteItem: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid rgba(148,163,184,.1)" },
  inviteBy: { fontSize: 11, color: "#64748b", flexShrink: 0 },

  progressWrap: { position: "relative", height: 7, borderRadius: 999, background: "rgba(148,163,184,.16)", overflow: "hidden", margin: "10px 0 12px" },
  progressBar: { height: "100%", borderRadius: 999, background: GRAD_BRAND, backgroundSize: "200% auto", transition: "width .4s cubic-bezier(.22,1,.36,1)", boxShadow: "0 0 12px rgba(236,72,153,.5)" },
  checklist: { display: "flex", flexDirection: "column", gap: 7 },
  checkItem: { display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, cursor: "pointer", lineHeight: 1.4 },

  phaseTags: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 },
  phaseTag: { fontSize: 11, color: "#c4b5fd", background: "rgba(139,92,246,.12)", border: "1px solid rgba(139,92,246,.3)", borderRadius: 7, padding: "2px 8px", fontWeight: 600 },
  checkBox: { marginTop: 10, fontSize: 12, lineHeight: 1.5, border: "1px solid rgba(148,163,184,.14)", borderRadius: 8, padding: "8px 10px", whiteSpace: "pre-wrap" },
  snapRow: { display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid rgba(148,163,184,.1)" },
  snapZone: { fontSize: 13, color: "#e5e7eb", wordBreak: "break-all" },
  snapMeta: { fontSize: 11, color: "#64748b" },
  snapRestore: { flexShrink: 0, padding: "6px 13px", borderRadius: 8, border: "1px solid rgba(244,63,94,.45)", background: "rgba(244,63,94,.14)", color: "#fecdd3", fontSize: 12, fontWeight: 700, cursor: "pointer" },

  tfRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 0", borderBottom: "1px solid rgba(148,163,184,.1)" },
  tfName: { fontSize: 11, color: "#7dd3fc", wordBreak: "break-all" },

  // Onboarding wizard
  // Split layout: the wizard lives in a bounded top pane; the chat sits below it.
  wizPane: { display: "flex", flexDirection: "column", flex: "3 1 0", minHeight: 0, borderBottom: "1px solid rgba(148,163,184,.12)" },
  wizWrap: { flex: 1, overflowY: "auto", display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "28px 20px" },
  wizCard: { width: "100%", maxWidth: 640, background: "rgba(15,23,42,.72)", border: "1px solid rgba(148,163,184,.16)", borderRadius: 20, padding: 26, backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", boxShadow: "0 24px 70px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.05)" },
  wizHead: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12 },
  wizBrand: { ...brandText, fontSize: 13, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" },
  wizStepMeta: { fontSize: 12, color: "#93a3b8", marginTop: 3 },
  wizSkip: { background: "transparent", border: 0, color: "#64748b", fontSize: 12, cursor: "pointer", textDecoration: "underline" },
  wizProgress: { height: 7, borderRadius: 999, background: "rgba(148,163,184,.16)", overflow: "hidden", marginBottom: 18 },
  wizProgressBar: { height: "100%", background: GRAD_BRAND, backgroundSize: "200% auto", transition: "width .4s cubic-bezier(.22,1,.36,1)", boxShadow: "0 0 12px rgba(236,72,153,.5)" },
  wizTitle: { margin: "0 0 10px", fontSize: 24, fontWeight: 700, color: "#f8fafc", lineHeight: 1.22, fontFamily: DISPLAY, letterSpacing: -0.4 },
  wizWhy: { display: "flex", gap: 9, alignItems: "flex-start", background: "rgba(56,189,248,.07)", border: "1px solid rgba(56,189,248,.2)", borderRadius: 11, padding: "11px 13px", fontSize: 13, color: "#cbd5e1", lineHeight: 1.5, marginBottom: 18 },
  wizWhyIcon: { color: "#38bdf8", fontWeight: 800, flexShrink: 0 },
  wizBody: { minHeight: 120, marginBottom: 16 },
  wizInput: { width: "100%", boxSizing: "border-box", padding: "12px 14px", borderRadius: 11, border: "1px solid #24304c", background: "rgba(7,11,22,.7)", color: "#f8fafc", fontSize: 15, outline: "none" },
  wizNote: { fontSize: 13, color: "#fed7aa", background: "rgba(120,53,15,.4)", border: "1px solid rgba(249,115,22,.35)", borderRadius: 9, padding: "9px 12px", marginBottom: 10 },
  wizMutedRow: { textAlign: "center", color: "#64748b", fontSize: 12 },
  wizHintRow: { fontSize: 12, color: "#64748b", marginTop: 8 },
  wizPreviewMsg: { marginTop: 10, fontSize: 13, color: "#7dd3fc", background: "rgba(56,189,248,.07)", border: "1px solid rgba(56,189,248,.2)", borderRadius: 9, padding: "9px 12px", whiteSpace: "pre-wrap" },
  uploadRow: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" },
  uploadBtn: { padding: "12px 18px", borderRadius: 11, border: "1px dashed rgba(236,72,153,.45)", background: "rgba(236,72,153,.08)", color: "#f9a8d4", fontWeight: 700, fontSize: 14, cursor: "pointer" },
  fileLabel: { display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, color: "#e5e7eb", background: "rgba(7,11,22,.7)", border: "1px solid rgba(148,163,184,.14)", borderRadius: 8, padding: "6px 10px", wordBreak: "break-all" },
  clearFile: { background: "transparent", border: 0, color: "#64748b", fontSize: 12, cursor: "pointer", textDecoration: "underline" },
  formatHint: { fontSize: 12, color: "#93a3b8", marginTop: 8, lineHeight: 1.5 },

  choiceGrid: { display: "grid", gridTemplateColumns: "1fr", gap: 12 },
  choiceCard: { textAlign: "left", display: "flex", flexDirection: "column", gap: 6, padding: "16px 18px", borderRadius: 13, border: "1px solid #24304c", background: "rgba(7,11,22,.55)", color: "#e5e7eb", cursor: "pointer", transition: "border-color .18s, background .18s, box-shadow .18s, transform .12s" },
  choiceCardOn: { borderColor: "#ec4899", background: "linear-gradient(135deg, rgba(249,115,22,.14), rgba(236,72,153,.14))", boxShadow: "0 0 0 1px rgba(236,72,153,.35), 0 10px 28px rgba(236,72,153,.18)" },
  choiceTitle: { fontSize: 16, fontWeight: 700, color: "#f8fafc", fontFamily: DISPLAY, letterSpacing: -0.2 },
  choiceDesc: { fontSize: 13, color: "#93a3b8", lineHeight: 1.45 },

  chipWrap: { display: "flex", flexWrap: "wrap", gap: 10 },
  chip: { padding: "9px 15px", borderRadius: 999, border: "1px solid #24304c", background: "rgba(7,11,22,.55)", color: "#e5e7eb", fontSize: 14, cursor: "pointer", transition: "border-color .18s, background .18s, color .18s" },
  chipOn: { borderColor: "#ec4899", background: "linear-gradient(135deg, rgba(249,115,22,.18), rgba(236,72,153,.18))", color: "#fbcfe8", fontWeight: 700 },

  reviewList: { display: "flex", flexDirection: "column", gap: 2, marginBottom: 12 },

  wizSummary: { display: "flex", flexWrap: "wrap", gap: 8, padding: "12px 0", borderTop: "1px solid rgba(148,163,184,.12)", marginBottom: 4 },
  wizSummaryChip: { fontSize: 12, color: "#e5e7eb", background: "rgba(7,11,22,.6)", border: "1px solid rgba(148,163,184,.14)", borderRadius: 999, padding: "4px 11px" },

  wizFooter: { display: "flex", alignItems: "center", gap: 10, paddingTop: 8 },
  wizBack: { padding: "11px 20px", borderRadius: 11, border: "1px solid rgba(148,163,184,.2)", background: "rgba(148,163,184,.06)", color: "#cbd5e1", fontWeight: 600, cursor: "pointer" },
  wizPrimary: { padding: "11px 24px", borderRadius: 11, border: 0, background: GRAD_CTA, color: "#fff", fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: DISPLAY, letterSpacing: 0.2, boxShadow: "0 10px 26px rgba(236,72,153,.3)" },
  wizPrimarySm: { padding: "9px 17px", borderRadius: 9, border: 0, background: "linear-gradient(135deg,#22c55e,#16a34a)", color: "#fff", fontWeight: 700, cursor: "pointer", boxShadow: "0 6px 16px rgba(34,197,94,.28)" },

  // Admin dashboard (/admin)
  adminTag: { fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.7, color: "#fbcfe8", background: "rgba(236,72,153,.16)", border: "1px solid rgba(236,72,153,.4)", borderRadius: 999, padding: "3px 10px", fontFamily: DISPLAY },
  headerLink: { fontSize: 13, fontWeight: 700, color: "#f9a8d4", textDecoration: "none", border: "1px solid rgba(236,72,153,.35)", background: "rgba(236,72,153,.1)", borderRadius: 9, padding: "5px 12px" },

  adminStats: { display: "flex", flexWrap: "wrap", gap: 12, padding: "18px", borderBottom: "1px solid rgba(148,163,184,.1)", background: "rgba(9,13,24,.4)" },
  statCard: { flex: "1 1 120px", minWidth: 110, background: "rgba(15,23,42,.6)", border: "1px solid rgba(148,163,184,.12)", borderRadius: 14, padding: "14px 16px", boxShadow: "0 2px 12px rgba(0,0,0,.24)", animation: "glidePop .3s cubic-bezier(.22,1,.36,1)" },
  statNum: { fontSize: 30, fontWeight: 700, lineHeight: 1.05, letterSpacing: -1, fontFamily: DISPLAY },
  statLabel: { marginTop: 5, fontSize: 11, fontWeight: 700, color: "#93a3b8", textTransform: "uppercase", letterSpacing: 0.6 },

  tabBar: { display: "flex", gap: 8, padding: "12px 18px", borderBottom: "1px solid rgba(148,163,184,.1)", background: "rgba(9,13,24,.5)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", flexWrap: "wrap" },
  tab: { padding: "8px 15px", borderRadius: 999, border: "1px solid transparent", background: "rgba(148,163,184,.06)", color: "#93a3b8", fontSize: 13, fontWeight: 700, cursor: "pointer" },
  tabOn: { background: "linear-gradient(135deg, rgba(249,115,22,.18), rgba(236,72,153,.18))", border: "1px solid rgba(236,72,153,.4)", color: "#fbcfe8" },

  adminContent: { flex: 1, minHeight: 0, overflowY: "auto", padding: "20px 18px 40px", display: "flex", flexDirection: "column", gap: 16 },
  adminLoading: { color: "#9ca3af", fontSize: 14, textAlign: "center", padding: "20px 0" },

  panel: { background: "rgba(15,23,42,.55)", border: "1px solid rgba(148,163,184,.12)", borderRadius: 16, padding: 18, backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", boxShadow: "0 4px 20px rgba(0,0,0,.24)" },
  panelHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12 },
  panelTitle: { margin: 0, fontSize: 14, fontWeight: 700, color: "#f1f5f9", letterSpacing: -0.2, fontFamily: DISPLAY },
  panelMeta: { fontSize: 11, color: "#64748b", fontWeight: 600 },

  transcript: { display: "flex", flexDirection: "column", gap: 14 },
  commRow: { display: "flex", alignItems: "flex-start", gap: 10 },
  commWho: { fontSize: 12, fontWeight: 700, color: "#e5e7eb", marginBottom: 3 },
  commRole: { fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 },
  commText: { fontSize: 13, lineHeight: 1.55, color: "#cbd5e1", whiteSpace: "pre-wrap", wordBreak: "break-word" },

  listRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 0", borderBottom: "1px solid rgba(148,163,184,.1)" },
  listMeta: { fontSize: 11, color: "#64748b", flexShrink: 0 },

  docRow: { border: "1px solid rgba(148,163,184,.12)", borderRadius: 12, marginBottom: 10, overflow: "hidden", background: "rgba(17,26,46,.55)" },
  docHeadRow: { display: "flex", alignItems: "flex-start", gap: 12, padding: "13px 15px", cursor: "pointer" },
  docTitle: { fontSize: 14, fontWeight: 700, color: "#f8fafc" },
  docPath: { fontSize: 11, color: "#7dd3fc", wordBreak: "break-all" },
  docSummary: { fontSize: 12, color: "#93a3b8", marginTop: 4, lineHeight: 1.45 },
  docMetaCol: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3, flexShrink: 0, textAlign: "right" },
  docWhen: { fontSize: 12, color: "#e5e7eb", fontWeight: 600 },
  docSize: { fontSize: 11, color: "#64748b" },
  docToggle: { fontSize: 11, fontWeight: 700, color: "#f9a8d4", marginTop: 2 },
  docBody: { borderTop: "1px solid rgba(148,163,184,.12)", padding: "6px 16px 16px", background: "rgba(7,11,22,.5)", maxHeight: 520, overflowY: "auto" },

  // Minimal Markdown renderer (dev-docs viewer)
  mdRoot: { fontSize: 13, lineHeight: 1.6, color: "#cbd5e1" },
  mdH1: { fontSize: 20, fontWeight: 700, color: "#f8fafc", margin: "18px 0 10px", lineHeight: 1.25, fontFamily: DISPLAY, letterSpacing: -0.3 },
  mdH2: { fontSize: 16, fontWeight: 700, color: "#f8fafc", margin: "16px 0 8px", lineHeight: 1.3, fontFamily: DISPLAY, letterSpacing: -0.2 },
  mdH3: { fontSize: 14, fontWeight: 700, color: "#e5e7eb", margin: "14px 0 6px", fontFamily: DISPLAY },
  mdP: { margin: "0 0 10px" },
  mdCodeInline: { fontFamily: MONO, fontSize: 12, color: "#fbcfe8", background: "rgba(236,72,153,.1)", border: "1px solid rgba(236,72,153,.22)", borderRadius: 5, padding: "1px 5px" },
  mdPre: { margin: "0 0 12px", padding: "11px 13px", background: "rgba(7,11,22,.7)", border: "1px solid rgba(148,163,184,.14)", borderRadius: 9, overflowX: "auto", fontFamily: MONO, fontSize: 12, lineHeight: 1.5, color: "#e5e7eb", whiteSpace: "pre" },
  mdList: { margin: "0 0 12px", paddingLeft: 22 },
  mdLi: { margin: "3px 0" },
  mdQuote: { margin: "0 0 12px", padding: "6px 14px", borderLeft: "3px solid #ec4899", background: "rgba(236,72,153,.07)", color: "#cbd5e1", borderRadius: "0 8px 8px 0" },
  mdHr: { border: 0, borderTop: "1px solid rgba(148,163,184,.14)", margin: "16px 0" },
  mdA: { color: "#7dd3fc", textDecoration: "underline" },
  mdTableWrap: { overflowX: "auto", margin: "0 0 12px" },
  mdTable: { borderCollapse: "collapse", width: "100%", fontSize: 12 },
  mdTh: { border: "1px solid rgba(148,163,184,.14)", padding: "6px 10px", textAlign: "left", background: "rgba(17,26,46,.6)", color: "#e5e7eb", fontWeight: 700 },
  mdTd: { border: "1px solid rgba(148,163,184,.14)", padding: "6px 10px", color: "#cbd5e1", verticalAlign: "top" },
};

const rootEl = document.getElementById("root")!;
try {
  createRoot(rootEl).render(
    <StrictMode>
      <ErrorBoundary>
        <Root />
      </ErrorBoundary>
    </StrictMode>,
  );
} catch (err) {
  // Synchronous mount/import failures can't be caught by <ErrorBoundary>;
  // surface them instead of leaving a blank page.
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  rootEl.textContent = `Glide failed to start:\n\n${msg}`;
  rootEl.setAttribute(
    "style",
    "white-space:pre-wrap;word-break:break-word;padding:24px;font:13px ui-monospace,monospace;color:#fecaca;background:#0b1020;min-height:100vh",
  );
  console.error("Glide mount error:", err);
}

/** Detect a model claim that a new approval was queued in the current turn. */
const NEW_QUEUE_CLAIMS = [
  /\bqueued\s+for\s+(?:human\s+)?approval\b/i,
  /\b(?:request|action|change|domain|zone|record|rule|it|this)\b[^.!?\n]{0,120}\b(?:is|are|was|were|has been|have been|has now been|have now been)\s+(?:now\s+|successfully\s+)?queued\b/i,
  /\b(?:i|we|glide)\s+(?:have\s+|successfully\s+)?queued\b/i,
  /\b(?:i(?:['’]ve)?|we(?:['’]ve)?|glide)\s+(?:have\s+|just\s+|successfully\s+)*queued\b/i,
  /\b(?:i(?:['’]m| am)|we(?:['’]re| are)|glide is)\s+(?:(?:now|currently)\s+)?queue?ing\b[^.!?\n]{0,100}\b(?:approval|request|action|change|domain|zone|record|rule|it|this)\b/i,
  /\b(?:i(?:['’]m| am)|we(?:['’]re| are)|glide is)\s+(?:(?:now|currently)\s+)?queue?ing(?:\s+(?:now|currently))?\s*[.!?]*$/i,
  /\b(?:request|action|change|domain|zone|record|rule)\b[^.!?\n]{0,100}\b(?:is|are)\s+(?:(?:now|currently)\s+)?being\s+queued\b/i,
  /\badded\s+to\s+(?:the\s+)?(?:pending approvals?|approval queue)\b/i,
  /\bsubmitted\s+for\s+approval\b/i,
  /\b(?:request|action|change|domain|zone|record|rule|it|this)\b[^.!?\n]{0,100}\b(?:is|are)\s+(?:now\s+)?ready\s+for\s+approval\b/i,
  /\b(?:request|action|change|domain|zone|record|rule|it|this)\b[^.!?\n]{0,100}\b(?:is|are|now appears?|now visible)\s+in\s+(?:the\s+)?pending approvals?\b/i,
  /\bpending\s+id\s*:/i,
];

const NEGATED_QUEUE_CLAIM =
  /\b(?:(?:is|are|was|were|has|have)\s+(?:not|never)\s+(?:been\s+)?queued|(?:isn['’]t|aren['’]t|wasn['’]t|weren['’]t|hasn['’]t|haven['’]t)\s+(?:been\s+)?queued|(?:can['’]t|cannot|couldn['’]t|didn['’]t|won['’]t)\s+[^,;]{0,50}\bqueue|(?:failed|unable)\s+to\s+queue|queue?ing\s+(?:no|zero)\s+(?:approval|request|action|change|domain|zone|record|rule)s?|(?:no\s+action|nothing)\s+[^,;]{0,80}\b(?:queued|added\s+to\s+(?:the\s+)?(?:pending approvals?|approval queue)))\b/i;

const EXISTING_OR_CONDITIONAL_QUEUE =
  /^(?:if|when|once|unless)\b|\b(?:already|still|previously)\s+(?:been\s+)?queued\b|\bremains?\s+queued\b/i;

export function claimsNewQueuedAction(text: string): boolean {
  return text
    .split(/(?<=[.!?…;])\s+|\s+[—–]\s+|\s+but\s+|\n+/i)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .some(
      (clause) =>
        !NEGATED_QUEUE_CLAIM.test(clause) &&
        !EXISTING_OR_CONDITIONAL_QUEUE.test(clause) &&
        NEW_QUEUE_CLAIMS.some((pattern) => pattern.test(clause)),
    );
}

const ACTION_INTENT =
  /\b(?:let me|let['’]?s|i['’]?ll|i will|i['’]?m going to|i am going to|i['’]?m about to|i plan to|going to|about to|next,?\s+i['’]?ll|now,?\s+i['’]?ll|first,?\s+i['’]?ll|then\s+i['’]?ll)\b.*?\b(?:do(?:\s+(?:it|that))?|check|look\s?up|look|see|verify|confirm|find|search|list|fetch|retrieve|pull|inspect|scan|resolve|add(?:ing)?|creat(?:e|ing)|queu(?:e|ing)|update|delete|remove|set|change|configure|apply|run|execute|submit)\b/i;

// A reply that asks the user for something is a deliberate hand-off, not a
// dangling promise: the room knows exactly what to do next (answer). We detect
// this so normal onboarding prompts — "…which domain would you like to onboard?"
// or "tell me your domain so I can add the zone." — are NOT mistaken for an
// unfulfilled action just because they also describe an upcoming step. Before
// this guard, any warm multi-sentence prompt whose final sentence wasn't a
// literal "?" (e.g. it ended with an example) got its whole reply discarded and
// replaced with a terse "That step did not run." recovery line.
const SOLICITS_INPUT =
  /\b(?:let (?:me|us) know|tell (?:me|us)|give (?:me|us)|send (?:me|us)|share (?:your|the|it|that|those|these)|provide (?:your|the|a|an|me|us|it|that)|paste (?:your|the|it|in)|upload (?:your|the|it|a)|which\b|what(?:['’]s| is| are|['’]re)?\b|who(?:['’]s| is)?\b|where(?:['’]s| is| are)?\b|do you (?:have|want|need|know|use|prefer)|could you|can you|would you (?:like|prefer|mind)|go ahead and (?:tell|share|send|paste|upload|provide))\b/i;

// Unlike SOLICITS_INPUT, this is anchored to the final sentence so descriptive
// phrases such as "three of which are proxied" do not look like a hand-off.
const FINAL_HANDOFF_REQUEST =
  /^(?:please\s+)?(?:let (?:me|us) know|tell (?:me|us)|give (?:me|us)|send (?:me|us)|share\b|provide\b|paste\b|upload\b|choose\b|select\b|confirm\b)/i;
const TRAILING_QUESTION = /\?[\s*_~`'"”’)\]]*$/;
const QUESTION_EXAMPLE = /^(?:for (?:example|instance)\b|e\.g\.|you can (?:answer|reply|choose)\b)/i;

// "Let me know once you've approved it" is not a real question: it hands the
// turn back on the false premise that an action already exists.
const ACTION_DEPENDENT_HANDOFF =
  /\b(?:let (?:me|us) know|tell (?:me|us))\b[^.!?]{0,100}\b(?:after|once|when)\b[^.!?]{0,100}\b(?:approv(?:e|ed)|click(?:ed)?\s+apply)\b/i;
const REFERENCES_APPROVAL_QUEUE =
  /\b(?:pending approvals?|approval queue|pending (?:request|action)|click(?:ed)?\s+apply)\b/i;
const PROMISES_TO_QUEUE =
  /\b(?:i['’]?ll|i will|we['’]?ll|we will)\b[^.!?]{0,100}\bqueue\b/i;
const REQUESTS_APPROVAL =
  /\b(?:can|could|would|will) you\b[^.!?]{0,100}\b(?:approv(?:e|ed)|click\s+apply)\b/i;
const GENERIC_COURTESY_QUESTION =
  /^(?:(?:what|anything|is there anything|how)\s+else\b[^?]*|(?:can|may) i help\b[^?]*)\??$/i;

/** True when the reply asks the user for input (a question or explicit request). */
export function solicitsUserInput(prose: string): boolean {
  return /\?/.test(prose) || SOLICITS_INPUT.test(prose);
}

/** True when the reply finishes with a user-facing question or request. */
export function hasFinalUserHandoff(prose: string): boolean {
  const clauses = prose
    .trim()
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (!clauses.length) return false;

  const clean = (clause: string): string => clause.replace(/^[\s(>*#_`~-]+/, "");
  const last = clean(clauses[clauses.length - 1]);
  if (GENERIC_COURTESY_QUESTION.test(last)) return false;
  if (TRAILING_QUESTION.test(last) || FINAL_HANDOFF_REQUEST.test(last)) return true;

  // Preserve a final question followed only by a short example.
  if (clauses.length > 1 && QUESTION_EXAMPLE.test(last)) {
    return TRAILING_QUESTION.test(clean(clauses[clauses.length - 2]));
  }
  return false;
}

/**
 * True when a successful tool result would otherwise leave guided onboarding
 * without a clear hand-off to the user.
 */
export function needsOnboardingFollowUp(
  onboarding: { active?: boolean; completed?: boolean } | undefined,
  prose: string,
  hasSuccessfulToolOutput: boolean,
): boolean {
  return (
    !!onboarding?.active &&
    !onboarding.completed &&
    hasSuccessfulToolOutput &&
    !hasFinalUserHandoff(prose)
  );
}

type ToolStreamChunk = {
  type: string;
  toolCallId?: string;
  toolName?: string;
  output?: unknown;
};

/** True when the named tool produced a correlated, non-error output chunk. */
export function hasSuccessfulToolOutput(
  chunks: ReadonlyArray<ToolStreamChunk>,
  toolName: string,
): boolean {
  const callIds = new Set(
    chunks
      .filter(
        (chunk) =>
          chunk.type === "tool-input-available" &&
          chunk.toolName === toolName &&
          typeof chunk.toolCallId === "string",
      )
      .map((chunk) => chunk.toolCallId as string),
  );
  return chunks.some((chunk) => {
    if (chunk.type !== "tool-output-available" || !chunk.toolCallId || !callIds.has(chunk.toolCallId)) {
      return false;
    }
    if (typeof chunk.output === "string") {
      return !/^\s*Error(?:\s+from[^:]*)?:/i.test(chunk.output);
    }
    return !(
      chunk.output &&
      typeof chunk.output === "object" &&
      "ok" in chunk.output &&
      chunk.output.ok === false
    );
  });
}

/** Detect a future-tense action promise that ended without a tool-backed result. */
export function promisesToolAction(prose: string): boolean {
  if (!prose) return false;
  const clauses = prose
    .split(/(?<=[.!?…;])\s+|\s+[—–]\s+|\n+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (!clauses.length) return false;
  const asksForInput = clauses.some(
    (clause) => !GENERIC_COURTESY_QUESTION.test(clause) && solicitsUserInput(clause),
  );

  // A later question must not make an earlier unconditional "I'll queue it
  // now" promise look fulfilled. Conditional promises that ask for missing
  // input remain valid hand-offs.
  const unconditionalQueuePromise = clauses.some((clause, index) => {
    const promise = PROMISES_TO_QUEUE.exec(clause);
    if (!promise || /\b(?:if|when|once|after|unless)\b/i.test(clause)) return false;
    const solicitation = SOLICITS_INPUT.exec(clause);
    if (solicitation && solicitation.index < promise.index) return false;
    if (solicitation && promise.index <= solicitation.index) return true;
    const dependsOnEarlierInput = clauses.slice(0, index).some((earlier) => solicitsUserInput(earlier));
    return !dependsOnEarlierInput || /\bnow\b/i.test(clause);
  });
  if (unconditionalQueuePromise) return true;

  // Preserve explanatory hand-offs such as "I'll add it after you provide the
  // account", but catch an immediate promise before a later question for every
  // tool-backed action, not only queueing.
  const immediateActionPromise = clauses.some((clause, index) => {
    const intent = ACTION_INTENT.exec(clause);
    if (!intent || !/\b(?:now|currently|immediately|right away)\b/i.test(clause)) return false;
    if (/\b(?:if|when|once|after|unless)\b/i.test(clause)) return false;
    const solicitation = SOLICITS_INPUT.exec(clause);
    if (solicitation && solicitation.index < intent.index) return false;
    if (solicitation && intent.index <= solicitation.index) return true;
    return !clauses.slice(0, index).some((earlier) => solicitsUserInput(earlier));
  });
  if (immediateActionPromise) return true;

  // Asking the user anything (a "?" anywhere, or an explicit "tell me / let me
  // know / provide …" request) is a deliberate hand-off, so it can never be a
  // dead-end promise — leave the model's prose intact.
  const dependsOnApproval =
    (ACTION_DEPENDENT_HANDOFF.test(prose) &&
      (REFERENCES_APPROVAL_QUEUE.test(prose) || PROMISES_TO_QUEUE.test(prose))) ||
    (REQUESTS_APPROVAL.test(prose) && PROMISES_TO_QUEUE.test(prose));
  if (asksForInput && !dependsOnApproval) return false;
  return clauses.some((clause) => ACTION_INTENT.test(clause));
}

export function queueClaimCorrection(
  state: {
    tokenConfigured: boolean;
    tokenValid?: boolean;
    defaultZone?: { name: string };
    onboarding?: { domain?: string };
  },
  prose = "",
): string {
  if (state.tokenValid === false) {
    return (
      "Correction: no action was added to Pending approvals. The saved Cloudflare API token failed " +
      "verification; review or replace it in Connection > Change, then retry the request."
    );
  }
  if (!state.tokenConfigured) {
    return (
      "Correction: no action was added to Pending approvals. Check the required account or zone details, " +
      "and add a token in Connection > Set token if discovery is needed, then retry the request."
    );
  }

  const zone = state.defaultZone?.name.trim().replace(/\.$/, "");
  const onboardingDomains = (state.onboarding?.domain ?? "")
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((domain) => domain.replace(/\.$/, ""));
  // A zone mentioned as the target of another change (for example, a WAF rule)
  // is not an Add domain request. Require an explicit add/create-zone intent.
  const addZoneClaim =
    /\b(?:add(?:ing)?|creat(?:e|ing))\s+(?:(?:a|an|the|this|that|my|our|your)\s+)?(?:new\s+)?(?:cloudflare\s+)?(?:domain|zone)\b/i;
  const addZoneClauses = prose
    .split(/(?<=[.!?…;])\s+|\n+/)
    .map((clause) => clause.trim())
    .filter((clause) => addZoneClaim.test(clause));
  const claimedDomains = Array.from(
    new Set(
      addZoneClauses.flatMap(
        (clause) =>
          clause.toLowerCase().match(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/g) ?? [],
      ),
    ),
  );
  if (
    zone &&
    addZoneClauses.length > 0 &&
    ((claimedDomains.length === 1 && claimedDomains[0] === zone.toLowerCase()) ||
      (claimedDomains.length === 0 && onboardingDomains.length === 1 && onboardingDomains[0] === zone.toLowerCase()))
  ) {
    return (
      `No Add domain approval was created: ${zone} is already selected as this room's zone. ` +
      "Confirm it with find_zone if needed, then review its current DNS records."
    );
  }

  return (
    "Correction: no action was added to Pending approvals. Check the tool result and required account or " +
    "zone details, then retry the request."
  );
}

/** Normalize recoverable update_onboarding arguments after AI SDK validation fails. */
export function repairOnboardingToolInput(raw: string): string | undefined {
  let value: unknown = raw;
  for (let attempt = 0; attempt < 2 && typeof value === "string"; attempt++) {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const input = value as Record<string, unknown>;
  const repaired: Record<string, unknown> = {};
  const allowed = new Set([
    "path",
    "domain",
    "setupType",
    "setup_type",
    "migratingFrom",
    "migrating_from",
    "goals",
    "checkOff",
    "check_off",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return undefined;

  const pick = (...keys: string[]): { present: boolean; value: unknown; conflict: boolean } => {
    const present = keys.filter((candidate) => Object.hasOwn(input, candidate));
    if (!present.length) return { present: false, value: undefined, conflict: false };
    const value = input[present[0]];
    const serialized = JSON.stringify(value);
    const conflict = present.slice(1).some((key) => JSON.stringify(input[key]) !== serialized);
    return { present: true, value, conflict };
  };

  const enumField = (target: string, allowed: string[], ...keys: string[]): boolean => {
    const field = pick(...keys);
    if (!field.present) return true;
    if (field.conflict) return false;
    if (typeof field.value !== "string") return false;
    const normalized = field.value.trim().toLowerCase();
    if (!allowed.includes(normalized)) return false;
    repaired[target] = normalized;
    return true;
  };
  const stringField = (target: string, ...keys: string[]): boolean => {
    const field = pick(...keys);
    if (!field.present) return true;
    if (field.conflict) return false;
    if (typeof field.value !== "string" || !field.value.trim()) return false;
    repaired[target] = field.value.trim();
    return true;
  };
  const listField = (target: string, ...keys: string[]): boolean => {
    const field = pick(...keys);
    if (!field.present) return true;
    if (field.conflict) return false;
    if (!Array.isArray(field.value) || field.value.some((item) => typeof item !== "string" || !item.trim())) {
      return false;
    }
    repaired[target] = field.value.map((item) => (item as string).trim());
    return true;
  };

  const valid =
    enumField("path", ["migrate", "fresh"], "path") &&
    stringField("domain", "domain") &&
    enumField("setupType", ["full", "partial", "unsure"], "setupType", "setup_type") &&
    stringField("migratingFrom", "migratingFrom", "migrating_from") &&
    listField("goals", "goals") &&
    listField("checkOff", "checkOff", "check_off");
  if (!valid) return undefined;

  return Object.keys(repaired).length ? JSON.stringify(repaired) : undefined;
}

/** Detect a model claim that a new approval was queued in the current turn. */
const NEW_QUEUE_CLAIMS = [
  /\bqueued\s+for\s+(?:human\s+)?approval\b/i,
  /\b(?:request|action|change|domain|zone|record|rule|it|this)\b[^.!?\n]{0,120}\b(?:is|are|was|were|has been|have been|has now been|have now been)\s+(?:now\s+|successfully\s+)?queued\b/i,
  /\b(?:i|we|glide)\s+(?:have\s+|successfully\s+)?queued\b/i,
  /\b(?:i(?:['’]ve)?|we(?:['’]ve)?|glide)\s+(?:have\s+|just\s+|successfully\s+)*queued\b/i,
  /\badded\s+to\s+(?:the\s+)?(?:pending approvals?|approval queue)\b/i,
  /\bsubmitted\s+for\s+approval\b/i,
  /\b(?:request|action|change|domain|zone|record|rule|it|this)\b[^.!?\n]{0,100}\b(?:is|are)\s+(?:now\s+)?ready\s+for\s+approval\b/i,
  /\b(?:request|action|change|domain|zone|record|rule|it|this)\b[^.!?\n]{0,100}\b(?:is|are|now appears?|now visible)\s+in\s+(?:the\s+)?pending approvals?\b/i,
  /\bpending\s+id\s*:/i,
];

const NEGATED_QUEUE_CLAIM =
  /\b(?:(?:is|are|was|were|has|have)\s+(?:not|never)\s+(?:been\s+)?queued|(?:isn['’]t|aren['’]t|wasn['’]t|weren['’]t|hasn['’]t|haven['’]t)\s+(?:been\s+)?queued|(?:can['’]t|cannot|couldn['’]t|didn['’]t|won['’]t)\s+[^,;]{0,50}\bqueue|(?:failed|unable)\s+to\s+queue|(?:no\s+action|nothing)\s+[^,;]{0,80}\b(?:queued|added\s+to\s+(?:the\s+)?(?:pending approvals?|approval queue)))\b/i;

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

/** True when the reply asks the user for input (a question or explicit request). */
export function solicitsUserInput(prose: string): boolean {
  return /\?/.test(prose) || SOLICITS_INPUT.test(prose);
}

/** Detect a future-tense action promise that ended without a tool-backed result. */
export function promisesToolAction(prose: string): boolean {
  if (!prose) return false;
  // Asking the user anything (a "?" anywhere, or an explicit "tell me / let me
  // know / provide …" request) is a deliberate hand-off, so it can never be a
  // dead-end promise — leave the model's prose intact.
  if (solicitsUserInput(prose)) return false;
  const sentences = prose
    .split(/(?<=[.!?…])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  if (!sentences.length) return false;
  return sentences.some((sentence) => ACTION_INTENT.test(sentence));
}

export function queueClaimCorrection(state: {
  tokenConfigured: boolean;
  tokenValid?: boolean;
}): string {
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
  return (
    "Correction: no action was added to Pending approvals. Check the tool result and required account or " +
    "zone details, then retry the request."
  );
}

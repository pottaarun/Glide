import assert from "node:assert/strict";
import test from "node:test";

import {
  claimsNewQueuedAction,
  hasSuccessfulToolOutput,
  needsOnboardingFollowUp,
  promisesToolAction,
  queueClaimCorrection,
  repairOnboardingToolInput,
} from "../src/chat-integrity.ts";

test("detects the false queue claim shown in the onboarding chat", () => {
  const response =
    "Your Add domain arubhe.com request is now queued. A teammate needs to click Apply in Pending approvals.";

  assert.equal(claimsNewQueuedAction(response), true);
});

test("does not flag truthful negative or existing-queue descriptions", () => {
  assert.equal(claimsNewQueuedAction("No action was added to Pending approvals."), false);
  assert.equal(claimsNewQueuedAction("The failed action remains queued for Retry."), false);
  assert.equal(claimsNewQueuedAction("I could not queue the domain because the token is invalid."), false);
  assert.equal(claimsNewQueuedAction("The action was already queued for approval."), false);
  assert.equal(claimsNewQueuedAction("If it is queued for approval, click Apply."), false);
});

test("checks the queue clause instead of unrelated negative wording", () => {
  assert.equal(claimsNewQueuedAction("It isn't live; it is queued for approval."), true);
  assert.equal(claimsNewQueuedAction("Verification failed, but the domain was queued."), true);
  assert.equal(claimsNewQueuedAction("The domain has now been queued."), true);
  assert.equal(claimsNewQueuedAction("The action was submitted for approval."), true);
  assert.equal(claimsNewQueuedAction("I've queued your domain."), true);
  assert.equal(claimsNewQueuedAction("Your domain is ready for approval."), true);
  assert.equal(claimsNewQueuedAction("I'm queuing the Add domain action now."), true);
  assert.equal(claimsNewQueuedAction("I'm queueing the Add domain action now."), true);
  assert.equal(claimsNewQueuedAction("I'm currently queuing the DNS change."), true);
  assert.equal(claimsNewQueuedAction("The action is being queued."), true);
  assert.equal(claimsNewQueuedAction("I'm queueing it now."), true);
  assert.equal(claimsNewQueuedAction("I'm queueing now."), true);
  assert.equal(claimsNewQueuedAction("I'm queuing questions for our next discussion."), false);
  assert.equal(claimsNewQueuedAction("I'm queuing no action."), false);
});

test("detects broad dangling action promises", () => {
  assert.equal(promisesToolAction("I'll do it now."), true);
  assert.equal(promisesToolAction("I'll update the setting."), true);
  assert.equal(promisesToolAction("Let's proceed with adding the domain."), true);
  assert.equal(promisesToolAction("I’ll be able to pull the DNS records."), true);
  assert.equal(promisesToolAction("Should I update the setting?"), false);
  assert.equal(promisesToolAction("I'll update the setting. What else can I help with?"), true);
  assert.equal(promisesToolAction("I'll delete it. Is there anything else you'd like help with?"), true);
  assert.equal(
    promisesToolAction("I will now queue an action to add your domain. Someone must click Apply."),
    true,
  );
  assert.equal(
    promisesToolAction("I'll queue the domain now. Let me know when you've approved the pending request."),
    true,
  );
  assert.equal(
    promisesToolAction("I'll queue the domain now. Let me know once you've approved it."),
    true,
  );
  assert.equal(
    promisesToolAction("I'll queue the domain now. Can you approve it once it appears?"),
    true,
  );
  assert.equal(
    promisesToolAction("I'll queue the domain. Can you approve it once it appears?"),
    true,
  );
  assert.equal(
    promisesToolAction("I'll queue the domain. Which account should I use?"),
    true,
  );
  assert.equal(
    promisesToolAction("I'll queue the domain now — which account should I use?"),
    true,
  );
  assert.equal(
    promisesToolAction("Which account should I use? I'll queue the domain after you choose one."),
    false,
  );
  for (const response of [
    "I'll add the domain now. Which account should I use?",
    "I'll check whether the zone exists now — which account should I use?",
    "I'll update the setting immediately. Which value should it use?",
    "I'll delete the rule right away. Which rule did you mean?",
  ]) {
    assert.equal(promisesToolAction(response), true, response);
  }
  assert.equal(promisesToolAction("Tell me the account id and I'll queue the domain."), false);
  assert.equal(promisesToolAction("Which setting should I update? Anything else I should know?"), false);
  assert.equal(
    promisesToolAction(
      "I'll verify activation after the nameserver change. Let me know when you've finished at the registrar.",
    ),
    false,
  );
});

test("does not flag onboarding replies that ask the user for input", () => {
  // Regression: a warm multi-sentence onboarding intro that describes an
  // upcoming step but hands the turn back by asking for the domain must NOT be
  // clobbered — even when the final sentence is not a literal "?".
  assert.equal(
    promisesToolAction(
      "Great — since you're starting fresh, let's get you onto Cloudflare. First, I'll add your domain as a zone. What domain would you like to onboard? For example, example.com.",
    ),
    false,
  );
  assert.equal(
    promisesToolAction("You're starting fresh, so I'll add your domain. Please let me know your domain name (e.g. example.com)."),
    false,
  );
  assert.equal(
    promisesToolAction("Let me start by adding your domain — tell me the domain name you'd like to onboard."),
    false,
  );
  assert.equal(
    promisesToolAction("To get started, please provide your domain name so I can create the zone."),
    false,
  );
});

test("continues active onboarding after a successful tool result that asks no question", () => {
  const active = { active: true, completed: false };
  const dnsSummary = "I found eight DNS records and displayed them above.";

  assert.equal(needsOnboardingFollowUp(active, dnsSummary, true), true);
  assert.equal(
    needsOnboardingFollowUp(active, `${dnsSummary} Which records should Cloudflare proxy?`, true),
    false,
  );
  assert.equal(
    needsOnboardingFollowUp(active, `${dnsSummary} Tell me which records should be proxied.`, true),
    false,
  );
  assert.equal(
    needsOnboardingFollowUp(active, "I found eight records, three of which are proxied.", true),
    true,
  );
  assert.equal(
    needsOnboardingFollowUp(active, "Here is what I found: eight DNS records.", true),
    true,
  );
  assert.equal(
    needsOnboardingFollowUp(active, "What is currently proxied is listed above.", true),
    true,
  );
  assert.equal(
    needsOnboardingFollowUp(active, "Why does this matter? The records are listed above.", true),
    true,
  );
  assert.equal(
    needsOnboardingFollowUp(active, "Which records should Cloudflare proxy? For example, your web records.", true),
    false,
  );
  assert.equal(
    needsOnboardingFollowUp(active, "Which records should Cloudflare proxy? (For example, www.)", true),
    false,
  );
  assert.equal(
    needsOnboardingFollowUp(active, "I found eight DNS records. Is there anything else I can help with?", true),
    true,
  );
});

test("does not force an onboarding follow-up without a successful tool or after completion", () => {
  const summary = "Here is how Cloudflare proxy status works.";

  assert.equal(needsOnboardingFollowUp({ active: true }, summary, false), false);
  assert.equal(needsOnboardingFollowUp({ active: true, completed: true }, summary, true), false);
  assert.equal(needsOnboardingFollowUp({ active: false }, summary, true), false);
  assert.equal(needsOnboardingFollowUp(undefined, summary, true), false);
});

test("requires a correlated, non-error output for a successful tool result", () => {
  const input = {
    type: "tool-input-available",
    toolCallId: "dns-1",
    toolName: "list_dns_records",
  };
  const output = { type: "tool-output-available", toolCallId: "dns-1", output: "[]" };

  assert.equal(hasSuccessfulToolOutput([input, output], "list_dns_records"), true);
  assert.equal(hasSuccessfulToolOutput([input], "list_dns_records"), false);
  assert.equal(
    hasSuccessfulToolOutput([input, { ...output, toolCallId: "dns-2" }], "list_dns_records"),
    false,
  );
  assert.equal(hasSuccessfulToolOutput([input, output], "find_zone"), false);
  assert.equal(
    hasSuccessfulToolOutput(
      [input, { type: "tool-output-error", toolCallId: "dns-1", output: "failed" }],
      "list_dns_records",
    ),
    false,
  );
  assert.equal(
    hasSuccessfulToolOutput([input, { ...output, output: "Error: forbidden" }], "list_dns_records"),
    false,
  );
  assert.equal(
    hasSuccessfulToolOutput([input, { ...output, output: { ok: false } }], "list_dns_records"),
    false,
  );
});

test("unverified tokens produce a deterministic recovery step", () => {
  const correction = queueClaimCorrection({ tokenConfigured: true, tokenValid: false });

  assert.match(correction, /no action was added/i);
  assert.match(correction, /failed verification/i);
  assert.match(correction, /Connection > Change/);
});

test("an existing zone replaces a false Add domain approval claim with the correct next step", () => {
  const correction = queueClaimCorrection(
    {
      tokenConfigured: true,
      tokenValid: true,
      defaultZone: { name: "arubhe.com" },
      onboarding: { domain: "arubhe.com" },
    },
    "I'm queuing the Add domain action for arubhe.com now.",
  );

  assert.match(correction, /already selected/i);
  assert.match(correction, /No Add domain approval was created/i);
  assert.match(correction, /review its current DNS records/i);
});

test("existing-zone correction only applies to the exact claimed domain", () => {
  const correction = queueClaimCorrection(
    {
      tokenConfigured: true,
      tokenValid: true,
      defaultZone: { name: "old.com" },
      onboarding: { domain: "old.com, new.com" },
    },
    "I'm queuing the Add domain action for new.com now.",
  );

  assert.match(correction, /^Correction: no action was added/);
  assert.doesNotMatch(correction, /old\.com/);

  const contextualCorrection = queueClaimCorrection(
    {
      tokenConfigured: true,
      tokenValid: true,
      defaultZone: { name: "old.com" },
      onboarding: { domain: "old.com, new.com" },
    },
    "old.com is selected for reference. I'm queuing the Add domain action for new.com now.",
  );
  assert.match(contextualCorrection, /^Correction: no action was added/);
  assert.doesNotMatch(contextualCorrection, /old\.com/);
});

test("an existing zone does not turn a false WAF queue claim into an Add domain correction", () => {
  const correction = queueClaimCorrection(
    {
      tokenConfigured: true,
      tokenValid: true,
      defaultZone: { name: "example.com" },
      onboarding: { domain: "example.com" },
    },
    "I'm queueing a WAF rule for the example.com zone now.",
  );

  assert.match(correction, /^Correction: no action was added/);
  assert.doesNotMatch(correction, /No Add domain approval/);

  const createBlockCorrection = queueClaimCorrection(
    {
      tokenConfigured: true,
      tokenValid: true,
      defaultZone: { name: "example.com" },
      onboarding: { domain: "example.com" },
    },
    "I'm queueing a WAF rule to create a block for domain example.com.",
  );
  assert.doesNotMatch(createBlockCorrection, /No Add domain approval/);
});

test("repairs normalized and double-encoded onboarding tool arguments", () => {
  assert.equal(repairOnboardingToolInput('{"setupType":" FULL "}'), '{"setupType":"full"}');
  assert.equal(
    repairOnboardingToolInput('"{\\"setup_type\\":\\"partial\\"}"'),
    '{"setupType":"partial"}',
  );
  assert.equal(repairOnboardingToolInput('{"goals":[]}'), '{"goals":[]}');
  assert.equal(repairOnboardingToolInput('{"path":"migration","domain":"example.com"}'), undefined);
  assert.equal(repairOnboardingToolInput('{"goals":["dns",1]}'), undefined);
  assert.equal(repairOnboardingToolInput('{"setupType":"invalid"}'), undefined);
  assert.equal(repairOnboardingToolInput('{"setup_type":"full","unexpected":true}'), undefined);
  assert.equal(repairOnboardingToolInput('{"setupType":"full","setup_type":"partial"}'), undefined);
});

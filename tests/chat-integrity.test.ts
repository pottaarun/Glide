import assert from "node:assert/strict";
import test from "node:test";

import {
  claimsNewQueuedAction,
  promisesToolAction,
  queueClaimCorrection,
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
});

test("detects broad dangling action promises", () => {
  assert.equal(promisesToolAction("I'll do it now."), true);
  assert.equal(promisesToolAction("I'll update the setting."), true);
  assert.equal(promisesToolAction("Let's proceed with adding the domain."), true);
  assert.equal(promisesToolAction("I’ll be able to pull the DNS records."), true);
  assert.equal(promisesToolAction("Should I update the setting?"), false);
  assert.equal(
    promisesToolAction("I will now queue an action to add your domain. Someone must click Apply."),
    true,
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

test("unverified tokens produce a deterministic recovery step", () => {
  const correction = queueClaimCorrection({ tokenConfigured: true, tokenValid: false });

  assert.match(correction, /no action was added/i);
  assert.match(correction, /failed verification/i);
  assert.match(correction, /Connection > Change/);
});

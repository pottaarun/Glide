import assert from "node:assert/strict";
import test from "node:test";

import { hasAffirmedMatch } from "../src/text-signals.ts";
import { MAX_CHAT_TEXT_CHARS } from "../src/chat-delivery.ts";

test("text signals distinguish affirmative and negated business answers", () => {
  const api = /\b(api|graphql|endpoints?)\b/;
  const login = /\b(log ?in|logins?|authentication|user accounts?)\b/;
  assert.equal(hasAffirmedMatch("We expose a public API", api), true);
  assert.equal(hasAffirmedMatch("We do not expose an API", api), false);
  assert.equal(hasAffirmedMatch("No API or user accounts", api), false);
  assert.equal(hasAffirmedMatch("We don't have logins", login), false);
  assert.equal(hasAffirmedMatch("No API, authentication, or user accounts", login), false);
  assert.equal(hasAffirmedMatch("We don't have logins, but we expose an API", api), true);
  assert.equal(hasAffirmedMatch("Our product is API-free", api), false);
});

test("text signals keep negation scoped to its clause", () => {
  const waf = /\b(waf|firewall|security)\b/;
  assert.equal(hasAffirmedMatch("We do not need WAF. Security is still a priority.", waf), true);
  assert.equal(hasAffirmedMatch("We need no firewall", waf), false);
  assert.equal(hasAffirmedMatch("WAF is not needed", waf), false);
});

test("repeated matches stay bounded at the maximum accepted chat size", () => {
  const text = "api ".repeat(MAX_CHAT_TEXT_CHARS / 4);
  assert.equal(hasAffirmedMatch(text, /\bapi\b/), true);
});

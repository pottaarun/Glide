const NEGATIONS = new Set([
  "no",
  "not",
  "never",
  "neither",
  "nor",
  "without",
  "avoid",
  "avoiding",
  "exclude",
  "excluding",
  "skip",
  "skipping",
  "don't",
  "dont",
  "doesn't",
  "doesnt",
  "isn't",
  "isnt",
  "aren't",
  "arent",
  "can't",
  "cant",
  "cannot",
  "won't",
  "wont",
]);

/**
 * Match a user signal only when it is not negated in the same short clause.
 * This keeps phrases such as "no API" and "we don't have logins" from being
 * persisted as affirmative business-profile answers.
 */
export function hasAffirmedMatch(text: string, pattern: RegExp): boolean {
  const baseFlags = pattern.flags.replace(/[gy]/g, "");
  const flags = `${baseFlags.includes("i") ? baseFlags : `${baseFlags}i`}g`;
  const matcher = new RegExp(pattern.source, flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    // Only a short local clause can negate a signal. Bounding this window keeps
    // repeated adversarial matches linear instead of rescanning a growing prefix.
    const before = text.slice(Math.max(0, match.index - 192), match.index);
    const punctuation = Math.max(
      before.lastIndexOf("."),
      before.lastIndexOf(";"),
      before.lastIndexOf("!"),
      before.lastIndexOf("?"),
      before.lastIndexOf("\n"),
    );
    const conjunction = Math.max(before.lastIndexOf(" but "), before.lastIndexOf(" however "));
    const clause = before.slice(Math.max(punctuation, conjunction) + 1);
    const words = clause.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g)?.slice(-6) ?? [];
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 32);
    const negatedAfter = /^\s*(?:[- ]?free\b|(?:is|are)?\s*(?:not|never)\b|(?:isn't|isnt|aren't|arent)\b|disabled?\b|off\b)/i.test(after);
    if (!words.some((word) => NEGATIONS.has(word)) && !negatedAfter) return true;
    if (match[0].length === 0) matcher.lastIndex += 1;
  }
  return false;
}

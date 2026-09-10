// Input sanitization for anything that ends up inside a prompt sent to the
// model. Purely about EFFICIENCY (token/context waste) and basic input
// hygiene — NOT a jailbreak/safety filter. The system prompts in
// chat.js/exam.js are still what constrains model behavior.
//
// Kept dependency-free (just regex + String methods) so it costs nothing
// extra to run on every request.

"use strict";

const MAX_MESSAGE_LENGTH = 800; // hard ceiling per single chat message, chars
const MAX_QUERY_LENGTH = 200; // exam "perform" queries are short by nature

// Invisible / zero-width unicode sometimes used (accidentally or not) to
// smuggle extra characters past naive length checks — never meaningful in
// normal chat text, always safe to drop.
const ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E\uFEFF]/g;

// C0/C1 control characters except \n and \t — never legitimate here.
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

// Collapse runs of 3+ blank lines / runs of 3+ horizontal whitespace — these
// don't add meaning but do add tokens.
const MULTI_BLANK_LINES_RE = /\n{3,}/g;
const MULTI_SPACE_RE = /[ \t]{3,}/g;

// Collapse pathological single-character flooding ("aaaaaaaaaaaa...",
// "!!!!!!!!!!!!") down to a short run — keeps emphasis, drops the padding.
const CHAR_FLOOD_RE = /(.)\1{6,}/g;

/**
 * Sanitize a single free-text field before it's placed in a prompt.
 * Order matters: strip invisible/control chars first, THEN collapse
 * whitespace/flooding (so stripping doesn't re-introduce runs), THEN
 * enforce the length ceiling last so truncation happens on already-clean
 * text.
 */
function sanitizeText(input, { maxLength = MAX_MESSAGE_LENGTH } = {}) {
  if (typeof input !== "string") return "";

  let text = input
    .normalize("NFKC")
    .replace(ZERO_WIDTH_RE, "")
    .replace(CONTROL_CHARS_RE, "")
    .replace(CHAR_FLOOD_RE, "$1$1$1$1")
    .replace(MULTI_BLANK_LINES_RE, "\n\n")
    .replace(MULTI_SPACE_RE, " ")
    .trim();

  if (text.length > maxLength) {
    let cut = text.slice(0, maxLength);
    const lastSpace = cut.lastIndexOf(" ");
    // Prefer cutting on a word boundary, but only if it doesn't throw away
    // a large chunk of the budget doing so.
    if (lastSpace > maxLength * 0.8) cut = cut.slice(0, lastSpace);
    text = cut.trim() + "…";
  }

  return text;
}

/**
 * Sanitizes a chat history array of {role, content}, dropping malformed or
 * empty entries entirely (no point spending tokens/processing on them).
 */
function sanitizeHistory(history, opts = {}) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((h) => h && typeof h.content === "string" && h.content.trim() !== "")
    .map((h) => ({
      role: h.role === "assistant" ? "assistant" : "user",
      content: sanitizeText(h.content, opts),
    }));
}

// Case category/id come straight from the client and are used to build a
// filesystem path in caseLoader.js. Restricting them to a safe slug shape
// with a regex means invalid values are rejected in microseconds, before
// any file I/O or model call is attempted — cheap fail-fast validation
// rather than sanitization-by-stripping.
const SAFE_SLUG_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function isSafeSlug(value) {
  return typeof value === "string" && SAFE_SLUG_RE.test(value);
}

module.exports = {
  sanitizeText,
  sanitizeHistory,
  isSafeSlug,
  MAX_MESSAGE_LENGTH,
  MAX_QUERY_LENGTH,
};

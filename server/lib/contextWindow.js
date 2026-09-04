// Dynamic context window: instead of always keeping a FIXED number of past
// messages (e.g. "last 16"), size the kept history to an actual TOKEN
// BUDGET. A run of short "ya"/"tidak ada" exchanges keeps way more turns of
// real memory; a run of long verbose exchanges gets trimmed harder — either
// way the request stays inside a predictable token ceiling, which is what
// actually controls context/token/processing cost (message *count* is only
// a rough proxy for that).

"use strict";

// No tokenizer dependency — this heuristic (chars/4) is a standard rough
// estimate for Latin-script text and is intentionally conservative (tends
// to slightly over-count), which is fine for a budget we don't want to
// exceed.
function estimateTokens(text = "") {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

function estimateMessageTokens(msg) {
  // +4 for role/message-object overhead, roughly matching chat-format
  // conventions.
  return estimateTokens(msg && msg.content) + 4;
}

/**
 * Picks the largest *recent* suffix of `history` that fits inside a token
 * budget.
 *
 * @param {Array<{role:string, content:string}>} history - full history, oldest first
 * @param {object} opts
 * @param {number} opts.systemTokens   tokens already spent on system prompt(s)
 * @param {number} opts.reserveTokens  tokens to reserve for the new user message + model reply
 * @param {number} opts.maxContextTokens total token ceiling for the whole request
 * @param {number} opts.minMessages    always keep at least this many of the most recent
 *                                     messages if they exist, even if slightly over budget —
 *                                     avoids a degenerate "no memory at all" case
 * @param {number} opts.maxMessages    hard ceiling on message count regardless of budget
 *                                     (safety net against pathologically tiny messages)
 * @returns {{history: Array, usedTokens: number, droppedCount: number}}
 */
function fitHistoryToBudget(history, {
  systemTokens = 0,
  reserveTokens = 400,
  maxContextTokens = 3000,
  minMessages = 2,
  maxMessages = 40,
} = {}) {
  if (!Array.isArray(history) || history.length === 0) {
    return { history: [], usedTokens: 0, droppedCount: 0 };
  }

  const budget = Math.max(0, maxContextTokens - systemTokens - reserveTokens);

  const kept = [];
  let used = 0;

  for (let i = history.length - 1; i >= 0 && kept.length < maxMessages; i--) {
    const cost = estimateMessageTokens(history[i]);
    if (used + cost > budget && kept.length >= minMessages) break;
    kept.unshift(history[i]);
    used += cost;
  }

  return { history: kept, usedTokens: used, droppedCount: history.length - kept.length };
}

module.exports = { estimateTokens, estimateMessageTokens, fitHistoryToBudget };

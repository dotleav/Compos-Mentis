/**
 * "Bring your own API key" — Dev Mode -> Settings -> API key sendiri. See
 * server/lib/userKeys.js for storage/encryption and
 * server/lib/session.js for how a browser is identified without a login
 * system.
 *
 * Every route below is scoped to req.sessionId, so even without any Dev
 * Mode gate on the SERVER side (the Dev Mode password is client-side only —
 * see index.html's own comment on that — it can't be what actually protects
 * this), one browser can only ever read/write its own keys, never anyone
 * else's.
 */

const express = require("express");
const userKeys = require("../lib/userKeys");

const router = express.Router();

function requireSession(req, res) {
  if (!req.sessionConfigured) {
    res.status(503).json({
      error: "SESSION_SECRET belum diset di server. Lihat .env.example.",
    });
    return false;
  }
  return true;
}

// GET /api/keys/status — which providers already have a saved key for this
// browser (booleans + a masked hint only, never the real key).
router.get("/status", (req, res) => {
  if (!requireSession(req, res)) return;
  res.json(userKeys.getStatus(req.sessionId));
});

// POST /api/keys/:provider  { apiKey } or, for cloudflare, { accountId, apiToken }
router.post("/:provider", (req, res) => {
  if (!requireSession(req, res)) return;
  const { provider } = req.params;
  if (!userKeys.PROVIDER_FIELDS[provider]) {
    return res.status(400).json({ error: `Provider "${provider}" tidak dikenal.` });
  }
  try {
    userKeys.setKey(req.sessionId, provider, req.body || {});
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/keys/:provider
router.delete("/:provider", (req, res) => {
  if (!requireSession(req, res)) return;
  const { provider } = req.params;
  const ok = userKeys.removeKey(req.sessionId, provider);
  res.json({ ok });
});

module.exports = router;

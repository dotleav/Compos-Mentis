/**
 * Google Drive connect flow for Custom Case backups — per-browser-session
 * now (see server/lib/session.js), so each person connects their OWN
 * Drive. See server/lib/googleDrive.js for the scope/setup notes.
 */

const express = require("express");
const drive = require("../lib/googleDrive");

const router = express.Router();

function requireSession(req, res) {
  if (!req.sessionConfigured) {
    res.status(503).json({ error: "SESSION_SECRET belum diset di server. Lihat .env.example." });
    return false;
  }
  return true;
}

// GET /api/drive/status
router.get("/status", (req, res) => {
  if (!requireSession(req, res)) return;
  res.json(drive.getStatus(req.sessionId));
});

// GET /api/drive/auth-url — frontend opens this in a new tab to start
// Google's consent screen.
router.get("/auth-url", (req, res) => {
  if (!requireSession(req, res)) return;
  if (!drive.isConfigured()) {
    return res.status(400).json({
      error:
        "Google Drive belum dikonfigurasi di server (GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI kosong di .env).",
    });
  }
  res.json({ url: drive.getAuthUrl(req.sessionId) });
});

// GET /api/drive/callback — Google redirects here after consent. This is a
// plain server-rendered page (not part of the SPA) since it opens in
// whatever tab/window the consent screen used. The session cookie is still
// sent on this top-level GET (SameSite=Lax allows that), which is how this
// callback knows which browser to attribute the tokens to.
router.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;
  const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8">
    <title>${title}</title>
    <style>
      body{font-family:system-ui,sans-serif;background:#101b18;color:#eaf2ee;
        display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;}
      div{max-width:420px;padding:24px;}
      h1{font-size:1.1rem;}
      p{color:#7f9c92;font-size:0.9rem;}
    </style></head><body><div><h1>${title}</h1><p>${body}</p></div></body></html>`;

  if (error) {
    return res.status(400).send(page("Gagal terhubung", `Google mengembalikan error: ${error}. Tutup tab ini dan coba lagi.`));
  }
  if (!code || !state) {
    return res.status(400).send(page("Gagal terhubung", "Tidak ada kode otorisasi dari Google. Tutup tab ini dan coba lagi."));
  }
  if (!req.sessionConfigured) {
    return res.status(503).send(page("Gagal terhubung", "SESSION_SECRET belum diset di server."));
  }
  try {
    await drive.handleCallback(req.sessionId, code, state);
    res.send(page("Google Drive terhubung", "Silakan tutup tab ini dan kembali ke aplikasi."));
  } catch (e) {
    res.status(500).send(page("Gagal terhubung", e.message));
  }
});

// POST /api/drive/disconnect
router.post("/disconnect", (req, res) => {
  if (!requireSession(req, res)) return;
  drive.disconnect(req.sessionId);
  res.json({ ok: true });
});

module.exports = router;

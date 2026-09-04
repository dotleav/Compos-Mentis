/**
 * Google Drive connect flow for Custom Case backups. See
 * server/lib/googleDrive.js for the scope/setup notes.
 */

const express = require("express");
const drive = require("../lib/googleDrive");

const router = express.Router();

// GET /api/drive/status
router.get("/status", (req, res) => {
  res.json(drive.getStatus());
});

// GET /api/drive/auth-url — frontend opens this in a new tab to start
// Google's consent screen.
router.get("/auth-url", (req, res) => {
  if (!drive.isConfigured()) {
    return res.status(400).json({
      error:
        "Google Drive belum dikonfigurasi di server (GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI kosong di .env).",
    });
  }
  res.json({ url: drive.getAuthUrl() });
});

// GET /api/drive/callback — Google redirects here after consent. This is a
// plain server-rendered page (not part of the SPA) since it opens in
// whatever tab/window the consent screen used.
router.get("/callback", async (req, res) => {
  const { code, error } = req.query;
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
  if (!code) {
    return res.status(400).send(page("Gagal terhubung", "Tidak ada kode otorisasi dari Google. Tutup tab ini dan coba lagi."));
  }
  try {
    await drive.handleCallback(code);
    res.send(page("Google Drive terhubung ✓", "Silakan tutup tab ini dan kembali ke aplikasi."));
  } catch (e) {
    res.status(500).send(page("Gagal terhubung", e.message));
  }
});

// POST /api/drive/folder  { folder: "<link atau ID>" }
router.post("/folder", async (req, res) => {
  try {
    const result = await drive.setFolder(req.body.folder);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/drive/disconnect
router.post("/disconnect", (req, res) => {
  drive.disconnect();
  res.json({ ok: true });
});

module.exports = router;

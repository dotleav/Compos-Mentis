/**
 * "Custom Case" — drag-and-drop a filled CASE_TEMPLATE.docx and have it
 * converted automatically. See server/lib/customCaseStore.js for how
 * uploads are isolated from the built-in question banks, and
 * server/lib/googleDrive.js for the optional per-user Drive backup.
 */

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const store = require("../lib/customCaseStore");
const drive = require("../lib/googleDrive");
const { isSafeSlug } = require("../lib/sanitize");

const router = express.Router();

const TEMPLATE_PATH = path.join(__dirname, "..", "..", "scripts", "CASE_TEMPLATE.docx");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB — a docx with a few embedded images fits comfortably
  fileFilter: (req, file, cb) => {
    const okExt = path.extname(file.originalname).toLowerCase() === ".docx";
    const okMime =
      file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (okExt || okMime) cb(null, true);
    else cb(new Error("File harus berformat .docx (Word)."));
  },
});

// GET /api/custom-cases/template — the blank CASE_TEMPLATE.docx, so
// "Download template kasus custom" in the UI has something to link to.
router.get("/template", (req, res) => {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    return res.status(404).json({ error: "Template belum tersedia di server." });
  }
  res.download(TEMPLATE_PATH, "CASE_TEMPLATE.docx");
});

// GET /api/custom-cases — list every upload (newest first), each with its
// case summaries. Client-safe by construction: the index only ever stores
// id/nama/judulKasus/level (see convertUpload in customCaseStore.js), never
// groundTruth.
router.get("/", (req, res) => {
  res.json(store.listUploads());
});

// POST /api/custom-cases/upload — multipart form, field name "docx".
router.post("/upload", (req, res) => {
  upload.single("docx")(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: "Tidak ada file yang diupload." });
    }

    let entry;
    try {
      entry = await store.convertUpload(req.file.buffer, req.file.originalname);
    } catch (e) {
      return res.status(422).json({ error: e.message });
    }

    // Best-effort Drive backup, into THIS BROWSER'S own connected Drive
    // (see server/lib/session.js) — a failure here should never lose the
    // (already-successful) local conversion, just get reported alongside
    // it. Backs up both the original docx AND every converted case JSON,
    // so the JSON that actually gets played from also lives in the user's
    // own Drive, not just this server.
    let driveSynced = false;
    let driveError = null;
    if (req.sessionConfigured && drive.isConnected(req.sessionId)) {
      try {
        const status = drive.getStatus(req.sessionId);
        if (status.folder) {
          const docxPath = store.getOriginalDocxPath(entry.uploadId);
          const driveFileId = await drive.uploadFile(
            req.sessionId,
            docxPath,
            req.file.originalname,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          );
          for (const c of entry.cases) {
            const jsonPath = store.getCaseJsonPath(c.id);
            if (!jsonPath) continue;
            await drive.uploadFile(req.sessionId, jsonPath, `${c.id}.json`, "application/json");
          }
          store.markDriveSynced(entry.uploadId, driveFileId);
          driveSynced = true;
        }
      } catch (e) {
        driveError = e.message;
      }
    }

    res.json({ ...entry, driveSynced, driveError });
  });
});

// DELETE /api/custom-cases/:uploadId
router.delete("/:uploadId", (req, res) => {
  const { uploadId } = req.params;
  if (!isSafeSlug(uploadId)) return res.status(400).json({ error: "Invalid uploadId" });
  const ok = store.deleteUpload(uploadId);
  if (!ok) return res.status(404).json({ error: "Upload not found" });
  res.json({ ok: true });
});

// GET /api/custom-cases/:uploadId/download — original docx, in case someone
// wants it back (e.g. to tweak and re-upload).
router.get("/:uploadId/download", (req, res) => {
  const { uploadId } = req.params;
  if (!isSafeSlug(uploadId)) return res.status(400).json({ error: "Invalid uploadId" });
  const entry = store.getUpload(uploadId);
  const docxPath = store.getOriginalDocxPath(uploadId);
  if (!entry || !docxPath) return res.status(404).json({ error: "Not found" });
  res.download(docxPath, entry.originalFilename || "case.docx");
});

module.exports = router;

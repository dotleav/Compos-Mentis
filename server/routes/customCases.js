/**
 * "Custom Case" — drag-and-drop a filled CASE_TEMPLATE.docx and have it
 * converted automatically. See server/lib/customCaseStore.js for how
 * uploads are isolated from the built-in question banks, and
 * server/lib/googleDrive.js for the optional Drive backup.
 */

const express = require("express");
const multer = require("multer");
const path = require("path");

const store = require("../lib/customCaseStore");
const drive = require("../lib/googleDrive");
const { isSafeSlug } = require("../lib/sanitize");

const router = express.Router();

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

    // Best-effort Drive backup — a failure here should never lose the
    // (already-successful) local conversion, just get reported alongside it.
    let driveSynced = false;
    let driveError = null;
    if (drive.isConnected()) {
      try {
        const status = drive.getStatus();
        if (status.folder) {
          const docxPath = store.getOriginalDocxPath(entry.uploadId);
          const driveFileId = await drive.uploadFile(
            docxPath,
            req.file.originalname,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          );
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

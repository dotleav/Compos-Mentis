/**
 * "Custom Case" storage: lets a user drag-and-drop a filled-in
 * CASE_TEMPLATE.docx and get it auto-converted into playable case(s),
 * without ever touching the git-tracked data/cases/<kategori>/ folders the
 * built-in question banks live in.
 *
 * How it stays isolated from the normal category system:
 *   - Every upload gets a short random `uploadId`.
 *   - The docx is converted by SPAWNING the exact same CLI everyone else
 *     uses (scripts/docx-to-case.js) into a throwaway category directory
 *     named `_custom_<uploadId>` — this reuses 100% of the existing
 *     parsing logic instead of forking/duplicating it, so the two never
 *     drift apart.
 *   - Whatever case(s) that produces are then moved into the single
 *     shared `data/cases/_custom/` folder, renamed to
 *     `<uploadId>__<originalCaseId>.json` so two different uploads can
 *     never collide even if both docx files used e.g. "kard_01" as an ID.
 *   - `_custom` (and the throwaway `_custom_<uploadId>` dirs, which never
 *     survive past one upload) are excluded from caseLoader.listCategories()
 *     (see server/lib/caseLoader.js), so none of this ever appears as a
 *     random-draw checkbox — it's only ever reachable by exact id, which is
 *     exactly how the frontend's Custom Case picker starts a session.
 *
 * Everything here is metadata + file moves; the actual docx parsing is 100%
 * delegated to scripts/docx-to-case.js so there is exactly one place that
 * understands the template format.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const CASES_DIR = path.join(ROOT, "data", "cases");
const IMAGES_DIR = path.join(ROOT, "data", "images");
const UPLOADS_DIR = path.join(ROOT, "data", "custom-uploads");
const INDEX_FILE = path.join(UPLOADS_DIR, "index.json");
const CUSTOM_KATEGORI = "_custom";

function ensureDirs() {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.mkdirSync(path.join(CASES_DIR, CUSTOM_KATEGORI), { recursive: true });
  fs.mkdirSync(path.join(IMAGES_DIR, CUSTOM_KATEGORI), { recursive: true });
}

function readIndex() {
  ensureDirs();
  if (!fs.existsSync(INDEX_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
  } catch {
    return []; // corrupt index shouldn't take the whole feature down
  }
}

function writeIndex(list) {
  ensureDirs();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(list, null, 2), "utf-8");
}

/** Newest upload first — matches how the frontend expand-list should read. */
function listUploads() {
  return readIndex().sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
}

function getUpload(uploadId) {
  return readIndex().find((u) => u.uploadId === uploadId) || null;
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

/** Run scripts/docx-to-case.js as a child process, same as the CLI usage
 * documented in scripts/CASE_TEMPLATE_GUIDE.md — captures stdout/stderr so
 * the converter's own ✔/⚠ lines can be shown to the uploader instead of
 * silently swallowed. */
function runConverter(docxPath, tempKategori) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, "scripts", "docx-to-case.js"), docxPath, "--kategori", tempKategori],
      { cwd: ROOT }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(err.trim() || out.trim() || `Converter exited with code ${code}`));
      } else {
        // The script mixes console.log (stdout) and console.warn (stderr)
        // for its "⚠ ..." lines rather inconsistently — merge both streams
        // so nothing gets missed when we filter for warnings below.
        resolve(out + "\n" + err);
      }
    });
    child.on("error", reject);
  });
}

/**
 * Convert an uploaded docx buffer into one-or-more custom cases.
 * @param {Buffer} fileBuffer
 * @param {string} originalFilename
 * @returns {Promise<object>} the new index entry (includes case summaries + warnings)
 */
async function convertUpload(fileBuffer, originalFilename) {
  ensureDirs();
  const uploadId = crypto.randomBytes(4).toString("hex"); // 8 hex chars
  const tempKategori = `_custom_${uploadId}`;
  const tempCasesDir = path.join(CASES_DIR, tempKategori);
  const tempImagesDir = path.join(IMAGES_DIR, tempKategori);

  // Keep the original docx permanently — lets the uploader re-download it
  // later, and is what gets pushed to Google Drive if that's connected
  // (see server/lib/googleDrive.js).
  const uploadDir = path.join(UPLOADS_DIR, uploadId);
  fs.mkdirSync(uploadDir, { recursive: true });
  const savedDocxPath = path.join(uploadDir, "original.docx");
  fs.writeFileSync(savedDocxPath, fileBuffer);

  let converterLog = "";
  const entry = {
    uploadId,
    originalFilename,
    uploadedAt: new Date().toISOString(),
    cases: [],
    warnings: [],
    driveFileId: null,
  };

  try {
    converterLog = await runConverter(savedDocxPath, tempKategori);
  } catch (e) {
    rmrf(tempCasesDir);
    rmrf(tempImagesDir);
    rmrf(uploadDir);
    throw new Error(`Konversi gagal: ${e.message}`);
  }

  entry.warnings = converterLog
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("⚠") && !l.includes("Always review each JSON file"));

  const jsonFiles = fs.existsSync(tempCasesDir)
    ? fs.readdirSync(tempCasesDir).filter((f) => f.endsWith(".json"))
    : [];

  if (jsonFiles.length === 0) {
    rmrf(tempCasesDir);
    rmrf(tempImagesDir);
    rmrf(uploadDir);
    throw new Error(
      "Konversi tidak menghasilkan kasus apapun — cek lagi apakah docx-nya pakai format tabel template (lihat scripts/CASE_TEMPLATE_GUIDE.md)."
    );
  }

  for (const fname of jsonFiles) {
    const origId = fname.replace(/\.json$/, "");
    const compositeId = `${uploadId}__${origId}`;
    const caseObj = JSON.parse(fs.readFileSync(path.join(tempCasesDir, fname), "utf-8"));
    caseObj.id = compositeId;
    caseObj.kategori = CUSTOM_KATEGORI;

    fs.writeFileSync(
      path.join(CASES_DIR, CUSTOM_KATEGORI, `${compositeId}.json`),
      JSON.stringify(caseObj, null, 2),
      "utf-8"
    );

    const srcImgDir = path.join(tempImagesDir, origId);
    if (fs.existsSync(srcImgDir)) {
      const dstImgDir = path.join(IMAGES_DIR, CUSTOM_KATEGORI, compositeId);
      fs.mkdirSync(dstImgDir, { recursive: true });
      for (const f of fs.readdirSync(srcImgDir)) {
        fs.renameSync(path.join(srcImgDir, f), path.join(dstImgDir, f));
      }
    }

    entry.cases.push({
      id: compositeId,
      nama: caseObj.nama || "",
      judulKasus: caseObj.judulKasus || "",
      level: caseObj.level || "",
    });
  }

  // temp dir cleanup — everything relevant has already been moved out
  rmrf(tempCasesDir);
  rmrf(tempImagesDir);

  const index = readIndex();
  index.push(entry);
  writeIndex(index);

  return entry;
}

/** Removes a custom upload entirely: its case JSON(s), any attached
 * images, the stored original docx, and its index entry. */
function deleteUpload(uploadId) {
  const entry = getUpload(uploadId);
  if (!entry) return false;

  for (const c of entry.cases) {
    rmrf(path.join(CASES_DIR, CUSTOM_KATEGORI, `${c.id}.json`));
    rmrf(path.join(IMAGES_DIR, CUSTOM_KATEGORI, c.id));
  }
  rmrf(path.join(UPLOADS_DIR, uploadId));

  writeIndex(readIndex().filter((u) => u.uploadId !== uploadId));
  return true;
}

function getOriginalDocxPath(uploadId) {
  const p = path.join(UPLOADS_DIR, uploadId, "original.docx");
  return fs.existsSync(p) ? p : null;
}

/** Records that an upload's original docx was pushed to the linked Google
 * Drive folder — called by server/routes/drive.js after a successful push,
 * purely so the frontend can show a "synced" checkmark next to it. */
function markDriveSynced(uploadId, driveFileId) {
  const index = readIndex();
  const entry = index.find((u) => u.uploadId === uploadId);
  if (!entry) return;
  entry.driveFileId = driveFileId;
  writeIndex(index);
}

module.exports = {
  CUSTOM_KATEGORI,
  UPLOADS_DIR,
  listUploads,
  getUpload,
  convertUpload,
  deleteUpload,
  getOriginalDocxPath,
  markDriveSynced,
};

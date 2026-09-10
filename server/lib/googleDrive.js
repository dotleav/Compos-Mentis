/**
 * Per-user Google Drive sync for Custom Case uploads.
 *
 * Each browser (see server/lib/session.js — no login system, so "user"
 * means "browser session" here) connects its OWN Google account. Once
 * connected, every Custom Case docx AND its converted JSON case(s) get
 * copied into a folder that lives inside THAT PERSON'S Drive — never a
 * folder you as the app owner can see, and never committed to this repo.
 *
 * SETUP (required before this does anything — see .env.example):
 *   1. Create a project at https://console.cloud.google.com, enable the
 *      "Google Drive API".
 *   2. Configure the "OAuth consent screen" (External user type is fine).
 *      You'll need a support email and a privacy policy URL. Add the
 *      `drive.file` scope under "Data access".
 *   3. Create an OAuth 2.0 Client ID (type "Web application"). Add
 *      GOOGLE_REDIRECT_URI (below) to its "Authorized redirect URIs".
 *   4. Put GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI
 *      AND SESSION_SECRET in .env. Nothing in this file works until all
 *      four are set — see isConfigured().
 *
 * SCOPE — why drive.file, not the older full "drive" scope:
 *   drive.file only grants access to files/folders THIS APP creates, never
 *   a user's whole Drive. That's a deliberate tradeoff: it means the old
 *   "paste a link to a folder you already own" flow doesn't work anymore
 *   (drive.file can't see pre-existing folders unless picked via Google's
 *   Picker widget) — but it means Google classifies this as a narrower,
 *   non-sensitive scope. The full "drive" scope is a RESTRICTED scope for
 *   apps serving the public: past a small number of test users, Google
 *   requires a paid third-party security assessment (CASA) before it'll
 *   let your OAuth consent screen out of "Testing" mode — and while stuck
 *   in Testing mode, refresh tokens for restricted/sensitive scopes expire
 *   after 7 DAYS, silently breaking everyone's connection weekly. For a
 *   student project meant for classmates to actually use, drive.file
 *   avoids that entirely: this app auto-creates its own folder inside each
 *   user's Drive (findOrCreateAppFolder below) instead of asking them to
 *   point at an existing one, so the narrower scope loses nothing this
 *   feature actually needs.
 *
 * Tokens + the per-user folder id are stored under
 * data/sessions/<sessionId>/ (gitignored) — see server/lib/session.js for
 * what identifies a "session" here.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { google } = require("googleapis");

const SESSIONS_DIR = path.join(__dirname, "..", "..", "data", "sessions");
const APP_FOLDER_NAME = "Compos Mentis - Kasus Custom";

const SCOPES = ["https://www.googleapis.com/auth/drive.file"];

// Short-lived, in-memory only (server restart = pending connects must be
// retried, which is fine — it's a single click). Maps a random CSRF state
// token -> the sessionId that requested it, so /callback can confirm the
// code it received really was requested by (and belongs to) that same
// browser, not replayed/forged from somewhere else.
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}

function getOAuth2Client() {
  if (!isConfigured()) return null;
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthUrl(sessionId) {
  const client = getOAuth2Client();
  if (!client) return null;
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.set(state, { sessionId, expires: Date.now() + STATE_TTL_MS });
  return client.generateAuthUrl({
    access_type: "offline", // needed to receive a refresh_token
    prompt: "consent", // force a fresh refresh_token every connect, not just on first-ever consent
    scope: SCOPES,
    state,
  });
}

function sessionDir(sessionId) {
  return path.join(SESSIONS_DIR, sessionId);
}
function tokenFile(sessionId) {
  return path.join(sessionDir(sessionId), "drive-token.json");
}
function configFile(sessionId) {
  return path.join(sessionDir(sessionId), "drive-config.json");
}

function loadTokens(sessionId) {
  const f = tokenFile(sessionId);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf-8"));
  } catch {
    return null;
  }
}

function saveTokens(sessionId, tokens) {
  fs.mkdirSync(sessionDir(sessionId), { recursive: true });
  fs.writeFileSync(tokenFile(sessionId), JSON.stringify(tokens, null, 2), "utf-8");
}

function isConnected(sessionId) {
  return isConfigured() && !!loadTokens(sessionId);
}

/** Exchanges a one-time OAuth `code` (from the redirect callback) for
 * access+refresh tokens, after confirming `state` matches a pending
 * request from THIS session (CSRF check) — and persists the tokens. */
async function handleCallback(sessionId, code, state) {
  const client = getOAuth2Client();
  if (!client) throw new Error("Google Drive belum dikonfigurasi (env var kosong).");

  const pending = pendingStates.get(state);
  pendingStates.delete(state); // one-time use regardless of outcome
  if (!pending || pending.expires < Date.now() || pending.sessionId !== sessionId) {
    throw new Error("Sesi koneksi tidak valid atau kedaluwarsa — coba hubungkan ulang.");
  }

  const { tokens } = await client.getToken(code);
  saveTokens(sessionId, tokens);

  // Zero-config: find (or create, on first connect) this user's own app
  // folder right away, so there's no separate "paste a folder" step.
  const folder = await findOrCreateAppFolder(sessionId);
  return { tokens, folder };
}

/** An OAuth2 client pre-loaded with this session's saved tokens, wired to
 * persist automatically whenever googleapis silently refreshes the access
 * token. */
function getAuthedClient(sessionId) {
  const client = getOAuth2Client();
  const tokens = loadTokens(sessionId);
  if (!client || !tokens) return null;
  client.setCredentials(tokens);
  client.on("tokens", (newTokens) => {
    saveTokens(sessionId, { ...tokens, ...newTokens }); // refresh_token isn't resent every time — keep the old one
  });
  return client;
}

function loadFolderConfig(sessionId) {
  const f = configFile(sessionId);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf-8"));
  } catch {
    return null;
  }
}

function saveFolderConfig(sessionId, cfg) {
  fs.mkdirSync(sessionDir(sessionId), { recursive: true });
  fs.writeFileSync(configFile(sessionId), JSON.stringify(cfg, null, 2), "utf-8");
}

/** Finds the app's own folder in this user's Drive (by name + the fact
 * that drive.file scope only ever shows us files we created), or creates
 * it if this is the first connect. Idempotent — safe to call again later. */
async function findOrCreateAppFolder(sessionId) {
  const client = getAuthedClient(sessionId);
  if (!client) throw new Error("Google Drive belum terhubung.");
  const drive = google.drive({ version: "v3", auth: client });

  const existing = await drive.files.list({
    q: `name = '${APP_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
    spaces: "drive",
  });
  let folder = existing.data.files?.[0];

  if (!folder) {
    const created = await drive.files.create({
      requestBody: { name: APP_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" },
      fields: "id, name",
    });
    folder = created.data;
  }

  saveFolderConfig(sessionId, { folderId: folder.id, folderName: folder.name });
  return { folderId: folder.id, folderName: folder.name };
}

function disconnect(sessionId) {
  fs.rmSync(tokenFile(sessionId), { force: true });
  fs.rmSync(configFile(sessionId), { force: true });
  // don't rmdir the whole session dir — api-keys.json (userKeys.js) may
  // still live there.
}

function getStatus(sessionId) {
  const folder = loadFolderConfig(sessionId);
  return {
    configured: isConfigured(),
    connected: isConnected(sessionId),
    folder: folder ? { id: folder.folderId, name: folder.folderName } : null,
  };
}

/** Uploads a local file into this session's app folder. Callers should
 * treat failures as non-fatal (the case still exists locally either way) —
 * see server/routes/customCases.js. */
async function uploadFile(sessionId, localPath, destName, mimeType) {
  const client = getAuthedClient(sessionId);
  const folder = loadFolderConfig(sessionId);
  if (!client) throw new Error("Google Drive belum terhubung.");
  if (!folder) throw new Error("Belum ada folder Drive yang dipilih.");

  const drive = google.drive({ version: "v3", auth: client });
  const { data } = await drive.files.create({
    requestBody: { name: destName, parents: [folder.folderId] },
    media: { mimeType, body: fs.createReadStream(localPath) },
    fields: "id",
  });
  return data.id;
}

/** Uploads an in-memory string (e.g. a converted case JSON) into this
 * session's app folder — same destination as uploadFile, just no temp file
 * needed on the caller's side. */
async function uploadContent(sessionId, content, destName, mimeType) {
  const client = getAuthedClient(sessionId);
  const folder = loadFolderConfig(sessionId);
  if (!client) throw new Error("Google Drive belum terhubung.");
  if (!folder) throw new Error("Belum ada folder Drive yang dipilih.");

  const drive = google.drive({ version: "v3", auth: client });
  const { Readable } = require("stream");
  const { data } = await drive.files.create({
    requestBody: { name: destName, parents: [folder.folderId] },
    media: { mimeType, body: Readable.from([content]) },
    fields: "id",
  });
  return data.id;
}

module.exports = {
  isConfigured,
  getAuthUrl,
  handleCallback,
  isConnected,
  getStatus,
  disconnect,
  uploadFile,
  uploadContent,
};

/**
 * Optional Google Drive sync for Custom Case uploads.
 *
 * Lets a user connect their own Google Drive account once, point it at a
 * folder they already own (pasting a normal Drive folder link/ID — no
 * Google Picker UI involved), and have every Custom Case docx they upload
 * get copied into that folder automatically as a backup.
 *
 * SETUP (required before this does anything — see .env.example):
 *   1. Create a project at https://console.cloud.google.com, enable the
 *      "Google Drive API".
 *   2. Create an OAuth 2.0 Client ID (type "Web application"). Add
 *      GOOGLE_REDIRECT_URI (below) to its "Authorized redirect URIs".
 *   3. Put GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI in
 *      .env. Nothing in this file works until all three are set — see
 *      isConfigured().
 *
 * Scope note: this deliberately requests the FULL "drive" scope, not the
 * narrower "drive.file" scope. drive.file only grants access to files the
 * app itself creates (or files a user hand-picks through Google's Picker
 * widget) — it can't see or write into a folder that already exists just
 * because the user pasted its link/ID here. Since "paste a link to your
 * own existing folder" is exactly the feature being asked for, and adding
 * the Picker widget is a separate chunk of work (its own API key, its own
 * script tag, its own UI), full "drive" scope is the pragmatic tradeoff —
 * flagged here so it's a conscious choice, not a silent one. Swap to
 * drive.file + the Picker widget later if a narrower scope matters more
 * than the current "just paste a link" simplicity.
 *
 * Tokens and the chosen folder are stored server-side in
 * data/custom-uploads/ (gitignored), NOT per-browser-session — this whole
 * app has no user-login system, so "connect Drive" is one connection
 * shared by everyone using this deployed instance, same as how Dev Mode's
 * password is a single shared unlock rather than per-user.
 */

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const UPLOADS_DIR = path.join(__dirname, "..", "..", "data", "custom-uploads");
const TOKEN_FILE = path.join(UPLOADS_DIR, ".drive-token.json");
const CONFIG_FILE = path.join(UPLOADS_DIR, ".drive-config.json");

const SCOPES = ["https://www.googleapis.com/auth/drive"];

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

function getAuthUrl() {
  const client = getOAuth2Client();
  if (!client) return null;
  return client.generateAuthUrl({
    access_type: "offline", // needed to receive a refresh_token
    prompt: "consent", // force a fresh refresh_token every connect, not just on first-ever consent
    scope: SCOPES,
  });
}

function loadTokens() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), "utf-8");
}

function isConnected() {
  return isConfigured() && !!loadTokens();
}

/** Exchanges a one-time OAuth `code` (from the redirect callback) for
 * access+refresh tokens and persists them. */
async function handleCallback(code) {
  const client = getOAuth2Client();
  if (!client) throw new Error("Google Drive belum dikonfigurasi (env var kosong).");
  const { tokens } = await client.getToken(code);
  saveTokens(tokens);
  return tokens;
}

/** An OAuth2 client pre-loaded with the saved tokens, wired to persist
 * automatically whenever googleapis silently refreshes the access token. */
function getAuthedClient() {
  const client = getOAuth2Client();
  const tokens = loadTokens();
  if (!client || !tokens) return null;
  client.setCredentials(tokens);
  client.on("tokens", (newTokens) => {
    saveTokens({ ...tokens, ...newTokens }); // refresh_token isn't resent every time — keep the old one
  });
  return client;
}

function loadFolderConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function saveFolderConfig(cfg) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
}

/** Pulls a Drive folder ID out of a pasted value that might be a bare ID or
 * a full "https://drive.google.com/drive/folders/<id>..." link. */
function extractFolderId(input) {
  const s = (input || "").trim();
  const m = s.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s; // looks like a bare ID already
  return null;
}

/** Verifies the connected account can actually see the given folder (and
 * that it IS a folder), then saves it as the sync target. */
async function setFolder(folderIdOrLink) {
  const client = getAuthedClient();
  if (!client) throw new Error("Google Drive belum terhubung.");
  const folderId = extractFolderId(folderIdOrLink);
  if (!folderId) throw new Error("Link/ID folder tidak dikenali.");

  const drive = google.drive({ version: "v3", auth: client });
  const { data } = await drive.files.get({
    fileId: folderId,
    fields: "id, name, mimeType",
    supportsAllDrives: true,
  });
  if (data.mimeType !== "application/vnd.google-apps.folder") {
    throw new Error("ID/link itu bukan folder Google Drive.");
  }
  saveFolderConfig({ folderId: data.id, folderName: data.name });
  return { folderId: data.id, folderName: data.name };
}

function disconnect() {
  if (fs.existsSync(TOKEN_FILE)) fs.rmSync(TOKEN_FILE, { force: true });
  if (fs.existsSync(CONFIG_FILE)) fs.rmSync(CONFIG_FILE, { force: true });
}

function getStatus() {
  const folder = loadFolderConfig();
  return {
    configured: isConfigured(),
    connected: isConnected(),
    folder: folder ? { id: folder.folderId, name: folder.folderName } : null,
  };
}

/** Uploads a local file into the connected+configured folder. Callers
 * should treat failures as non-fatal (the case still exists locally either
 * way) — see server/routes/customCases.js. */
async function uploadFile(localPath, destName, mimeType) {
  const client = getAuthedClient();
  const folder = loadFolderConfig();
  if (!client) throw new Error("Google Drive belum terhubung.");
  if (!folder) throw new Error("Belum ada folder Drive yang dipilih.");

  const drive = google.drive({ version: "v3", auth: client });
  const { data } = await drive.files.create({
    requestBody: { name: destName, parents: [folder.folderId] },
    media: { mimeType, body: fs.createReadStream(localPath) },
    fields: "id",
    supportsAllDrives: true,
  });
  return data.id;
}

module.exports = {
  isConfigured,
  getAuthUrl,
  handleCallback,
  isConnected,
  getStatus,
  setFolder,
  disconnect,
  uploadFile,
};

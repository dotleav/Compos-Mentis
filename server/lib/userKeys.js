/**
 * Per-browser-session storage for "bring your own API key" (Dev Mode ->
 * Settings -> API key sendiri). Lets someone run the app against THEIR OWN
 * provider quota instead of this server's .env keys, without ever needing
 * shell/file access to the deployment.
 *
 * Isolation: keyed by req.sessionId (server/lib/session.js) — one signed
 * cookie per browser, so two people using the same deployed instance never
 * see or overwrite each other's keys. This is "per-user" in the sense this
 * app can support (no login system) — see session.js for the honest
 * caveats on what that cookie does and doesn't protect against.
 *
 * Secrecy: every key is AES-256-GCM encrypted (server/lib/secretBox.js)
 * before it's written to disk, under data/sessions/<sessionId>/api-keys.json
 * (gitignored — see .gitignore). Decrypted keys exist only in memory for the
 * lifetime of a single chat()/exam() call and are NEVER sent back to the
 * client — getStatus() below only ever returns booleans + a last-4-chars
 * hint, never the key itself. Nothing here is ever console.logged.
 */

const fs = require("fs");
const path = require("path");
const secretBox = require("./secretBox");

const SESSIONS_DIR = path.join(__dirname, "..", "..", "data", "sessions");

// Which providers accept a user-supplied key, and which field(s) each one
// needs. Must stay in sync with the provider names in server/lib/providers.js.
// Local "ollama" is deliberately excluded — it needs no key at all.
const PROVIDER_FIELDS = {
  groq: ["apiKey"],
  cerebras: ["apiKey"],
  gemini: ["apiKey"],
  mistral: ["apiKey"],
  nvidia: ["apiKey"],
  deepseek: ["apiKey"],
  huggingface: ["apiKey"],
  cloudflare: ["accountId", "apiToken"],
  "ollama-cloud": ["apiKey"],
};

function isConfigured() {
  return secretBox.isConfigured();
}

function fileFor(sessionId) {
  return path.join(SESSIONS_DIR, sessionId, "api-keys.json");
}

function readRaw(sessionId) {
  const f = fileFor(sessionId);
  if (!fs.existsSync(f)) return {};
  try {
    return JSON.parse(fs.readFileSync(f, "utf-8"));
  } catch {
    return {}; // corrupt file shouldn't take the feature down
  }
}

function writeRaw(sessionId, obj) {
  const dir = path.dirname(fileFor(sessionId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fileFor(sessionId), JSON.stringify(obj, null, 2), "utf-8");
}

/** Client-safe summary: which providers have a saved key, plus just enough
 * of a hint (last 4 chars of the FIRST field) to recognize "yep that's the
 * key I meant" — never enough to reconstruct or reuse it. */
function getStatus(sessionId) {
  const raw = readRaw(sessionId);
  const providers = {};
  for (const name of Object.keys(PROVIDER_FIELDS)) {
    const entry = raw[name];
    if (entry) {
      const firstField = PROVIDER_FIELDS[name][0];
      let hint = null;
      try {
        const val = secretBox.decrypt(entry[firstField]);
        hint = val.length > 4 ? `••••${val.slice(-4)}` : "••••";
      } catch {
        hint = null; // e.g. KEY_ENCRYPTION_SECRET rotated since this was saved
      }
      providers[name] = { saved: true, hint };
    } else {
      providers[name] = { saved: false, hint: null };
    }
  }
  return { configured: isConfigured(), providers };
}

/** Saves one provider's key(s), encrypted field-by-field. `values` is a
 * plain object matching PROVIDER_FIELDS[provider], e.g. { apiKey: "sk-..." }
 * or, for cloudflare, { accountId: "...", apiToken: "..." }. */
function setKey(sessionId, provider, values) {
  if (!isConfigured()) {
    throw new Error(
      "KEY_ENCRYPTION_SECRET belum diset di server — fitur API key sendiri belum bisa dipakai. Lihat .env.example."
    );
  }
  const fields = PROVIDER_FIELDS[provider];
  if (!fields) throw new Error(`Provider "${provider}" tidak dikenal.`);

  const encrypted = {};
  for (const field of fields) {
    const v = (values && values[field] ? String(values[field]) : "").trim();
    if (!v) throw new Error(`Field "${field}" untuk ${provider} tidak boleh kosong.`);
    encrypted[field] = secretBox.encrypt(v);
  }

  const raw = readRaw(sessionId);
  raw[provider] = encrypted;
  writeRaw(sessionId, raw);
}

function removeKey(sessionId, provider) {
  const raw = readRaw(sessionId);
  if (!raw[provider]) return false;
  delete raw[provider];
  writeRaw(sessionId, raw);
  return true;
}

/** Decrypts every saved key for this session into the shape
 * server/lib/providers.js's chat({ userKeys }) expects:
 *   { groq: { apiKey: "..." }, cloudflare: { accountId, apiToken }, ... }
 * Used internally per-request only — never returned to the client. */
function getDecrypted(sessionId) {
  if (!isConfigured()) return {};
  const raw = readRaw(sessionId);
  const out = {};
  for (const [provider, encrypted] of Object.entries(raw)) {
    const fields = PROVIDER_FIELDS[provider];
    if (!fields) continue;
    try {
      const values = {};
      for (const field of fields) values[field] = secretBox.decrypt(encrypted[field]);
      out[provider] = values;
    } catch {
      // KEY_ENCRYPTION_SECRET rotated, or the file was tampered with —
      // skip this provider's override rather than crash the request; the
      // env-based fallback in providers.js still applies.
    }
  }
  return out;
}

module.exports = {
  PROVIDER_FIELDS,
  isConfigured,
  getStatus,
  setKey,
  removeKey,
  getDecrypted,
};

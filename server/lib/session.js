/**
 * Anonymous per-browser session — NOT a login system.
 *
 * This app has no accounts (no email/password, no user database). "Per-user"
 * here means "per-browser": the first request a browser makes gets a random
 * session id, handed back as a signed httpOnly cookie, and every later
 * request from that same browser carries it back. That id is then used as
 * the isolation key for anything that must not leak between two people
 * using the same deployed instance at the same time:
 *   - custom API keys (server/lib/userKeys.js)
 *   - a connected Google Drive account + folder (server/lib/googleDrive.js)
 *
 * "Signed" means tampering is detectable (nobody can hand-craft a cookie
 * claiming to be someone else's session id without knowing SESSION_SECRET),
 * NOT that this is equivalent to real authentication — there's still no
 * password, so anyone who steals the cookie itself (e.g. via an XSS bug)
 * has that session. httpOnly keeps ordinary JS (and therefore most XSS
 * payloads) from reading the cookie at all, which is the main mitigation
 * available without building real accounts.
 *
 * Deliberately dependency-free (no cookie-parser) — this app already leans
 * minimal (see providers.js's own comments), and parsing one cookie by hand
 * is a few lines.
 */

const crypto = require("crypto");

const COOKIE_NAME = "cm_sid";
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 365; // 1 year — reconnecting Drive/keys every session would defeat the point

function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s) {
    throw new Error(
      "SESSION_SECRET belum diset di .env — wajib untuk fitur API key & Google Drive per-pengguna. Isi dengan string acak panjang (mis. hasil `openssl rand -hex 32`)."
    );
  }
  return s;
}

function sign(value) {
  const mac = crypto.createHmac("sha256", getSecret()).update(value).digest("base64url");
  return `${value}.${mac}`;
}

function verify(signed) {
  if (!signed || typeof signed !== "string") return null;
  const i = signed.lastIndexOf(".");
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const mac = signed.slice(i + 1);
  const expected = crypto.createHmac("sha256", getSecret()).update(value).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** Express middleware: guarantees req.sessionId is set on every request,
 * issuing + signing a fresh one (and setting the cookie on the response) the
 * first time a browser shows up without one. */
function sessionMiddleware(req, res, next) {
  let configured = true;
  let sessionId = null;

  try {
    const cookies = parseCookies(req.headers.cookie);
    sessionId = verify(cookies[COOKIE_NAME]);
  } catch (e) {
    configured = false; // SESSION_SECRET missing — see getSecret()
  }

  if (configured && !sessionId) {
    sessionId = crypto.randomBytes(16).toString("hex");
    try {
      const signed = sign(sessionId);
      const isProd = process.env.NODE_ENV === "production";
      res.setHeader(
        "Set-Cookie",
        `${COOKIE_NAME}=${encodeURIComponent(signed)}; Path=/; Max-Age=${Math.floor(MAX_AGE_MS / 1000)}; HttpOnly; SameSite=Lax${isProd ? "; Secure" : ""}`
      );
    } catch (e) {
      configured = false;
    }
  }

  req.sessionId = configured ? sessionId : null;
  req.sessionConfigured = configured;
  next();
}

module.exports = { sessionMiddleware, COOKIE_NAME };

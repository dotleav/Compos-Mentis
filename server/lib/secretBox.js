/**
 * Encrypts small secrets (user-supplied API keys) before they ever touch
 * disk. See server/lib/userKeys.js for what uses this.
 *
 * AES-256-GCM: a fresh random 12-byte IV per encryption call (GCM requires
 * this — reusing an IV with the same key breaks its security guarantees
 * entirely, so it's regenerated every call, never cached/reused), plus the
 * GCM auth tag, so tampering with the ciphertext on disk is detectable, not
 * just invisible. The key itself is derived from KEY_ENCRYPTION_SECRET via
 * scrypt (a KDF meant for this — it's deliberately slow/memory-hard,
 * unlike a plain hash, which matters if that env var is ever a short
 * human-chosen passphrase rather than truly random bytes).
 */

const crypto = require("crypto");

function isConfigured() {
  return !!process.env.KEY_ENCRYPTION_SECRET;
}

function deriveKey(salt) {
  const secret = process.env.KEY_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error(
      "KEY_ENCRYPTION_SECRET belum diset di .env — wajib supaya API key pengguna bisa dienkripsi sebelum disimpan. Isi dengan string acak panjang (mis. hasil `openssl rand -hex 32`)."
    );
  }
  return crypto.scryptSync(secret, salt, 32);
}

/** Returns a single opaque base64 string bundling salt+iv+tag+ciphertext —
 * safe to write straight to a JSON file. */
function encrypt(plaintext) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, ciphertext]).toString("base64");
}

function decrypt(blob) {
  const buf = Buffer.from(blob, "base64");
  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const tag = buf.subarray(28, 44);
  const ciphertext = buf.subarray(44);
  const key = deriveKey(salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
}

module.exports = { isConfigured, encrypt, decrypt };

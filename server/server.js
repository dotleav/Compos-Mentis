require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");

const casesRouter = require("./routes/cases");
const chatRouter = require("./routes/chat");
const chatStreamRouter = require("./routes/chatStream");
const examRouter = require("./routes/exam");
const customCasesRouter = require("./routes/customCases");
const driveRouter = require("./routes/drive");
const keysRouter = require("./routes/keys");
const { sessionMiddleware } = require("./lib/session");
const { PROVIDERS, getCooldownStatus } = require("./lib/providers");

// ── STARTUP ENV VALIDATION ───────────────────────────────────────────────────
// Fail loudly at boot, not mid-session when a student is three steps into
// a case. SESSION_SECRET is required for user API keys + Google Drive.
// (Providers are optional — absence is handled gracefully by providers.js.)
(function validateEnv() {
  const warnings = [];
  if (!process.env.SESSION_SECRET) {
    warnings.push(
      "SESSION_SECRET not set — user API keys and Google Drive will be disabled. " +
      "Generate one with: openssl rand -hex 32"
    );
  }
  const hasAnyProvider = PROVIDERS.some((p) => p.alwaysAvailable || p.apiKey);
  if (!hasAnyProvider) {
    warnings.push(
      "No AI provider API keys found. Set at least one of: " +
      "GROQ_API_KEY, CEREBRAS_API_KEY, GEMINI_API_KEY, MISTRAL_API_KEY, NVIDIA_API_KEY, " +
      "DEEPSEEK_API_KEY, HF_API_KEY, OLLAMA_CLOUD_API_KEY. " +
      "Or install Ollama locally (it requires no key)."
    );
  }
  for (const w of warnings) console.warn(`[startup] WARNING: ${w}`);
})();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));
// Anonymous per-browser session (signed cookie, no login system) — powers
// "bring your own API key" and per-user Google Drive. See lib/session.js.
app.use(sessionMiddleware);

// Static frontend
app.use(express.static(path.join(__dirname, "..", "public")));

// Static case images (ECG, rontgen, etc.)
app.use("/data/images", express.static(path.join(__dirname, "..", "data", "images")));

// API routes
app.use("/api/cases", casesRouter);
app.use("/api/chat", chatRouter);
app.use("/api/chat", chatStreamRouter); // streaming SSE variant
app.use("/api/exam", examRouter);
app.use("/api/custom-cases", customCasesRouter);
app.use("/api/drive", driveRouter);
app.use("/api/keys", keysRouter);

app.get("/api/health", (req, res) => res.json({ ok: true }));

// Provider health: lists which providers have keys configured and whether
// any are currently cooling down after a rate-limit. Useful for ops + dev.
app.get("/api/health/providers", (req, res) => {
  const cooldowns = getCooldownStatus();
  const providers = PROVIDERS.map((p) => ({
    name: p.name,
    configured: !!(p.alwaysAvailable || p.apiKey),
    alwaysAvailable: !!p.alwaysAvailable,
    coolingDown: !!cooldowns[p.name],
    ...(cooldowns[p.name] || {}),
  }));
  res.json({ providers, timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`OSCE AI simulator running on http://localhost:${PORT}`);
});

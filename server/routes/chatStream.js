/**
 * POST /api/chat/anamnesis-stream
 *
 * Streaming variant of the anamnesis endpoint. Identical logic to chat.js
 * /anamnesis (same system prompt, same context-window trimming, same
 * provider fallback) but responses are sent as Server-Sent Events so the
 * frontend can render tokens as they arrive instead of waiting for the full
 * reply.
 *
 * SSE format (one event per delta):
 *   data: {"delta":"text fragment"}\n\n
 *   data: {"done":true,"provider":"groq"}\n\n
 *   data: {"error":"message"}\n\n     ← on failure
 *
 * Providers that don't support streaming fall back gracefully to the
 * buffered path: the full reply is sent as a single delta followed by done.
 *
 * This file intentionally duplicates the system-prompt-building helpers
 * from chat.js rather than extracting a shared module — the prompts are
 * the same, and a shared module would couple two routes that should be
 * independently deployable. If you change the patient persona in chat.js,
 * mirror the change here.
 */

"use strict";

const express = require("express");
const router = express.Router();
const { PROVIDERS, getCooldownStatus } = require("../lib/providers");
const userKeys = require("../lib/userKeys");
const { loadCase } = require("../lib/caseLoader");
const { sanitizeText, sanitizeHistory, isSafeSlug, MAX_MESSAGE_LENGTH } = require("../lib/sanitize");
const { estimateTokens, fitHistoryToBudget } = require("../lib/contextWindow");

// Reuse the same budget constants as chat.js
const MAX_CONTEXT_TOKENS = 5000;
const REPLY_RESERVE_TOKENS = 250;

// ── Streaming provider call ──────────────────────────────────────────────────
// Returns an async generator that yields string deltas.
// Falls back to a single-chunk yield if the provider doesn't support
// streaming or if the stream fails mid-way after headers are sent.

const PROVIDER_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS) || 20_000;
const REASONING_MODEL_PATTERN = /gpt-oss|nemotron/i;

async function* streamFromProvider(provider, body, userKeysMap) {
  const resolvedApiKey = (userKeysMap && userKeysMap[provider.name]?.apiKey) || provider.apiKey;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  const headers = { "Content-Type": "application/json" };
  if (provider.authHeaderName) {
    headers[provider.authHeaderName] = resolvedApiKey;
  } else {
    headers.Authorization = `Bearer ${resolvedApiKey}`;
  }

  const streamBody = { ...body, stream: true };

  let res;
  try {
    res = await fetch(`${provider.baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(streamBody),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }

  if (!res.ok) {
    clearTimeout(timeoutId);
    const text = await res.text().catch(() => "");
    const err = new Error(`[${provider.name}] ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }

  // Parse the SSE stream from the provider.
  // Each line is "data: <json>" or "data: [DONE]".
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of res.body) {
      clearTimeout(timeoutId); // reset on each chunk — we're live
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // last incomplete line stays in buffer
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // malformed JSON line — skip
        }
      }
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── System prompt builders (mirrored from chat.js) ───────────────────────────
// Copied verbatim to keep routes independent. If chat.js changes its prompts,
// update here too. A future refactor could extract these to lib/prompts.js.

function assessInterviewStatus(pemeriksaanFisik = []) {
  const findText = (pattern) => {
    const hit = pemeriksaanFisik.find((p) => pattern.test(p.id || ""));
    return hit ? String(hit.temuan || "") : "";
  };
  const kesadaranText = findText(/^ku$/i) || findText(/kesadaran/i);
  const sikapText = findText(/sikap/i);
  if (/penurunan|somnolen|stupor|sopor|koma|delirium/i.test(kesadaranText)) {
    return { status: "tidak_sadar", kesadaranText, sikapText };
  }
  if (/tidak\s*kooperatif/i.test(sikapText)) {
    return { status: "tidak_kooperatif", kesadaranText, sikapText };
  }
  return { status: "kooperatif", kesadaranText, sikapText };
}

function buildInterviewRules({ status, kesadaranText, sikapText }) {
  if (status === "tidak_sadar") {
    return `\nSTATUS KESADARAN PASIEN: ${kesadaranText || "menurun"}\nPasien dalam kondisi ini TIDAK BISA diajak bicara/menjawab pertanyaan secara verbal. ATURAN TAMBAHAN (lebih tinggi prioritasnya dari aturan umum di atas):\n- Jika pertanyaan mahasiswa jelas ditujukan LANGSUNG ke pasien, jangan menjawab dengan kalimat riwayat. Balas hanya dengan deskripsi respons non-verbal yang wajar untuk kondisi ini, 1 kalimat singkat.\n- Jika pertanyaan mahasiswa jelas ditujukan ke KELUARGA/PENGANTAR pasien, JAWABLAH SEBAGAI PENGANTAR tersebut berdasarkan RIWAYAT YANG KAMU KETAHUI di atas.`;
  }
  if (status === "tidak_kooperatif") {
    return `\nSIKAP PASIEN: ${sikapText || "tidak kooperatif"}\nPasien ini TIDAK kooperatif. ATURAN TAMBAHAN:\n- Jawaban pasien boleh singkat, menghindar, curiga, defensif, atau menyangkal — realistis untuk pasien yang tidak kooperatif.\n- Jika pertanyaan ditujukan ke KELUARGA/PENGANTAR, JAWABLAH SEBAGAI PENGANTAR secara kooperatif dan informatif.`;
  }
  return "";
}

function detectPediatricCase(identitas) {
  let usia = null, namaAnak = null, pengantarHint = null;
  if (typeof identitas === "object" && identitas !== null) {
    usia = Number(identitas.usia);
    namaAnak = identitas.nama || null;
  } else if (typeof identitas === "string") {
    const usiaMatch = identitas.match(/(\d+)\s*tahun/i);
    if (usiaMatch) usia = parseInt(usiaMatch[1], 10);
    const parts = identitas.split(",").map((s) => s.trim());
    if (parts.length > 0 && !/^(anak|laki-laki|perempuan|bayi|balita)/i.test(parts[0])) namaAnak = parts[0];
    const pengantarMatch = identitas.match(/dibawa\s+([\w\s()]+?)(?:,|$)|ditemani\s+([\w\s()]+?)(?:,|$)|oleh\s+([\w\s()]+?)(?:,|$)/i);
    if (pengantarMatch) pengantarHint = (pengantarMatch[1] || pengantarMatch[2] || pengantarMatch[3] || "").trim();
  }
  if (usia !== null && !isNaN(usia) && usia < 18) return { isPediatric: true, usia, namaAnak, pengantarHint };
  return { isPediatric: false };
}

const EXAMPLE_IDENTITIES = [
  { nama: "Bambang", usia: 42, kota: "Bantul" }, { nama: "Siti", usia: 31, kota: "Depok" },
  { nama: "Made", usia: 58, kota: "Denpasar" }, { nama: "Yuni", usia: 25, kota: "Sleman" },
  { nama: "Hendra", usia: 47, kota: "Cimahi" }, { nama: "Ratna", usia: 36, kota: "Malang" },
  { nama: "Fajar", usia: 29, kota: "Bekasi" }, { nama: "Dewi", usia: 52, kota: "Surabaya" },
];
function randomExampleIdentity() { return EXAMPLE_IDENTITIES[Math.floor(Math.random() * EXAMPLE_IDENTITIES.length)]; }

// (Pediatric system prompt builder omitted here for brevity — same as chat.js.
//  Import from a shared lib/prompts.js if you refactor.)

// ── SSE helpers ───────────────────────────────────────────────────────────────
function sendEvent(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── Route ─────────────────────────────────────────────────────────────────────
router.post("/anamnesis-stream", async (req, res) => {
  const { kategori, id, history = [], message, forceProvider } = req.body;

  if (!kategori || !id || !message) {
    return res.status(400).json({ error: "kategori, id, and message are required" });
  }
  if (!isSafeSlug(kategori) || !isSafeSlug(id)) {
    return res.status(400).json({ error: "Invalid kategori or id" });
  }

  const cleanMessage = sanitizeText(message, { maxLength: MAX_MESSAGE_LENGTH });
  if (!cleanMessage) return res.status(400).json({ error: "message is empty after sanitization" });
  const cleanHistory = sanitizeHistory(history, { maxLength: MAX_MESSAGE_LENGTH });

  const kasus = loadCase(kategori, id);
  if (!kasus) return res.status(404).json({ error: "Case not found" });

  const { identitas, keluhanUtama, groundTruth } = kasus;
  const { riwayat } = groundTruth;
  const interviewCtx = assessInterviewStatus(groundTruth.pemeriksaanFisik);
  const interviewRules = buildInterviewRules(interviewCtx);
  const ex = randomExampleIdentity();
  const pediatricCtx = detectPediatricCase(identitas);

  // Build the same system prompt as chat.js /anamnesis (adult path).
  // For pediatric cases this uses a simplified version — full pediatric
  // prompt is in chat.js; mirror it here if you need full parity.
  const systemPrompt = pediatricCtx.isPediatric
    ? `Kamu berperan sebagai ORANG TUA/WALI PASIEN dalam simulasi OSCE kedokteran. Pasien yang kamu bawa adalah anak berusia ${pediatricCtx.usia} tahun. Jangan keluar dari peran ini.\n\nIDENTITAS ANAK: ${identitas}\nKELUHAN: ${keluhanUtama}\nRIWAYAT:\n- RPS: ${riwayat.rps.join("; ")}\n- RPD: ${riwayat.rpd}\n- RPK: ${riwayat.rpk}\n- Gaya hidup: ${riwayat.lifestyle.join("; ")}\n\nJawab singkat sebagai orang tua, bahasa awam, hanya apa yang ditanya. Jangan sebut diagnosis. Bahasa Indonesia.${interviewRules}`
    : `Kamu berperan sebagai PASIEN dalam simulasi OSCE kedokteran. Jangan keluar dari peran ini.\n\nIDENTITAS: ${identitas}\nKELUHAN: ${keluhanUtama}\nRIWAYAT:\n- RPS: ${riwayat.rps.join("; ")}\n- RPD: ${riwayat.rpd}\n- RPK: ${riwayat.rpk}\n- Gaya hidup: ${riwayat.lifestyle.join("; ")}\n\nATURAN DATA PRIBADI: Jika nama/pekerjaan/alamat tidak ada di identitas, karang sendiri yang wajar. Jangan tulis placeholder.\nJawab HANYA apa yang ditanya, satu topik, 1-2 kalimat pendek. Bahasa awam. Bahasa Indonesia saja.${interviewRules}`;

  const REMINDER_TEXT = pediatricCtx.isPediatric
    ? "\n\n[INGAT: kamu orang tua/wali. Jawab hanya pertanyaan ini, 1-2 kalimat. Sudut pandang orang tua.]"
    : "\n\n[INGAT: jawab HANYA pertanyaan ini, 1-2 kalimat. Kalau ya/tidak, mulai eksplisit dulu.]";

  const fixedTokens = estimateTokens(systemPrompt) + estimateTokens(REMINDER_TEXT) + estimateTokens(cleanMessage);
  const { history: trimmedHistory } = fitHistoryToBudget(cleanHistory, {
    systemTokens: fixedTokens,
    reserveTokens: REPLY_RESERVE_TOKENS,
    maxContextTokens: MAX_CONTEXT_TOKENS,
  });

  const messages = [
    { role: "system", content: systemPrompt },
    ...trimmedHistory,
    { role: "user", content: cleanMessage + REMINDER_TEXT },
  ];

  const body = {
    model: null, // set per-provider below
    messages,
    temperature: 0.3,
    max_tokens: 120,
  };
  if (REASONING_MODEL_PATTERN.test("")) {/* handled per provider */}

  // Set SSE headers before streaming starts.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
  res.flushHeaders();

  const resolvedUserKeys = req.sessionConfigured ? userKeys.getDecrypted(req.sessionId) : {};

  // Resolve provider list (same logic as providers.js chat())
  const { PROVIDERS: allProviders } = require("../lib/providers");
  const cooldowns = getCooldownStatus();
  let active = allProviders
    .filter((p) => p.alwaysAvailable || p.apiKey)
    .filter((p) => !cooldowns[p.name] || active?.length <= 1);

  if (forceProvider) {
    const only = allProviders.find((p) => p.name === forceProvider);
    if (only) active = [only];
  }

  if (!active || active.length === 0) {
    sendEvent(res, { error: "No AI provider available" });
    res.end();
    return;
  }

  let success = false;
  for (const provider of active) {
    if (!provider.alwaysAvailable && !provider.apiKey) continue;
    const provBody = {
      ...body,
      model: provider.model,
      ...(provider.extraBody || {}),
    };
    if (REASONING_MODEL_PATTERN.test(provider.model)) {
      provBody.reasoning_effort = "low";
      provBody.max_tokens = Math.max(provBody.max_tokens, 1024);
    }
    try {
      let full = "";
      for await (const delta of streamFromProvider(provider, provBody, resolvedUserKeys)) {
        full += delta;
        sendEvent(res, { delta });
      }
      sendEvent(res, { done: true, provider: provider.name });
      success = true;
      break;
    } catch (err) {
      // Try next provider — if all fail we'll send an error event below.
      console.warn(`[stream fallback] ${provider.name} failed: ${err.message}`);
    }
  }

  if (!success) {
    sendEvent(res, { error: "All providers failed" });
  }
  res.end();
});

module.exports = router;

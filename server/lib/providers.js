// Multi-provider AI client with automatic fallback.
//
// Tries providers in order (fastest/most generous free tier first). If one
// is rate-limited, out of credits, or errors out, it automatically moves to
// the next — no manual switching needed. Ollama (local, no key, no limit)
// is always included as the final fallback so a roleplay never truly gets
// stuck, even with zero internet.
//
// Fill in whichever API keys you actually have in .env — providers without
// a key are skipped automatically. You don't need all of them; even just
// Ollama alone works fine.
//
// All of these expose an OpenAI-compatible endpoint, so one generic caller
// works for all eight:
//   - Groq:         https://console.groq.com/keys
//   - Cerebras:     https://cloud.cerebras.ai  (free tier, very fast inference)
//   - Gemini:       https://aistudio.google.com/apikey (free tier via OpenAI-compat endpoint)
//   - OpenRouter:   https://openrouter.ai/keys (routes to many models, some free)
//   - NVIDIA:       https://build.nvidia.com  (an API catalog key, free tier)
//   - DeepSeek:     https://platform.deepseek.com/api_keys (cheap pay-as-you-go, 5M free tokens on signup)
//   - Hugging Face: https://huggingface.co/settings/tokens (router in front of many hosted models, free monthly credits)
//   - Cloudflare:   https://dash.cloudflare.com/profile/api-tokens (Workers AI, 10K neurons/day free, resets daily)
//   - Ollama:       runs locally, no key needed

const PROVIDERS = [
  {
    name: "groq",
    baseURL: "https://api.groq.com/openai/v1",
    apiKey: process.env.GROQ_API_KEY,
    // "llama-3.1-8b-instant" was deprecated by Groq and hard-shut-down on
    // 2026-08-16 — every request to it now fails outright with
    // model_decommissioned. openai/gpt-oss-20b is Groq's own recommended
    // replacement. (This IS a reasoning model — see the reasoning-model
    // handling in callProvider() below, which raises max_tokens and sets
    // reasoning_effort so it doesn't get cut off mid-thought.)
    model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
  },
  {
    name: "cerebras",
    baseURL: "https://api.cerebras.ai/v1",
    apiKey: process.env.CEREBRAS_API_KEY,
    // "llama3.1-8b" was deprecated by Cerebras on 2026-05-27. Cerebras'
    // own recommended replacement across ALL their recent deprecations is
    // gpt-oss-120b — same reasoning-model caveat as Groq above applies.
    model: process.env.CEREBRAS_MODEL || "gpt-oss-120b",
  },
  {
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    // CORRECTED (was: "meta-llama/llama-3.1-8b-instruct:free" — now a paid
    // model, hence the 404 "unavailable for free" error). Individual
    // ":free" slugs rotate/get pulled with no notice (OpenRouter's own
    // free roster changes weekly), so pinning one is fragile by design.
    // "openrouter/free" is OpenRouter's own auto-router (launched Feb
    // 2026): it always resolves to whichever free model currently
    // supports the request (including tool calls, which exam.js needs),
    // so this provider entry doesn't need hand-updating every time the
    // free lineup shuffles. Override via OPENROUTER_MODEL if you want to
    // pin a specific model instead.
    model: process.env.OPENROUTER_MODEL || "openrouter/free",
  },
  {
    name: "nvidia",
    baseURL: "https://integrate.api.nvidia.com/v1",
    apiKey: process.env.NVIDIA_API_KEY,
    // NVIDIA retired "nvidia/llama-3.1-nemotron-70b-instruct" — it now 404s
    // with "Function ... Not found for account" for every caller, confirmed
    // by NVIDIA staff on their dev forum (they no longer host that model).
    // Nemotron Nano 9B v2 is the current lightweight replacement on the
    // catalog. Double-check build.nvidia.com if this ever 404s again —
    // catalog model names do change over time.
    model: process.env.NVIDIA_MODEL || "nvidia/nvidia-nemotron-nano-9b-v2",
  },
  {
    name: "deepseek",
    baseURL: "https://api.deepseek.com/v1",
    apiKey: process.env.DEEPSEEK_API_KEY,
    // V4-Flash: fast + cheap, more than enough for patient role-play and
    // tool-call finding matching. Use deepseek-v4-pro only if you need
    // heavier reasoning — not needed for this app's use case.
    model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
  },
  {
    name: "gemini",
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
    // Uses native Gemini endpoint (not OpenAI-compat) with key as query
    // param -- handled by callGemini() below instead of callProvider().
    useNativeGemini: true,
  },
  {
    name: "huggingface",
    baseURL: "https://router.huggingface.co/v1",
    apiKey: process.env.HF_API_KEY,
    // Hugging Face's Inference Providers router — one OpenAI-compatible
    // endpoint in front of many hosted models/providers (Groq, Cerebras,
    // DeepInfra, Fireworks, etc). Free monthly inference credits on every
    // account. gpt-oss-120b has solid tool-calling, which exam.js relies on
    // for the select_findings tool call. You can pin a specific backing
    // provider by suffixing the model id, e.g. "openai/gpt-oss-120b:groq" —
    // left as "auto" (no suffix) here to let HF pick the fastest one.
    model: process.env.HF_MODEL || "openai/gpt-oss-120b",
  },
  {
    name: "cloudflare",
    // Unlike the other providers, Cloudflare's URL has the account ID baked
    // into the path itself — so BOTH CLOUDFLARE_ACCOUNT_ID and
    // CLOUDFLARE_API_TOKEN are required for this one to actually work. If
    // either is missing, the request below will just fail and fall
    // through to the next provider (same as an invalid/expired key would).
    baseURL: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
    apiKey: process.env.CLOUDFLARE_API_TOKEN,
    // Free tier resets DAILY (10,000 neurons/day) instead of a one-time
    // token grant — good as a standing daily fallback.
    //
    // NOT using gpt-oss-120b here (despite it also being free on this
    // platform): Cloudflare's OWN docs for this exact /v1/chat/completions
    // endpoint show gpt-oss models called through the newer Responses API
    // (openai.responses.create) instead of Chat Completions — and
    // community reports (LibreChat docs) confirm gpt-oss models "may not
    // work" through /v1/chat/completions specifically. llama-3.1-8b-instruct
    // is Cloudflare's own official example model FOR this exact endpoint,
    // and has native tool-calling support (needed for exam.js's
    // select_findings tool call) — a safer default than fighting an
    // undocumented spec mismatch.
    model: process.env.CLOUDFLARE_MODEL || "@cf/meta/llama-3.1-8b-instruct",
  },
  {
    name: "ollama",
    baseURL: `${(process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, "")}/v1`,
    apiKey: "ollama", // required field in the request shape, but Ollama itself ignores it
    model: process.env.OLLAMA_MODEL || "qwen2.5:3b",
    alwaysAvailable: true, // never skipped even without a "real" key — the guaranteed fallback
    // Ollama's own default context window is only 2048-4096 tokens — far
    // smaller than what most models it serves actually support — and when
    // a request exceeds it, Ollama silently drops the OLDEST messages
    // instead of erroring. That's a common cause of a local model suddenly
    // "forgetting" who's speaking and echoing the last thing it saw. The
    // OpenAI-compatible endpoint accepts num_ctx as either a top-level
    // field or nested under "options" depending on Ollama version, so we
    // send both for compatibility. Also raise repeat_penalty a bit above
    // Ollama's default (1.1) — this directly discourages the model from
    // copying/repeating recent input tokens verbatim, which is exactly the
    // echoing symptom we saw.
    extraBody: {
      num_ctx: Number(process.env.OLLAMA_NUM_CTX) || 8192,
      repeat_penalty: 1.3,
      options: {
        num_ctx: Number(process.env.OLLAMA_NUM_CTX) || 8192,
        repeat_penalty: 1.3,
      },
    },
  },
];

// Models that "think" internally before answering (gpt-oss family, NVIDIA
// Nemotron Nano/Super) spend a chunk of the completion's token budget on a
// hidden reasoning phase BEFORE they ever emit visible answer text. If
// max_tokens is too tight, the response gets cut off (finish_reason:
// "length") mid-reasoning — the model never reaches the actual answer, and
// message.content comes back empty/null even though tokens were spent.
// This is a well-documented issue across every host of these models
// (vLLM, Groq, HF router, Cloudflare Workers AI, NVIDIA NIM) — not
// something specific to this app. Detect them by model id and compensate:
const REASONING_MODEL_PATTERN = /gpt-oss|nemotron/i;

function isReasoningModel(modelId) {
  return REASONING_MODEL_PATTERN.test(modelId || "");
}

async function callProvider(provider, { messages, tools, temperature, max_tokens }) {
  const body = { model: provider.model, messages, ...(provider.extraBody || {}) };
  if (tools) body.tools = tools;
  // Lower temperature = less likely for small local models (e.g. Ollama)
  // to wander off-script into rambling/mixed-language output. Callers can
  // override per-request if a task genuinely wants more creativity.
  body.temperature = temperature ?? 0.4;
  // Tight default cap on reply length — this is the single biggest lever
  // on cost/latency per request. Callers that genuinely need more (e.g. a
  // long-form draft) should pass max_tokens explicitly; everything else
  // (chat replies, tool-use calls) is naturally short and doesn't need a
  // large ceiling.
  body.max_tokens = max_tokens ?? 150;

  if (isReasoningModel(provider.model)) {
    // 1) Ask for the smallest amount of hidden reasoning the model
    //    supports. Documented param name for gpt-oss (Groq, Cerebras) and
    //    honored by most OpenAI-compatible reasoning-model hosts (HF
    //    router / Cloudflare Workers AI run the same underlying model).
    //    Harmless if a given host ignores the field.
    if (body.reasoning_effort === undefined) body.reasoning_effort = "low";
    // 2) Floor max_tokens well above what this app's callers normally ask
    //    for (120-300) — enough for even a "low effort" reasoning pass
    //    PLUS the actual short reply, so the reply never gets truncated
    //    away entirely. Never lowers a caller-provided value that's
    //    already higher than the floor.
    const REASONING_MIN_TOKENS = 1024;
    body.max_tokens = Math.max(body.max_tokens, REASONING_MIN_TOKENS);
  }

  let res;
  try {
    // Almost every provider here wants "Authorization: Bearer <key>" — the
    // one exception is Gemini (see its authHeaderName comment above), which
    // wants the raw key under its own header instead of a Bearer token.
    const headers = { "Content-Type": "application/json" };
    if (provider.authHeaderName) {
      headers[provider.authHeaderName] = provider.apiKey;
    } else {
      headers.Authorization = `Bearer ${provider.apiKey}`;
    }
    res = await fetch(`${provider.baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`[${provider.name}] network error: ${err.message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`[${provider.name}] request failed (${res.status}): ${text}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

/**
 * Tries each configured provider in order, falling through to the next on
 * ANY error (rate limit, expired credits, invalid key, network issue, etc).
 * Returns an OpenAI-style completion object, plus which provider answered
 * (useful for logging/debugging which one is actually being used).
 */
/**
 * Calls Gemini via its native generateContent endpoint with the API key as a
 * query param — avoids the OpenAI-compat layer entirely, which is the only
 * path that reliably works with AQ.-prefix keys.
 * Returns a response shaped like an OpenAI chat completion so the rest of
 * the app doesn't need to know which path was taken.
 */
async function callGemini(provider, { messages, temperature, max_tokens }) {
  const model = provider.model;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${provider.apiKey}`;

  // Convert OpenAI-style messages to Gemini's "contents" format.
  // System messages become the first "user" turn prefixed with context.
  const systemMsg = messages.find((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");

  const contents = nonSystem.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const body = {
    contents,
    generationConfig: {
      temperature: temperature ?? 0.4,
      maxOutputTokens: max_tokens ?? 150,
    },
  };

  if (systemMsg) {
    body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  }

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`[gemini] network error: ${err.message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`[gemini] request failed (${res.status}): ${text}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  // Shape response like an OpenAI completion so callers don't need to branch.
  return {
    choices: [{ message: { role: "assistant", content: text } }],
  };
}

async function chat({ messages, tools, temperature, max_tokens, forceProvider }) {
  let active = PROVIDERS.filter((p) => p.alwaysAvailable || p.apiKey);

  if (forceProvider) {
    // Dev-mode override: isolate a single named provider with NO fallback,
    // so its raw behavior (including failures) is visible for testing —
    // this is what lets you tell which provider is actually good/bad at
    // roleplay, instead of the fallback chain masking a weak one behind a
    // stronger one that happened to answer first.
    const only = PROVIDERS.find((p) => p.name === forceProvider);
    if (!only) throw new Error(`Unknown provider "${forceProvider}"`);
    if (!only.alwaysAvailable && !only.apiKey) {
      throw new Error(`Provider "${forceProvider}" has no API key configured in .env`);
    }
    active = [only];
  }

  if (active.length === 0) {
    throw new Error(
      "No AI provider available. Set at least one API key in .env (GROQ_API_KEY, CEREBRAS_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, NVIDIA_API_KEY), or make sure Ollama is installed and running locally."
    );
  }

  let lastErr;
  const attempts = [];
  for (const provider of active) {
    try {
      const data = provider.useNativeGemini
        ? await callGemini(provider, { messages, temperature, max_tokens })
        : await callProvider(provider, { messages, tools, temperature, max_tokens });
      return { ...data, _provider: provider.name };
    } catch (err) {
      console.warn(`[provider fallback] ${provider.name} failed, trying next. Reason: ${err.message}`);
      attempts.push(`${provider.name}: ${err.message}`);
      lastErr = err;
    }
  }

  // Every active provider failed. Surface exactly which ones were tried and
  // why each one failed (not just the last one) — this is the detail that
  // shows up in the dev-mode call log, and it's the difference between
  // "something broke" and actually being able to tell, e.g., "Groq and
  // Cerebras are both rate-limited right now, DeepSeek's key is invalid".
  const combined = new Error(
    `All ${active.length} provider(s) failed. ${attempts.join(" | ")}`
  );
  combined.attempts = attempts;
  throw combined;
}

module.exports = { chat, PROVIDERS };

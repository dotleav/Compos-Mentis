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
// works for all five:
//   - Groq:       https://console.groq.com/keys
//   - Cerebras:   https://cloud.cerebras.ai  (free tier, very fast inference)
//   - OpenRouter: https://openrouter.ai/keys (routes to many models, some free)
//   - NVIDIA:     https://build.nvidia.com  (an API catalog key, free tier)
//   - Ollama:     runs locally, no key needed

const PROVIDERS = [
  {
    name: "groq",
    baseURL: "https://api.groq.com/openai/v1",
    apiKey: process.env.GROQ_API_KEY,
    model: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
  },
  {
    name: "cerebras",
    baseURL: "https://api.cerebras.ai/v1",
    apiKey: process.env.CEREBRAS_API_KEY,
    model: process.env.CEREBRAS_MODEL || "llama3.1-8b",
  },
  {
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL || "meta-llama/llama-3.1-8b-instruct:free",
  },
  {
    name: "nvidia",
    baseURL: "https://integrate.api.nvidia.com/v1",
    apiKey: process.env.NVIDIA_API_KEY,
    // Double-check the exact model slug in the NVIDIA API catalog (build.nvidia.com) —
    // catalog model names change; this is a reasonable default, not guaranteed current.
    model: process.env.NVIDIA_MODEL || "nvidia/llama-3.1-nemotron-70b-instruct",
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

  let res;
  try {
    res = await fetch(`${provider.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
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
async function chat({ messages, tools, temperature, max_tokens }) {
  const active = PROVIDERS.filter((p) => p.alwaysAvailable || p.apiKey);

  if (active.length === 0) {
    throw new Error(
      "No AI provider available. Set at least one API key in .env (GROQ_API_KEY, CEREBRAS_API_KEY, OPENROUTER_API_KEY, NVIDIA_API_KEY), or make sure Ollama is installed and running locally."
    );
  }

  let lastErr;
  for (const provider of active) {
    try {
      const data = await callProvider(provider, { messages, tools, temperature, max_tokens });
      return { ...data, _provider: provider.name };
    } catch (err) {
      console.warn(`[provider fallback] ${provider.name} failed, trying next. Reason: ${err.message}`);
      lastErr = err;
    }
  }

  throw lastErr;
}

module.exports = { chat, PROVIDERS };

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
// works for all four:
//   - Groq:    https://console.groq.com/keys
//   - Gemini:  https://aistudio.google.com/apikey
//   - NVIDIA:  https://build.nvidia.com  (an API catalog key, free tier)
//   - Ollama:  runs locally, no key needed

const PROVIDERS = [
  {
    name: "groq",
    baseURL: "https://api.groq.com/openai/v1",
    apiKey: process.env.GROQ_API_KEY,
    model: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
  },
  {
    name: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  },
  {
    name: "nvidia",
    baseURL: "https://integrate.api.nvidia.com/v1",
    apiKey: process.env.NVIDIA_API_KEY,
    // Double-check the exact model slug in the NVIDIA API catalog (build.nvidia.com) —
    // catalog model names change; this is a reasonable default, not guaranteed current.
    model: process.env.NVIDIA_MODEL || "meta/llama-3.1-8b-instruct",
  },
  {
    name: "ollama",
    baseURL: `${(process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, "")}/v1`,
    apiKey: "ollama", // required field in the request shape, but Ollama itself ignores it
    model: process.env.OLLAMA_MODEL || "qwen2.5:3b",
    alwaysAvailable: true, // never skipped even without a "real" key — the guaranteed fallback
  },
];

async function callProvider(provider, { messages, tools, temperature, max_tokens }) {
  const body = { model: provider.model, messages };
  if (tools) body.tools = tools;
  // Lower temperature = less likely for small local models (e.g. Ollama)
  // to wander off-script into rambling/mixed-language output. Callers can
  // override per-request if a task genuinely wants more creativity.
  body.temperature = temperature ?? 0.4;
  body.max_tokens = max_tokens ?? 300;

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
      "No AI provider available. Set at least one API key in .env (GROQ_API_KEY, GEMINI_API_KEY, NVIDIA_API_KEY), or make sure Ollama is installed and running locally."
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

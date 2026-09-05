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
// works for all of them:
//   - Groq:         https://console.groq.com/keys
//   - Cerebras:     https://cloud.cerebras.ai  (free tier, very fast inference)
//   - Gemini:       https://aistudio.google.com/apikey (free tier via OpenAI-compat endpoint)
//   - Mistral:      https://console.mistral.ai/api-keys (free experiment tier ~1B tok/mo)
//   - NVIDIA:       https://build.nvidia.com  (an API catalog key, free tier)
//   - DeepSeek:     https://platform.deepseek.com/api_keys (cheap pay-as-you-go, 5M free tokens on signup)
//   - Hugging Face: https://huggingface.co/settings/tokens (router in front of many hosted models, free monthly credits)
//   - Cloudflare:   https://dash.cloudflare.com/profile/api-tokens (Workers AI, 10K neurons/day free, resets daily)
//   - Ollama Cloud: https://ollama.com/settings/api-keys (free tier, resets every 5h/7d)
//   - Ollama:       runs locally, no key needed

// ── PROVIDER AUDIT — verified September 2026 ────────────────────────────────
// All models below confirmed active. Summary:
//   groq       → openai/gpt-oss-20b      ✓ (131k ctx, reasoning, tool-call)
//   cerebras   → gpt-oss-120b            ✓ (131k ctx, fastest inference, free tier)
//   gemini     → gemini-2.5-flash        ✓ (AQ. key → x-goog-api-key header, NOT Bearer)
//   mistral    → mistral-small-latest    ✓ (24B, good Indonesian, cheap)
//   nvidia     → nvidia-nemotron-nano-9b-v2 ✓ (build.nvidia.com, free trial, tool-call)
//   deepseek   → deepseek-v4-flash       ✓ (1M ctx, 284B MoE, $0.14/1M in)
//               NOTE: legacy deepseek-chat alias deprecated 2026-07-24 — use v4-flash
//   huggingface→ openai/gpt-oss-120b     ✓ (HF router, auto provider selection)
//   cloudflare → @cf/meta/llama-3.1-8b-instruct ✓ (10K neurons/day free, daily reset)
//   ollama-cloud→ llama3.3               ✓ (free, resets 5h/7d)
//   ollama     → qwen2.5:3b              ✓ (local, always available)
//
// Fallback order is intentional: fastest free-tier first, local last.
// If a provider consistently exhausts quota, move it lower in the list.
// ────────────────────────────────────────────────────────────────────────────

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
    name: "gemini",
    // Google's OpenAI-compatibility layer — same request/response shape as
    // the rest of these, so no separate caller needed. Get a free key at
    // https://aistudio.google.com/apikey
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    // Google is mid-migration from "AIza..." Standard keys to "AQ." Auth
    // keys (all new keys from AI Studio are AQ. as of mid-2026). AQ. keys
    // sent via the usual "Authorization: Bearer <key>" header get
    // rejected with 401 ACCESS_TOKEN_TYPE_UNSUPPORTED — Google's auth
    // layer reads a Bearer header as an OAuth2 token attempt, and AQ. keys
    // aren't OAuth2 tokens. Google's own API reference (ai.google.dev/api)
    // states plainly: "All requests to the Gemini API must include a
    // x-goog-api-key header with your API key" — so send it that way
    // instead. See authHeader() in callProvider() below.
    authHeaderName: "x-goog-api-key",
  },
  {
    name: "mistral",
    // Mistral's own API — OpenAI-compatible, no adapter needed.
    // Get a key at: https://console.mistral.ai/api-keys
    // New accounts on "La Plateforme" get a free experiment tier with
    // monthly credits; after that it's pay-as-you-go at very low rates
    // (~$0.10-0.30 per 1M tokens depending on model).
    //
    // Why use this instead of Mistral via OpenRouter?
    //   - Direct API has no OpenRouter rate-limit overhead
    //   - Responses are more consistent (no free-tier throttling)
    //   - Full access to all Mistral models without :free suffix tricks
    //
    // MODEL OPTIONS (set via MISTRAL_MODEL in .env):
    //   "mistral-small-latest"   — default; ~24B, fast, cheap, follows
    //                              system prompts well, good Indonesian.
    //                              Best balance for roleplay use case.
    //   "mistral-medium-latest"  — larger, better reasoning, moderate cost
    //   "open-mistral-nemo"      — 12B, smallest/cheapest, still decent
    //                              for short roleplay turns
    //   "mistral-large-latest"   — top-tier quality, higher cost; overkill
    //                              for this app's short-reply use case
    //
    // To switch model: add  MISTRAL_MODEL=open-mistral-nemo  to .env
    baseURL: "https://api.mistral.ai/v1",
    apiKey: process.env.MISTRAL_API_KEY,
    model: process.env.MISTRAL_MODEL || "mistral-small-latest",
  },
  {
    name: "nvidia",
    baseURL: "https://integrate.api.nvidia.com/v1",
    apiKey: process.env.NVIDIA_API_KEY,
    // NVIDIA retired "nvidia/llama-3.1-nemotron-70b-instruct" — it now 404s.
    // Nemotron Nano 9B v2 confirmed active on build.nvidia.com as of Sep 2026.
    // Hybrid Mamba-Transformer, 128K ctx, free trial tier, tool-calling supported.
    // Model ID on NVIDIA NIM API: "nvidia/nvidia-nemotron-nano-9b-v2"
    // If it 404s again check: https://build.nvidia.com/explore/discover
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
    name: "ollama-cloud",
    // Ollama Cloud — hosted version of Ollama, OpenAI-compatible endpoint.
    // Free tier with rate limits that reset every 5 hours (session) and
    // every 7 days (weekly cap). No credit card required.
    // Get a key at: https://ollama.com/settings/api-keys
    //
    // MODEL OPTIONS (set via OLLAMA_CLOUD_MODEL in .env):
    //   "llama3.3"           — default; 70B, strong instruction following,
    //                          good Indonesian, best overall quality
    //   "qwen2.5:72b"        — alternative 72B, excellent for roleplay
    //   "qwen2.5:32b"        — lighter, still very capable
    //   "mistral-small"      — 22B, fast, follows system prompts well
    //   "gemma3:27b"         — Google Gemma 27B
    //
    // To switch: add  OLLAMA_CLOUD_MODEL=qwen2.5:72b  to .env
    baseURL: "https://api.ollama.com/v1",
    apiKey: process.env.OLLAMA_CLOUD_API_KEY,
    model: process.env.OLLAMA_CLOUD_MODEL || "llama3.3",
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
      "No AI provider available. Set at least one API key in .env (GROQ_API_KEY, CEREBRAS_API_KEY, GEMINI_API_KEY, MISTRAL_API_KEY, NVIDIA_API_KEY, OLLAMA_CLOUD_API_KEY), or make sure Ollama is installed and running locally."
    );
  }

  let lastErr;
  const attempts = [];
  for (const provider of active) {
    try {
      const data = await callProvider(provider, { messages, tools, temperature, max_tokens });
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

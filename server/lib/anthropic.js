const Anthropic = require("@anthropic-ai/sdk");

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    "[warn] ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in."
  );
}

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

module.exports = { client, MODEL };

const { GoogleGenAI } = require("@google/genai");

if (!process.env.GEMINI_API_KEY) {
  console.warn(
    "[warn] GEMINI_API_KEY is not set. Copy .env.example to .env and fill it in. Get a free key at https://aistudio.google.com/apikey"
  );
}

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

module.exports = { client, MODEL };

#!/usr/bin/env node
/**
 * Helper to convert a .docx case bank into case JSON + extracted images.
 *
 * Usage:
 *   node scripts/docx-to-case.js <path-to.docx> --kategori kardio [--ai]
 *
 * What it always does:
 *   1. Extracts any embedded images (word/media/*) into
 *      data/images/<kategori>/_extracted_<docx-basename>/
 *   2. Dumps the raw text (tables included) into
 *      data/cases/<kategori>/_raw_<docx-basename>.txt   (for you to read)
 *
 * What --ai additionally does:
 *   3. Sends that raw text to Claude and asks it to DRAFT case JSON files
 *      following data/cases/_SCHEMA.md, saved as
 *      data/cases/<kategori>/_draft_<docx-basename>.json
 *
 *      This is a DRAFT ONLY. Medical facts must be verified by you (or a
 *      qualified reviewer) before moving it out of _draft_ and into a real
 *      case file — the AI is drafting structure/wording, not verifying
 *      clinical correctness.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const mammoth = require("mammoth");

const args = process.argv.slice(2);
const docxPath = args[0];
const kategori = args.includes("--kategori") ? args[args.indexOf("--kategori") + 1] : null;
const useAI = args.includes("--ai");

if (!docxPath || !kategori) {
  console.error("Usage: node scripts/docx-to-case.js <path-to.docx> --kategori <kategori> [--ai]");
  process.exit(1);
}

const ROOT = path.join(__dirname, "..");
const base = path.basename(docxPath, path.extname(docxPath)).replace(/[^a-zA-Z0-9_-]/g, "_");

async function main() {
  // 1. Extract images
  const zip = new AdmZip(docxPath);
  const mediaEntries = zip.getEntries().filter((e) => e.entryName.startsWith("word/media/"));
  const imgOutDir = path.join(ROOT, "data", "images", kategori, `_extracted_${base}`);
  if (mediaEntries.length > 0) {
    fs.mkdirSync(imgOutDir, { recursive: true });
    mediaEntries.forEach((e) => {
      const fname = path.basename(e.entryName);
      fs.writeFileSync(path.join(imgOutDir, fname), e.getData());
    });
    console.log(`Extracted ${mediaEntries.length} image(s) to ${path.relative(ROOT, imgOutDir)}`);
  } else {
    console.log("No embedded images found in this docx.");
  }

  // 2. Dump raw text (tables included, tab-separated cells)
  const { value: rawText } = await mammoth.extractRawText({ path: docxPath });
  const casesDir = path.join(ROOT, "data", "cases", kategori);
  fs.mkdirSync(casesDir, { recursive: true });
  const rawOut = path.join(casesDir, `_raw_${base}.txt`);
  fs.writeFileSync(rawOut, rawText, "utf-8");
  console.log(`Raw text dumped to ${path.relative(ROOT, rawOut)}`);

  if (!useAI) {
    console.log("\nDone. Use _SCHEMA.md as a template and the raw text above to hand-author case JSON.");
    return;
  }

  // 3. AI draft
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set — cannot use --ai. Copy .env.example to .env first.");
    process.exit(1);
  }
  const { client, MODEL } = require("../server/lib/anthropic");
  const schema = fs.readFileSync(path.join(ROOT, "data", "cases", "_SCHEMA.md"), "utf-8");

  console.log("\nAsking Claude to draft case JSON — this may take a bit for large tables...");
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: `Kamu membantu mengubah tabel kasus OSCE mentah menjadi JSON terstruktur sesuai skema berikut. Jangan mengubah/menambah fakta medis apa pun dari teks asli — hanya restrukturisasi ke format JSON. Jika suatu field tidak ada di teks asli, isi dengan string kosong atau array kosong, JANGAN mengarang. Keluarkan HANYA JSON array valid (array of case objects sesuai skema), tanpa teks lain, tanpa markdown code fences.\n\nSKEMA:\n${schema}`,
    messages: [
      {
        role: "user",
        content: `Berikut teks mentah dari dokumen (mungkin berisi banyak kasus dalam satu tabel). Kategori: "${kategori}". Ubah setiap kasus menjadi satu object JSON sesuai skema. Untuk field "id", buat slug singkat dari nama diagnosis (lowercase, underscore). Untuk "pemeriksaanFisik" dan "penunjang", pecah setiap baris/poin temuan menjadi item terpisah dengan id singkat unik. Untuk "image", biarkan null kecuali teks eksplisit menyebut ada gambar — cek juga apakah ada gambar yang sudah diekstrak (lihat nama file di folder _extracted_${base}, jika relevan sebutkan nama filenya, kalau tidak yakin biarkan null dan beri catatan di komentar terpisah, bukan di dalam JSON).\n\nTEKS MENTAH:\n${rawText.slice(0, 40000)}`,
      },
    ],
  });

  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const draftOut = path.join(casesDir, `_draft_${base}.json`);
  fs.writeFileSync(draftOut, text, "utf-8");
  console.log(`\nDraft written to ${path.relative(ROOT, draftOut)}`);
  console.log("⚠ This is a DRAFT — review every clinical fact before using it as a real case file.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

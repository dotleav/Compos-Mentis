# OSCE AI Simulator

An OSCE practice simulator where **Anamnesis, Pemeriksaan Fisik, and Pemeriksaan
Penunjang are AI roleplay** instead of a fixed click-list — replacing the old
"search engine" from `simulator-OSCE-SEM-6-main` with real conversational
interaction, while keeping DD selection / tatalaksana / edukasi as structured,
server-graded steps so the answer key never leaks to the browser.

## The 10-step flow

1. **Read the case** — chief complaint + identity shown.
2. **Initial DD** — pick differential diagnoses from the chief complaint alone.
3. **Anamnesis** — free chat; the AI plays the **patient**, grounded only in
   that case's `groundTruth.riwayat`.
4. **Revise DD** after anamnesis.
5. **Physical exam** — type what you want to examine; the AI matches it to the
   case's predefined findings (never invents a value) and reveals it.
6. **Revise DD** again.
7. **Penunjang** — same mechanic as step 5, for labs/imaging, with optional
   images (ECG, rontgen, etc).
8. **Final diagnosis** — pick the single main diagnosis.
9. **Tatalaksana + edukasi** — multi-select the correct management/education
   points.
10. **Reveal the truth** — server-graded results, correct diagnosis, and the
    full ground-truth history for review.

## Why this fixes the "unstable search engine"

The old app matched typed text against item names with brittle string
matching. Here, a **forced tool-use call to Gemini** does the semantic
matching ("jantung didengerin" → `auskultasi_jantung`), but the actual
clinical finding text is always pulled verbatim from your case JSON — the
model is never allowed to generate a lab value or exam finding on its own. If
nothing matches, it deterministically falls back to a "normal" result instead
of guessing.

## Project structure

```
server/
  server.js            Express entrypoint
  routes/
    cases.js           list/get cases, server-side grading, reveal endpoint
    chat.js             anamnesis roleplay (patient persona)
    exam.js              PF/penunjang matching (forced tool-use, deterministic lookup)
  lib/
    gemini.js            Google Gemini (@google/genai) client
    caseLoader.js        loads case JSON, strips answer keys before sending to client
data/
  cases/<kategori>/<id>.json     case content (see data/cases/_SCHEMA.md)
  images/<kategori>/<id>/...     ECG, rontgen, etc. referenced by case JSON
public/
  index.html, app.js    frontend (vanilla JS, no build step)
scripts/
  docx-to-case.js       converts a docx case bank into case JSON (+ optional AI draft)
```

## Setup

```bash
npm install
cp .env.example .env      # add your GEMINI_API_KEY
npm start                 # http://localhost:3000
```

The API key stays server-side (in `.env`, never sent to the browser) —
that's the reason this needs a small backend rather than living purely as a
client-side artifact.

## Adding new cases from your docx files

You already have compact case-bank docx files (like
`CR_Kardiovaskular_OSCE_KOMPRE`) with columns for Kasus / Anamnesis / PF / PP /
Tatalaksana / Edukasi, and separate detailed case docx files that may contain
embedded ECG/rontgen images. Two ways to bring them in:

**1. Semi-automatic (recommended for accuracy-critical content):**
```bash
node scripts/docx-to-case.js "CR_Kardiovaskular_OSCE_KOMPRE.docx" --kategori kardio
```
This extracts any embedded images into `data/images/kardio/_extracted_.../`
and dumps the raw table text into `data/cases/kardio/_raw_....txt` so you can
hand-author the JSON using `data/cases/_SCHEMA.md` as a template — the
sample case `data/cases/kardio/stemi_anteroseptal.json` was built exactly
this way from your uploaded file.

**2. AI-drafted (faster, needs review):**
```bash
node scripts/docx-to-case.js "CR_Kardiovaskular_OSCE_KOMPRE.docx" --kategori kardio --ai
```
Same extraction, plus Gemini drafts a first-pass JSON array into
`_draft_....json`. **Treat this as a draft only** — verify every clinical
fact (values, DD, drug doses) before promoting it to a real `<id>.json` case
file. The AI is asked to restructure, not invent, but medical content still
needs a qualified human check before students train on it.

For images: if a source docx has no embedded pictures (like the compact
kardio table you uploaded), just drop the real ECG/rontgen image files
straight into `data/images/<kategori>/<case-id>/` and reference the filename
in that case's `penunjang[].image` field.

## Deployment

This is a normal Node/Express app — deploy it the same way you'd deploy
Soalin (a VPS, Render, Railway, Fly.io, etc.), just make sure `GEMINI_API_KEY`
is set as an environment variable on the host and never committed to git
(`.env` is already in `.gitignore`).

## Extending the roleplay

- **Patient persona** (`server/routes/chat.js`) — tune tone/verbosity in the
  system prompt if patients feel too talkative or too terse.
- **Exam matching** (`server/routes/exam.js`) — if you want partial-credit
  hints (e.g. "pemeriksaan itu tidak relevan untuk kasus ini") instead of a
  silent normal fallback, that's a small change to the `matchedIds.length === 0`
  branch.
- Add more categories by creating `data/cases/<new-kategori>/` and adding
  the category name — `listCategories()` picks up folders automatically.

# OSCE AI Simulator

An OSCE practice simulator with AI roleplaying  as the patient.

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

## AI Replaces the old search engine"

The old app matched typed text against item names with brittle string
matching. Here, a **forced tool-use call to the AI provider** does the semantic
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
    customCases.js       upload/list/delete Custom Case docx uploads
    drive.js             optional Google Drive connect/status/callback
  lib/
    providers.js         Multi-provider client (Groq/Cerebras/OpenRouter/NVIDIA/Ollama) with fallback
    caseLoader.js        loads case JSON, strips answer keys before sending to client
    customCaseStore.js   converts+stores uploaded docx as namespaced cases under data/cases/_custom/
    googleDrive.js        OAuth2 + folder upload for the optional Drive backup
data/
  cases/<kategori>/<id>.json     case content (see data/cases/_SCHEMA.md)
  images/<kategori>/<id>/...     ECG, rontgen, etc. referenced by case JSON
  custom-uploads/                 (gitignored) original docx + index.json for Custom Case uploads
public/
  index.html, app.js    frontend (vanilla JS, no build step)
scripts/
  docx-to-case.js       converts a docx case bank into case JSON — same script the
                        Custom Case upload feature runs under the hood, see below
```

## Setup

```bash
npm install
cp .env.example .env      # add your GROQ_API_KEY / CEREBRAS_API_KEY / OPENROUTER_API_KEY
npm start                 # http://localhost:3000
```

The API key stays server-side (in `.env`, never sent to the browser) —
that's the reason this needs a small backend rather than living purely as a
client-side artifact.

## Adding new cases from your docx files

If you already have compact case-bank docx files (like
`CR_Kardiovaskular_OSCE_KOMPRE`) with columns for Kasus / Anamnesis / PF / PP /
Tatalaksana / Edukasi, and separate detailed case docx files that may contain
embedded ECG/rontgen images, there are two ways to bring them in — the CLI
below, or the in-app Custom Case uploader further down.

**Semi-automatic (recommended for accuracy-critical content):**
```bash
node scripts/docx-to-case.js "CR_Kardiovaskular_OSCE_KOMPRE.docx" --kategori kardio
```
This extracts any embedded images into `data/images/kardio/<case-id>/` and
dumps the raw table text into `data/cases/kardio/_raw_....txt` for reference.
Always skim the ✔/⚠ lines it prints and the resulting JSON before treating a
case as ready — this is a structural conversion only, it does not verify
medical accuracy. See `scripts/CASE_TEMPLATE_GUIDE.md` and
`scripts/CASE_TEMPLATE.docx` for the exact table format it expects (including
the `*` significant / `!` wajib-lapor / `+`/`-` tatalaksana-edukasi modifiers).

For images: if a source docx has no embedded pictures, just drop the real
ECG/rontgen image files straight into `data/images/<kategori>/<case-id>/` and
reference the filename in that item's `image` field.

### Custom Case — uploading a docx from inside the app

Beyond the CLI above, there's also an in-app **Custom Case** uploader on the
landing screen: drag-and-drop (or click to browse) a filled-in
`CASE_TEMPLATE.docx` and it runs through the exact same converter
server-side (`server/lib/customCaseStore.js` spawns
`scripts/docx-to-case.js` — one parser, no logic duplicated).

- Every upload gets a short random id; the case(s) it produces are stored
  under `data/cases/_custom/<uploadId>__<caseId>.json`, namespaced so two
  different uploads can never collide even if both use the same case ID.
- `_custom` is excluded from `caseLoader.listCategories()` (any folder
  starting with `_` is), so it never shows up as a random-draw checkbox —
  it's only reachable by exact id, which is exactly how the landing page's
  expandable "Kasus Custom Saya" list starts one.
- Deleting an upload from that list removes its case JSON, images, and the
  originally-uploaded docx.

### Optional: Google Drive backup for Custom Case uploads

If you want every uploaded docx auto-backed-up to a Google Drive folder you
own, fill in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` /
`GOOGLE_REDIRECT_URI` in `.env` (setup steps are in `.env.example`). Without
those three set, the Custom Case uploader still works fully — the Drive
section of its card just shows a "not configured" note instead of a connect
button. See `server/lib/googleDrive.js` for why it requests the full `drive`
scope rather than the narrower `drive.file` (short version: linking an
*existing* folder by pasting its link needs it — `drive.file` only covers
files the app itself creates, or ones opened through Google's Picker
widget, which isn't wired up here).

## Deployment

This is a normal Node/Express app, just make sure your provider API key(s)
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
  the category name — `listCategories()` picks up folders automatically
  (except ones starting with `_`, reserved for Custom Case storage).

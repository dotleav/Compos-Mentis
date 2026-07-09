const fs = require("fs");
const path = require("path");

const CASES_DIR = path.join(__dirname, "..", "..", "data", "cases");

/** List all categories (subfolders of data/cases) */
function listCategories() {
  return fs
    .readdirSync(CASES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/** List all cases in a category, client-safe (no groundTruth) */
function listCases(kategori) {
  const dir = path.join(CASES_DIR, kategori);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const full = loadCase(kategori, f.replace(/\.json$/, ""));
      return stripGroundTruth(full);
    });
}

/** Load the FULL case (including groundTruth) — server-side use only */
function loadCase(kategori, id) {
  const file = path.join(CASES_DIR, kategori, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

/** Return a copy of a case safe to send to the browser (no ground truth / no answers) */
function stripGroundTruth(fullCase) {
  if (!fullCase) return null;
  const { groundTruth, dd, tatalaksana, edukasi, ...rest } = fullCase;
  return {
    ...rest,
    // DD choices are shown, but not which one is "benar"
    ddPilihan: dd ? shuffle([...dd.pilihan]) : [],
    // options are shown, but not which are "benar" (checked server-side on submit)
    // shuffled so correct answers aren't always listed first (they're grouped
    // "benar" first in the source JSON, which would otherwise leak a pattern)
    tatalaksanaPilihan: shuffle((tatalaksana || []).map((t) => t.opsi)),
    edukasiPilihan: shuffle((edukasi || []).map((e) => e.opsi)),
  };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = { listCategories, listCases, loadCase, stripGroundTruth, CASES_DIR };

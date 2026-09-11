const fs = require("fs");
const path = require("path");

const CASES_DIR = path.join(__dirname, "..", "..", "data", "cases");

// ── IN-MEMORY CASE CACHE ─────────────────────────────────────────────────────
// Cases are static JSON on disk — reading them fresh on every API call is
// pure I/O waste. Cache them in a module-level Map on first access.
// invalidateCache(kategori, id) is called by customCases.js after upload so
// new custom cases appear immediately without a restart.
const _caseCache = new Map();     // key: "kategori/id"
const _ddMasterCache = { flat: null, grouped: null };

function _cacheKey(kategori, id) { return `${kategori}/${id}`; }

function invalidateCache(kategori, id) {
  if (id) {
    _caseCache.delete(_cacheKey(kategori, id));
  } else {
    // invalidate entire category (e.g. after bulk upload)
    for (const k of _caseCache.keys()) {
      if (k.startsWith(`${kategori}/`)) _caseCache.delete(k);
    }
  }
  // dd-master may have changed too (new diagnoses in uploaded cases)
  _ddMasterCache.flat = null;
  _ddMasterCache.grouped = null;
}

/** List all categories (subfolders of data/cases) shown as checkboxes on the
 * landing screen. Folders starting with "_" (e.g. "_custom", where uploaded
 * Custom Case docx conversions land — see server/routes/customCases.js) are
 * deliberately excluded: they're still fully loadable via loadCase()/
 * listCases() by anyone who knows the exact category+id (used for the
 * "start this specific case" flows), just never offered as a pooled random
 * category. */
function listCategories() {
  return fs
    .readdirSync(CASES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name);
}

/** List all case ids in a category */
function listCaseIds(kategori) {
  const dir = path.join(CASES_DIR, kategori);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

/** List all cases in a category, client-safe (no groundTruth/answers) */
function listCases(kategori) {
  return listCaseIds(kategori).map((id) => stripGroundTruth(loadCase(kategori, id)));
}

/** Pick one random case id from any of the given categories (pooled together) */
function pickRandomCase(kategoriList) {
  const pool = [];
  for (const kategori of kategoriList) {
    for (const id of listCaseIds(kategori)) {
      pool.push({ kategori, id });
    }
  }
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Load the FULL case (including groundTruth) — server-side use only */
function loadCase(kategori, id) {
  const key = _cacheKey(kategori, id);
  if (_caseCache.has(key)) return _caseCache.get(key);
  const file = path.join(CASES_DIR, kategori, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  _caseCache.set(key, parsed);
  return parsed;
}

/** The master list of ALL diagnosis names across every case + their related
 * differentials — used to populate the searchable DD picker so students see
 * a large, realistic pool of diseases instead of just the ~3 tied to one case. */
function loadDdMaster() {
  if (_ddMasterCache.flat) return _ddMasterCache.flat;
  const file = path.join(CASES_DIR, "_dd_master.json");
  if (!fs.existsSync(file)) return [];
  _ddMasterCache.flat = JSON.parse(fs.readFileSync(file, "utf-8"));
  return _ddMasterCache.flat;
}

/** Return a copy of a case safe to send to the browser (no ground truth / no answers).
 * identitas and keluhanUtama are ALSO withheld here — not just hidden in the
 * UI — so a curious student checking the network tab can't just read them
 * off the initial case-load response. They're only ever revealed through
 * the roleplay itself (server/routes/chat.js) or at the final reveal step
 * (GET /reveal, which returns the untouched full case on purpose). Only
 * skenarioAwal (a deliberately vague one-liner) is shown up front. */
function stripGroundTruth(fullCase) {
  if (!fullCase) return null;
  const { groundTruth, dd, tatalaksana, edukasi, identitas, keluhanUtama, ...rest } = fullCase;
  return {
    ...rest,
    // options are shown, but not which are "benar" (checked server-side on submit)
    // shuffled so correct answers aren't always listed first (they're grouped
    // "benar" first in the source JSON, which would otherwise leak a pattern)
    tatalaksanaPilihan: shuffle((tatalaksana || []).map((t) => t.opsi)),
    edukasiPilihan: shuffle((edukasi || []).map((e) => e.opsi)),
  };
}

/** Group every diagnosis name in the master list by Stase (the case category
 * folder it belongs to), derived from which case files actually use it as
 * either the correct diagnosis or an accepted differential. Names in the
 * master list that aren't tied to any case yet fall into "lainnya". This
 * powers a browsable-by-category picker as an alternative to text search,
 * since disease names are inconsistently Indonesian/English and don't
 * always turn up in a plain substring search. */
function loadDdMasterGrouped() {
  if (_ddMasterCache.grouped) return _ddMasterCache.grouped;
  const master = loadDdMaster();
  const tagged = new Set();
  const grouped = {};
  for (const kategori of listCategories()) {
    const names = new Set();
    for (const id of listCaseIds(kategori)) {
      const kasus = loadCase(kategori, id);
      if (!kasus || !kasus.dd) continue;
      if (kasus.dd.benar) names.add(kasus.dd.benar);
      (kasus.dd.differensialBenar || []).forEach((d) => names.add(d));
    }
    if (names.size === 0) continue;
    grouped[kategori] = [...names].sort((a, b) => a.localeCompare(b));
    names.forEach((n) => tagged.add(n));
  }
  const lainnya = master.filter((m) => !tagged.has(m)).sort((a, b) => a.localeCompare(b));
  if (lainnya.length) grouped.lainnya = lainnya;
  _ddMasterCache.grouped = grouped;
  return grouped;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = {
  listCategories, listCaseIds, listCases, pickRandomCase,
  loadCase, loadDdMaster, loadDdMasterGrouped, stripGroundTruth,
  invalidateCache, CASES_DIR,
};

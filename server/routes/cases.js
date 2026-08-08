const express = require("express");
const router = express.Router();
const {
  listCategories, listCases, pickRandomCase, loadCase,
  loadDdMaster, loadDdMasterGrouped, stripGroundTruth,
} = require("../lib/caseLoader");

router.get("/categories", (req, res) => {
  res.json(listCategories());
});

// Master list of ALL diagnosis names (used for the searchable DD pickers)
router.get("/dd-master", (req, res) => {
  res.json(loadDdMaster());
});

// Same master list, grouped by Stase — lets the DD picker offer browsing by
// category as an alternative to text search (disease names mix Indo/Eng).
router.get("/dd-master-grouped", (req, res) => {
  res.json(loadDdMasterGrouped());
});

/**
 * POST /api/cases/random
 * body: { kategori: string[] }  e.g. ["psikiatri", "neurologi"]
 * Picks one random case from the pooled categories. The chosen category is
 * included in the response for internal API calls (chat/exam need it) but
 * the frontend must never display it — that's what keeps the CR type hidden.
 */
router.post("/random", (req, res) => {
  const { kategori } = req.body;
  if (!Array.isArray(kategori) || kategori.length === 0) {
    return res.status(400).json({ error: "kategori (array) is required" });
  }
  const picked = pickRandomCase(kategori);
  if (!picked) return res.status(404).json({ error: "No cases found for the selected categories" });
  const kasus = loadCase(picked.kategori, picked.id);
  res.json(stripGroundTruth(kasus));
});

router.get("/:kategori", (req, res) => {
  res.json(listCases(req.params.kategori));
});

router.get("/:kategori/:id", (req, res) => {
  const kasus = loadCase(req.params.kategori, req.params.id);
  if (!kasus) return res.status(404).json({ error: "Case not found" });
  res.json(stripGroundTruth(kasus));
});

/**
 * POST /api/cases/:kategori/:id/evaluate
 * body: { diagnosisKerja: string, diagnosisBanding: string[] (expects 2) }
 * Server-side grading so answer keys never reach the client.
 *
 * Tatalaksana and Edukasi are no longer auto-graded — they're free-form
 * (a typed R/ prescription and a typed essay), so there's nothing to match
 * against an option list. The student's own answers are simply shown next
 * to the answer key at the reveal step, ungraded.
 */
router.post("/:kategori/:id/evaluate", (req, res) => {
  const kasus = loadCase(req.params.kategori, req.params.id);
  if (!kasus) return res.status(404).json({ error: "Case not found" });

  const { diagnosisKerja = "", diagnosisBanding = [] } = req.body;

  const dkCorrect = diagnosisKerja === kasus.dd.benar;

  const acceptedDb = new Set(kasus.dd.differensialBenar || []);
  const dbResult = (diagnosisBanding || []).map((opsi) => ({
    opsi,
    benar: acceptedDb.has(opsi),
  }));
  const missedDb = (kasus.dd.differensialBenar || []).filter((d) => !diagnosisBanding.includes(d));

  res.json({
    dk: { pilihan: diagnosisKerja, benar: kasus.dd.benar, correct: dkCorrect },
    db: { result: dbResult, missed: missedDb },
  });
});

/**
 * GET /api/cases/:kategori/:id/reveal
 * Full case including groundTruth + answer keys — only call this at the
 * "reveal the truth" step, after evaluate() has already run.
 */
router.get("/:kategori/:id/reveal", (req, res) => {
  const kasus = loadCase(req.params.kategori, req.params.id);
  if (!kasus) return res.status(404).json({ error: "Case not found" });
  res.json(kasus);
});

module.exports = router;

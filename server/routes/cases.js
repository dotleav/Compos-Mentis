const express = require("express");
const router = express.Router();
const {
  listCategories, listCases, pickRandomCase, loadCase, loadDdMaster, stripGroundTruth,
} = require("../lib/caseLoader");

router.get("/categories", (req, res) => {
  res.json(listCategories());
});

// Master list of ALL diagnosis names (used for the searchable DD pickers)
router.get("/dd-master", (req, res) => {
  res.json(loadDdMaster());
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
 * body: {
 *   diagnosisKerja: string,
 *   diagnosisBanding: string[]  (expects 2),
 *   tatalaksanaPilihan: string[],
 *   edukasiPilihan: string[]
 * }
 * Server-side grading so answer keys never reach the client.
 */
router.post("/:kategori/:id/evaluate", (req, res) => {
  const kasus = loadCase(req.params.kategori, req.params.id);
  if (!kasus) return res.status(404).json({ error: "Case not found" });

  const {
    diagnosisKerja = "",
    diagnosisBanding = [],
    tatalaksanaPilihan = [],
    edukasiPilihan = [],
  } = req.body;

  const dkCorrect = diagnosisKerja === kasus.dd.benar;

  const acceptedDb = new Set(kasus.dd.differensialBenar || []);
  const dbResult = (diagnosisBanding || []).map((opsi) => ({
    opsi,
    benar: acceptedDb.has(opsi),
  }));
  const missedDb = (kasus.dd.differensialBenar || []).filter((d) => !diagnosisBanding.includes(d));

  const tatalaksanaKey = new Map(kasus.tatalaksana.map((t) => [t.opsi, t.benar]));
  const tatalaksanaResult = (tatalaksanaPilihan || []).map((opsi) => ({
    opsi,
    benar: !!tatalaksanaKey.get(opsi),
  }));
  const missedTatalaksana = kasus.tatalaksana
    .filter((t) => t.benar && !tatalaksanaPilihan.includes(t.opsi))
    .map((t) => t.opsi);

  const edukasiKey = new Map(kasus.edukasi.map((e) => [e.opsi, e.benar]));
  const edukasiResult = (edukasiPilihan || []).map((opsi) => ({
    opsi,
    benar: !!edukasiKey.get(opsi),
  }));
  const missedEdukasi = kasus.edukasi
    .filter((e) => e.benar && !edukasiPilihan.includes(e.opsi))
    .map((e) => e.opsi);

  res.json({
    dk: { pilihan: diagnosisKerja, benar: kasus.dd.benar, correct: dkCorrect },
    db: { result: dbResult, missed: missedDb },
    tatalaksana: { result: tatalaksanaResult, missed: missedTatalaksana },
    edukasi: { result: edukasiResult, missed: missedEdukasi },
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

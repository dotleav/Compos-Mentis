const express = require("express");
const router = express.Router();
const { listCategories, listCases, loadCase, stripGroundTruth } = require("../lib/caseLoader");

router.get("/categories", (req, res) => {
  res.json(listCategories());
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
 * body: { ddPilihan: string, tatalaksanaPilihan: string[], edukasiPilihan: string[] }
 * Server-side grading so answer keys never reach the client.
 */
router.post("/:kategori/:id/evaluate", (req, res) => {
  const kasus = loadCase(req.params.kategori, req.params.id);
  if (!kasus) return res.status(404).json({ error: "Case not found" });

  const { ddPilihan, tatalaksanaPilihan = [], edukasiPilihan = [] } = req.body;

  const ddCorrect = ddPilihan === kasus.dd.benar;

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
    dd: { pilihan: ddPilihan, benar: kasus.dd.benar, correct: ddCorrect },
    tatalaksana: { result: tatalaksanaResult, missed: missedTatalaksana },
    edukasi: { result: edukasiResult, missed: missedEdukasi },
    diagnosisAkhir: kasus.dd.benar,
  });
});

/**
 * GET /api/cases/:kategori/:id/reveal
 * Full case including groundTruth + answer keys — only call this at the
 * "reveal the truth" step (step 10), after evaluate() has already run.
 */
router.get("/:kategori/:id/reveal", (req, res) => {
  const kasus = loadCase(req.params.kategori, req.params.id);
  if (!kasus) return res.status(404).json({ error: "Case not found" });
  res.json(kasus);
});

module.exports = router;


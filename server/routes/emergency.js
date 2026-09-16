const express = require("express");
const router = express.Router();
const { chat } = require("../lib/providers");
const userKeys = require("../lib/userKeys");
const { loadCase } = require("../lib/caseLoader");
const { sanitizeText, isSafeSlug, MAX_QUERY_LENGTH } = require("../lib/sanitize");

// Random refusal lines for /periksa requests that need patient mobility or
// cooperation an unstable/unconscious patient can't give. Not LLM-generated
// on purpose — deterministic and instant, no reason to spend a model call
// deciding how to say "you can't do that right now".
const TIDAK_BISA_LINES = [
  "Pasien tidak sadarkan diri, tidak bisa mengikuti instruksi itu sekarang.",
  "Kalau pasien bisa bangun dan melakukan itu sendiri, dia pasti sudah menampar Anda duluan.",
  "Kondisi pasien terlalu tidak stabil untuk pemeriksaan itu — fokus dulu ke tanda vital dan primary survey (ABCDE).",
  "Pasien belum bisa diajak kerja sama untuk pemeriksaan itu. Stabilkan dulu.",
  "Bukan prioritas sekarang — selesaikan primary survey dan stabilisasi dulu sebelum pemeriksaan itu.",
];

function pickLine() {
  return TIDAK_BISA_LINES[Math.floor(Math.random() * TIDAK_BISA_LINES.length)];
}

function loadKgd(kategori, id) {
  if (!isSafeSlug(kategori) || !isSafeSlug(id)) return { error: "Invalid kategori or id" };
  const kasus = loadCase(kategori, id);
  if (!kasus) return { error: "Case not found" };
  if (!kasus.kegawatdaruratan) return { error: "Case has no kegawatdaruratan data" };
  return { kasus };
}

/**
 * POST /api/emergency/periksa
 * body: { kategori, id, query, done: string[] }
 * Same deterministic-lookup, LLM-only-matches philosophy as /api/exam/perform,
 * but the catalog is restricted to vital signs + primary survey (ABCDE) —
 * the only things checkable on an unstable/unconscious patient. Anything
 * else gets a canned refusal instead of a fabricated finding.
 */
router.post("/periksa", async (req, res) => {
  try {
    const { kategori, id, query, done = [], forceProvider } = req.body;
    if (!kategori || !id || !query) {
      return res.status(400).json({ error: "kategori, id, and query are required" });
    }
    const { error, kasus } = loadKgd(kategori, id);
    if (error) return res.status(error === "Case not found" ? 404 : 400).json({ error });

    const cleanQuery = sanitizeText(query, { maxLength: MAX_QUERY_LENGTH });
    if (!cleanQuery) return res.status(400).json({ error: "query is empty after sanitization" });

    const kd = kasus.kegawatdaruratan;
    const list = (kasus.groundTruth.pemeriksaanFisik || []).filter(
      (item) => item.kelompok === "vital" || item.kelompok === "survei_primer"
    );
    const catalog = list.map((item) => ({ id: item.id, nama: item.nama }));

    const tools = [
      {
        type: "function",
        function: {
          name: "select_findings",
          description:
            "Pilih satu atau lebih pemeriksaan dari daftar yang tersedia yang paling cocok dengan permintaan mahasiswa. Jika tidak ada yang cocok, kembalikan array kosong.",
          parameters: {
            type: "object",
            properties: {
              matched_ids: {
                type: "array",
                items: { type: "string" },
                description: `id yang cocok, HARUS salah satu dari: ${catalog.map((c) => c.id).join(", ")}. Jangan mengarang id lain.`,
              },
            },
            required: ["matched_ids"],
          },
        },
      },
    ];

    const systemPrompt = `Kamu adalah sistem pencocokan pemeriksaan pada pasien gawat darurat yang TIDAK STABIL/tidak sadar penuh di simulasi OSCE. Mahasiswa hanya boleh memeriksa tanda vital dan primary survey (Airway, Breathing, Circulation, Disability, Exposure) — pemeriksaan lain yang butuh mobilisasi/kerja sama pasien TIDAK tersedia di sini.

Daftar pemeriksaan yang tersedia:
${catalog.map((c) => `- ${c.id}: ${c.nama}`).join("\n")}

Cocokkan secara semantik/klinis (mis. "cek nadi" = Nadi, "sat O2" = SpO2, "gimana napasnya" = Breathing, "level kesadaran" = Kesadaran/Disability). Jika permintaan mahasiswa TIDAK cocok dengan daftar ini sama sekali (mis. minta pemeriksaan yang butuh pasien bergerak/berbicara panjang, atau minta hasil lab/pencitraan), kembalikan array kosong — jangan memaksakan.`;

    const response = await chat({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: cleanQuery },
      ],
      tools,
      max_tokens: 300,
      forceProvider,
      userKeys: req.sessionConfigured ? userKeys.getDecrypted(req.sessionId) : undefined,
    });

    const toolCalls = response.choices?.[0]?.message?.tool_calls || [];
    const call = toolCalls.find((c) => c.function?.name === "select_findings");
    let matchedIds = [];
    if (call) {
      try {
        const args = typeof call.function.arguments === "string" ? JSON.parse(call.function.arguments) : call.function.arguments;
        matchedIds = args?.matched_ids || [];
      } catch (e) {
        console.warn(`[emergency/periksa] malformed tool_call JSON: ${e.message}`);
      }
    }

    if (matchedIds.length === 0) {
      return res.json({ matched: [], results: [{ nama: cleanQuery, temuan: pickLine(), signifikan: false, image: null, tidakBisa: true }] });
    }

    const results = matchedIds
      .map((mid) => list.find((item) => item.id === mid))
      .filter(Boolean)
      .map((item) => ({
        id: item.id,
        nama: item.nama,
        // Unstable reading (kondisiUnstabil) takes priority while in the
        // emergency step — the item's own `temuan` is the post-stabilization
        // normal value, reused later by the regular Pem. Fisik step.
        temuan: (kd.kondisiUnstabil && kd.kondisiUnstabil[item.id]) || item.temuan,
        signifikan: item.signifikan,
        image: item.image ? `/data/images/${kategori}/${id}/${item.image}` : null,
        alreadyDone: done.includes(item.id),
      }));

    if (results.length === 0) {
      return res.json({ matched: [], results: [{ nama: cleanQuery, temuan: pickLine(), signifikan: false, image: null, tidakBisa: true }] });
    }

    res.json({ matched: matchedIds, results, _provider: response._provider });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Emergency exam matching failed", detail: String(err.message || err) });
  }
});

/**
 * POST /api/emergency/tindakan
 * body: { kategori, id, pesan, done: string[] (ids of tindakanBenar already
 *         successfully administered this session) }
 *
 * Classifies a free-text drug/action order into one of three outcomes:
 *   - "benar"          matches a case-authored correct stabilizing action
 *   - "kontraindikasi" matches a known contraindication OR is clearly
 *                       clinically dangerous for this specific emergency
 *   - "tidak_efektif"  anything else — harmless but does nothing
 * The model only classifies; the outcome text (efek/alasan) is always
 * either case-authored or a fixed string, never free-generated.
 */
router.post("/tindakan", async (req, res) => {
  try {
    const { kategori, id, pesan, done = [], forceProvider } = req.body;
    if (!kategori || !id || !pesan) {
      return res.status(400).json({ error: "kategori, id, and pesan are required" });
    }
    const { error, kasus } = loadKgd(kategori, id);
    if (error) return res.status(error === "Case not found" ? 404 : 400).json({ error });

    const cleanPesan = sanitizeText(pesan);
    if (!cleanPesan) return res.status(400).json({ error: "pesan is empty after sanitization" });

    const kd = kasus.kegawatdaruratan;
    const benar = kd.tindakanBenar || [];
    const kontra = kd.tindakanKontraindikasi || [];

    const tools = [
      {
        type: "function",
        function: {
          name: "evaluasi_tindakan",
          description: "Evaluasi permintaan tindakan/obat mahasiswa untuk pasien gawat darurat ini.",
          parameters: {
            type: "object",
            properties: {
              hasil: {
                type: "string",
                enum: ["benar", "kontraindikasi", "tidak_efektif"],
                description:
                  "'benar' = cocok dengan salah satu tindakan stabilisasi yang tepat di daftar. 'kontraindikasi' = cocok dengan daftar kontraindikasi ATAU jelas berbahaya/salah secara klinis untuk kondisi spesifik ini. 'tidak_efektif' = tidak berbahaya tapi tidak relevan/tidak membantu stabilisasi kondisi ini.",
              },
              matched_id: {
                type: "string",
                description: `Kalau hasil='benar', WAJIB isi salah satu id berikut (jangan mengarang): ${benar.map((b) => b.id).join(", ")}. Kalau hasil bukan 'benar', isi string kosong.`,
              },
              alasan: {
                type: "string",
                description: "Alasan klinis singkat (1 kalimat, Bahasa Indonesia) — wajib diisi jelas kalau hasil='kontraindikasi'.",
              },
            },
            required: ["hasil", "alasan"],
          },
        },
      },
    ];

    const systemPrompt = `Kamu adalah penilai tindakan klinis dalam simulasi kegawatdaruratan OSCE. Kondisi pasien saat ini: ${kd.kondisiAwal}

Daftar tindakan stabilisasi yang BENAR untuk kasus ini:
${benar.map((b) => `- ${b.id}: ${b.nama}`).join("\n")}

Daftar tindakan yang KONTRAINDIKASI/berbahaya untuk kasus ini:
${kontra.length ? kontra.map((k) => `- ${k.nama}: ${k.alasan}`).join("\n") : "(tidak ada daftar eksplisit — gunakan penilaian klinismu sendiri untuk tindakan yang jelas berbahaya/kontraindikasi mutlak pada kondisi ini)"}

Mahasiswa akan menuliskan tindakan/obat yang ingin diberikan dalam bahasa bebas. Cocokkan secara semantik/klinis ke daftar BENAR (mis. "suntik epinefrin di paha" = tindakan epinefrin IM). Kalau permintaan jelas cocok dengan daftar kontraindikasi ATAU secara klinis jelas berbahaya/kontraproduktif untuk kondisi spesifik ini walau tidak tertulis eksplisit, jawab 'kontraindikasi'. Kalau tidak berbahaya tapi tidak membantu/tidak relevan (termasuk permintaan yang tidak jelas maksudnya), jawab 'tidak_efektif'. Kamu WAJIB memanggil fungsi evaluasi_tindakan, jangan menjawab dengan teks biasa.`;

    const response = await chat({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: cleanPesan },
      ],
      tools,
      max_tokens: 300,
      forceProvider,
      userKeys: req.sessionConfigured ? userKeys.getDecrypted(req.sessionId) : undefined,
    });

    const toolCalls = response.choices?.[0]?.message?.tool_calls || [];
    const call = toolCalls.find((c) => c.function?.name === "evaluasi_tindakan");

    let hasil = "tidak_efektif";
    let matchedId = "";
    let alasan = "Tindakan ini tidak memberi efek berarti pada kondisi pasien saat ini.";
    if (call) {
      try {
        const args = typeof call.function.arguments === "string" ? JSON.parse(call.function.arguments) : call.function.arguments;
        hasil = ["benar", "kontraindikasi", "tidak_efektif"].includes(args?.hasil) ? args.hasil : "tidak_efektif";
        matchedId = args?.matched_id || "";
        if (args?.alasan) alasan = args.alasan;
      } catch (e) {
        console.warn(`[emergency/tindakan] malformed tool_call JSON: ${e.message}`);
      }
    }

    let item = null;
    if (hasil === "benar") {
      item = benar.find((b) => b.id === matchedId);
      if (!item) { hasil = "tidak_efektif"; } // hallucinated id — don't trust it
      else if (done.includes(item.id)) {
        // Already administered earlier this session — no further benefit.
        hasil = "tidak_efektif";
        alasan = "Tindakan ini sudah pernah dilakukan sebelumnya, tidak ada efek tambahan.";
      }
    }

    res.json({
      hasil,
      id: item ? item.id : null,
      nama: item ? item.nama : null,
      wajib: item ? !!item.wajib : false,
      efek: item ? item.efek : null,
      efekVital: item ? item.efekVital || null : null,
      alasan,
      _provider: response._provider,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Emergency treatment evaluation failed", detail: String(err.message || err) });
  }
});

module.exports = router;

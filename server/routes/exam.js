const express = require("express");
const router = express.Router();
const { chat } = require("../lib/providers");
const { loadCase } = require("../lib/caseLoader");
const { sanitizeText, isSafeSlug, MAX_QUERY_LENGTH } = require("../lib/sanitize");

/**
 * POST /api/exam/perform
 * body: { kategori, id, step: 'pf' | 'penunjang', query: string, done: string[] }
 *
 * `query` is free text like "auskultasi jantung" or "cek troponin dan EKG".
 * The model's ONLY job is to pick which predefined finding id(s) best match
 * the request (forced tool call — it cannot free-generate a clinical value).
 * The actual finding text/image is looked up deterministically from the case
 * JSON. If nothing matches well, we fall back to a canned "normal" result so
 * the AI never invents a number.
 *
 * `wajibLapor` (an instructor-set modifier on the case JSON item, only
 * meaningful when the item also has an `image`) is passed through on each
 * result so the frontend knows to withhold `temuan` and make the student
 * write their own report instead — see data/cases/_SCHEMA.md.
 */
router.post("/perform", async (req, res) => {
  try {
    const { kategori, id, step, query, done = [], forceProvider } = req.body;
    if (!kategori || !id || !step || !query) {
      return res.status(400).json({ error: "kategori, id, step, and query are required" });
    }
    if (!["pf", "penunjang"].includes(step)) {
      return res.status(400).json({ error: "step must be 'pf' or 'penunjang'" });
    }
    // Cheap regex fail-fast, same reasoning as chat.js — reject malformed
    // ids before touching the filesystem or the model.
    if (!isSafeSlug(kategori) || !isSafeSlug(id)) {
      return res.status(400).json({ error: "Invalid kategori or id" });
    }

    const cleanQuery = sanitizeText(query, { maxLength: MAX_QUERY_LENGTH });
    if (!cleanQuery) {
      return res.status(400).json({ error: "query is empty after sanitization" });
    }

    const kasus = loadCase(kategori, id);
    if (!kasus) return res.status(404).json({ error: "Case not found" });

    const list =
      step === "pf" ? kasus.groundTruth.pemeriksaanFisik : kasus.groundTruth.penunjang;
    const defaultText =
      step === "pf"
        ? kasus.groundTruth.defaultNormal.pemeriksaanFisik
        : kasus.groundTruth.defaultNormal.penunjang;
    const NO_DATA_TEXT = "Tidak ada data.";

    const catalog = list.map((item) => ({ id: item.id, nama: item.nama }));
    const doneCatalog = catalog.filter((c) => done.includes(c.id));

    // OpenAI-style tool schema — works across Groq/Cerebras/OpenRouter/NVIDIA/Ollama since
    // they all expose an OpenAI-compatible endpoint. Same idea as before:
    // force the model to pick from a fixed list, never invent findings.
    const tools = [
      {
        type: "function",
        function: {
          name: "select_findings",
          description:
            "Pilih satu atau lebih pemeriksaan dari daftar yang tersedia yang paling cocok dengan permintaan mahasiswa. Jika tidak ada yang benar-benar cocok/relevan secara klinis, kembalikan array kosong dan isi unmatched_reason.",
          parameters: {
            type: "object",
            properties: {
              matched_ids: {
                type: "array",
                items: { type: "string" },
                description: `id pemeriksaan yang cocok dengan permintaan mahasiswa. HARUS salah satu dari id berikut (jangan mengarang id lain): ${catalog.map((c) => c.id).join(", ")}. Pilih HANYA entri yang paling spesifik/sempit yang sesuai persis dengan permintaan — jangan pilih entri gabungan/lengkap kecuali mahasiswa secara eksplisit meminta hal yang luas/menyeluruh.`,
              },
              unmatched_reason: {
                type: "string",
                enum: ["not_applicable", "specific_test_not_available"],
                description:
                  "WAJIB diisi kalau matched_ids kosong (abaikan kalau matched_ids ada isinya). 'specific_test_not_available' = mahasiswa meminta pemeriksaan/tes tertentu yang bernama spesifik (mis. EKG, HbA1c, USG, foto rontgen tertentu) ATAU teknik pemeriksaan spesifik pada region yang SUDAH pernah diperiksa dengan teknik lain (mis. minta 'palpasi abdomen' padahal yang tercatat cuma 'inspeksi abdomen' sebagai entri gabungan, dan tidak ada entri terpisah untuk palpasi) — dan kasus ini TIDAK punya data terpisah untuk itu. 'not_applicable' = permintaan itu manuver rutin/umum yang wajar diasumsikan normal walau tidak didaftar terpisah di kasus ini (mis. pemeriksaan dasar yang lazim otomatis dilakukan tapi tidak spesifik/bernama tes tertentu).",
              },
            },
            required: ["matched_ids"],
          },
        },
      },
    ];

    const systemPrompt = `Kamu adalah sistem pencocokan permintaan pemeriksaan ${
      step === "pf" ? "fisik" : "penunjang"
    } dalam simulasi OSCE. Mahasiswa akan menuliskan pemeriksaan yang ingin mereka lakukan/pesan dalam bahasa bebas (boleh singkatan, boleh istilah awam). Tugasmu HANYA mencocokkan ke daftar pemeriksaan yang tersedia di kasus ini — jangan pernah membuat hasil pemeriksaan sendiri. Kamu WAJIB memanggil fungsi select_findings untuk menjawab, jangan menjawab dengan teks biasa.

Daftar pemeriksaan yang tersedia di kasus ini:
${catalog.map((c) => `- ${c.id}: ${c.nama}`).join("\n")}
${
  doneCatalog.length
    ? `\nPemeriksaan yang SUDAH PERNAH diambil mahasiswa sebelumnya di sesi ini (jangan asal kembalikan id yang sama ini lagi untuk permintaan yang jelas-jelas menanyakan TEKNIK/KOMPONEN BERBEDA pada region yang sama — lihat aturan unmatched_reason di atas):\n${doneCatalog.map((c) => `- ${c.id}: ${c.nama}`).join("\n")}`
    : ""
}

Cocokkan secara semantik/klinis (misalnya "denyut jantung" = nadi, "dada difoto" = foto thorax, "jantung didengerin" = auskultasi jantung). Jika permintaan mahasiswa relevan secara klinis tapi tidak ada di daftar (misalnya organ/tempat yang tidak berkaitan dengan kasus ini), kembalikan array kosong.

PENTING SOAL GRANULARITAS — mahasiswa OSCE bisa meminta pemeriksaan secara SEMPIT (satu nilai spesifik, mis. "GDS saja", "tensi aja", "nadi") atau LUAS (satu panel/profil lengkap, mis. "cek gula darah", "tanda-tanda vital", "profil lipid"). Kalau di daftar ADA entri sempit yang cocok persis DAN entri luas yang mencakupnya, pilih HANYA entri paling sempit yang sesuai permintaan mahasiswa — JANGAN kembalikan entri luas kecuali mahasiswa secara eksplisit meminta hal yang luas/lengkap/menyeluruh. Kalau di daftar HANYA ada satu entri gabungan (tidak ada versi sempitnya), boleh kembalikan entri gabungan itu apa adanya.`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: cleanQuery },
    ];

    const response = await chat({ messages, tools, max_tokens: 300, forceProvider });

    const toolCalls = response.choices?.[0]?.message?.tool_calls || [];
    const call = toolCalls.find((c) => c.function?.name === "select_findings");

    let matchedIds = [];
    let unmatchedReason = null;
    if (call) {
      const rawArgs = call.function.arguments;
      // OpenAI-style APIs return arguments as a JSON string. Weaker/free
      // models occasionally return truncated or malformed JSON here
      // (especially if the reply got cut off by max_tokens, or the model
      // just isn't great at strict tool-calling). That used to throw all
      // the way out to the outer catch and surface as a generic
      // "Exam matching failed" with no useful detail — instead, treat a
      // parse failure the same as "the model didn't return a match": fall
      // back to the case's default text below, and log the raw (truncated)
      // output so it's visible in the server logs for debugging which
      // provider/model is flaking here.
      try {
        const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
        matchedIds = args?.matched_ids || [];
        unmatchedReason = args?.unmatched_reason || null;
      } catch (parseErr) {
        console.warn(
          `[exam/perform] malformed tool_call JSON from provider "${response._provider}": ${parseErr.message}. Raw arguments: ${String(rawArgs).slice(0, 300)}`
        );
      }
    }

    if (matchedIds.length === 0) {
      // Only fall back to the case's generic "dalam batas normal" text for
      // routine/generic maneuvers. A named/specific test the model flagged
      // as genuinely unavailable in this case should say so honestly
      // instead of quietly presenting a fabricated "normal" result.
      const text = unmatchedReason === "specific_test_not_available" ? NO_DATA_TEXT : defaultText;
      return res.json({
        matched: [],
        results: [{ nama: cleanQuery, temuan: text, signifikan: false, image: null }],
      });
    }

    const results = matchedIds
      .map((mid) => list.find((item) => item.id === mid))
      .filter(Boolean)
      .map((item) => ({
        id: item.id,
        nama: item.nama,
        temuan: item.temuan,
        signifikan: item.signifikan,
        image: item.image
          ? `/data/images/${kategori}/${id}/${item.image}`
          : null,
        // Instructor-set modifier ("!" in the docx source) — only meaningful
        // when an image is also present. The frontend uses this to withhold
        // `temuan` and ask the student to report the image finding
        // themselves instead; the value is looked up deterministically here
        // exactly like `temuan`, never invented by the model.
        wajibLapor: !!(item.wajibLapor && item.image),
        alreadyDone: done.includes(item.id),
      }));

    // Defensive: if the model returned id(s) that don't actually exist in
    // this case's catalog (shouldn't happen given the enum constraint, but
    // not every provider enforces it strictly), don't silently return an
    // empty results array — the query would just vanish from the student's
    // view with zero feedback. Fall back to the same default text path.
    if (results.length === 0) {
      return res.json({
        matched: [],
        results: [{ nama: cleanQuery, temuan: defaultText, signifikan: false, image: null }],
      });
    }

    res.json({ matched: matchedIds, results, _provider: response._provider });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Exam matching failed", detail: String(err.message || err) });
  }
});

module.exports = router;

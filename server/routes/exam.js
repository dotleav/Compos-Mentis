const express = require("express");
const router = express.Router();
const { chat } = require("../lib/providers");
const { loadCase } = require("../lib/caseLoader");

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
 */
router.post("/perform", async (req, res) => {
  try {
    const { kategori, id, step, query, done = [] } = req.body;
    if (!kategori || !id || !step || !query) {
      return res.status(400).json({ error: "kategori, id, step, and query are required" });
    }
    if (!["pf", "penunjang"].includes(step)) {
      return res.status(400).json({ error: "step must be 'pf' or 'penunjang'" });
    }

    const kasus = loadCase(kategori, id);
    if (!kasus) return res.status(404).json({ error: "Case not found" });

    const list =
      step === "pf" ? kasus.groundTruth.pemeriksaanFisik : kasus.groundTruth.penunjang;
    const defaultText =
      step === "pf"
        ? kasus.groundTruth.defaultNormal.pemeriksaanFisik
        : kasus.groundTruth.defaultNormal.penunjang;

    const catalog = list.map((item) => ({ id: item.id, nama: item.nama }));

    // OpenAI-style tool schema — works across Groq/Gemini/NVIDIA/Ollama since
    // they all expose an OpenAI-compatible endpoint. Same idea as before:
    // force the model to pick from a fixed list, never invent findings.
    const tools = [
      {
        type: "function",
        function: {
          name: "select_findings",
          description:
            "Pilih satu atau lebih pemeriksaan dari daftar yang tersedia yang paling cocok dengan permintaan mahasiswa. Jika tidak ada yang benar-benar cocok/relevan secara klinis, kembalikan array kosong.",
          parameters: {
            type: "object",
            properties: {
              matched_ids: {
                type: "array",
                items: { type: "string", enum: catalog.map((c) => c.id) },
                description: "id pemeriksaan yang cocok dengan permintaan mahasiswa, dari daftar yang diberikan",
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

Cocokkan secara semantik/klinis (misalnya "denyut jantung" = nadi, "dada difoto" = foto thorax, "jantung didengerin" = auskultasi jantung). Jika permintaan mahasiswa relevan secara klinis tapi tidak ada di daftar (misalnya organ/tempat yang tidak berkaitan dengan kasus ini), kembalikan array kosong.`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: query },
    ];

    const response = await chat({ messages, tools });

    const toolCalls = response.choices?.[0]?.message?.tool_calls || [];
    const call = toolCalls.find((c) => c.function?.name === "select_findings");

    let matchedIds = [];
    if (call) {
      const rawArgs = call.function.arguments;
      // OpenAI-style APIs return arguments as a JSON string; parse defensively.
      const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
      matchedIds = args?.matched_ids || [];
    }

    if (matchedIds.length === 0) {
      return res.json({
        matched: [],
        results: [{ nama: query, temuan: defaultText, signifikan: false, image: null }],
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
        alreadyDone: done.includes(item.id),
      }));

    res.json({ matched: matchedIds, results, _provider: response._provider });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Exam matching failed", detail: String(err.message || err) });
  }
});

module.exports = router;

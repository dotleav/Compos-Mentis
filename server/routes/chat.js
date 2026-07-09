const express = require("express");
const router = express.Router();
const { client, MODEL } = require("../lib/anthropic");
const { loadCase } = require("../lib/caseLoader");

/**
 * POST /api/chat/anamnesis
 * body: { kategori, id, history: [{role:'user'|'assistant', content:string}], message: string }
 *
 * The model plays the PATIENT. It only knows what's in groundTruth.riwayat +
 * identitas + keluhanUtama. It must stay in character, answer in Indonesian,
 * never reveal a diagnosis, and never volunteer info that wasn't asked.
 */
router.post("/anamnesis", async (req, res) => {
  try {
    const { kategori, id, history = [], message } = req.body;
    if (!kategori || !id || !message) {
      return res.status(400).json({ error: "kategori, id, and message are required" });
    }

    const kasus = loadCase(kategori, id);
    if (!kasus) return res.status(404).json({ error: "Case not found" });

    const { identitas, keluhanUtama, groundTruth } = kasus;
    const { riwayat } = groundTruth;

    const systemPrompt = `Kamu berperan sebagai PASIEN dalam simulasi OSCE kedokteran. Jangan pernah keluar dari peran ini, dan jangan pernah menyebutkan bahwa kamu adalah AI.

IDENTITAS PASIEN:
- Nama: ${identitas.nama}, Usia: ${identitas.usia} tahun, Pekerjaan: ${identitas.pekerjaan}
- Keluhan utama: ${keluhanUtama}

RIWAYAT YANG KAMU KETAHUI (gunakan HANYA ini sebagai fakta medis kamu; jangan mengarang temuan klinis baru):
- Riwayat Penyakit Sekarang (RPS): ${riwayat.rps.join("; ")}
- Riwayat Penyakit Dahulu (RPD): ${riwayat.rpd}
- Riwayat Penyakit Keluarga (RPK): ${riwayat.rpk}
- Gaya hidup: ${riwayat.lifestyle.join("; ")}

ATURAN PERAN:
1. Jawab sebagai orang awam, bukan tenaga medis — gunakan bahasa sehari-hari, bukan istilah medis.
2. Hanya ceritakan informasi yang DITANYAKAN. Jangan membocorkan seluruh riwayat sekaligus di jawaban pertama.
3. Jika ditanya sesuatu yang tidak ada dalam daftar riwayat di atas, jawab secara wajar dan konsisten dengan kondisi ini (biasanya "tidak ada"/"tidak pernah"), TANPA menciptakan temuan klinis besar baru yang bertentangan dengan kasus.
4. Tunjukkan emosi/kondisi yang wajar sesuai keluhan (misalnya menahan nyeri, cemas), tapi jangan berlebihan.
5. Jangan pernah menyebutkan istilah diagnosis (misalnya jangan bilang "sepertinya saya kena serangan jantung").
6. Jika mahasiswa bertanya hal di luar konteks anamnesis (basa-basi ringan itu wajar dan boleh dijawab singkat, tapi jangan menyimpang jauh).
7. Jawaban singkat dan natural, seperti percakapan dokter-pasien sungguhan, 1-4 kalimat.`;

    const messages = [
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: message },
    ];

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: systemPrompt,
      messages,
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    res.json({ reply: text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Chat failed", detail: String(err.message || err) });
  }
});

module.exports = router;

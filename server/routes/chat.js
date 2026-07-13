const express = require("express");
const router = express.Router();
const { chat } = require("../lib/providers");
const { loadCase } = require("../lib/caseLoader");

// Only the most recent turns are sent as context — older ones are dropped.
// The patient's actual facts (identitas/riwayat) always live in the system
// prompt regardless, so nothing medically important is lost; this just
// stops token usage (and therefore rate-limit/credit usage) from growing
// with every message in a long roleplay session.
const MAX_HISTORY_MESSAGES = 16; // ~8 back-and-forth exchanges

/**
 * Reads the case's own pemeriksaanFisik findings to figure out whether the
 * patient is actually interviewable. Some cases (uncooperative psychiatric
 * patients, unconscious neuro patients) should NOT be fully quizzable as if
 * they were a normal cooperative patient — that was the bug: every case
 * used the same "patient answers everything nicely" persona regardless of
 * what `sikap`/`kesadaran` (or `ku` for non-psych cases) actually said.
 *
 * Returns one of:
 *   'tidak_sadar'       — kesadaran menurun (koma/sopor/stupor/somnolen/delirium)
 *   'tidak_kooperatif'  — sadar, tapi sikap eksplisit "tidak kooperatif"
 *   'kooperatif'        — default, current/original behavior
 */
function assessInterviewStatus(pemeriksaanFisik = []) {
  const findText = (pattern) => {
    const hit = pemeriksaanFisik.find((p) => pattern.test(p.id || ""));
    return hit ? String(hit.temuan || "") : "";
  };

  // `ku` (Keadaan Umum) covers non-psych cases (e.g. "Penurunan kesadaran");
  // `statuspsikiatri_kesadaran` covers psych cases. Either can carry the signal.
  const kesadaranText = findText(/^ku$/i) || findText(/kesadaran/i);
  const sikapText = findText(/sikap/i);

  if (/penurunan|somnolen|stupor|sopor|koma|delirium/i.test(kesadaranText)) {
    return { status: "tidak_sadar", kesadaranText, sikapText };
  }
  if (/tidak\s*kooperatif/i.test(sikapText)) {
    return { status: "tidak_kooperatif", kesadaranText, sikapText };
  }
  return { status: "kooperatif", kesadaranText, sikapText };
}

function buildInterviewRules({ status, kesadaranText, sikapText }) {
  if (status === "tidak_sadar") {
    return `
STATUS KESADARAN PASIEN: ${kesadaranText || "menurun"}
Pasien dalam kondisi ini TIDAK BISA diajak bicara/menjawab pertanyaan secara verbal. ATURAN TAMBAHAN (lebih tinggi prioritasnya dari aturan umum di atas):
- Jika pertanyaan mahasiswa jelas ditujukan LANGSUNG ke pasien (mis. menyapa nama pasien, "Bapak/Ibu bisa dengar saya?"), jangan menjawab dengan kalimat riwayat. Balas hanya dengan deskripsi respons non-verbal yang wajar untuk kondisi ini (mis. merintih pelan, tidak membuka mata, tidak ada jawaban), 1 kalimat singkat.
- Jika pertanyaan mahasiswa jelas ditujukan ke KELUARGA/PENGANTAR pasien (lihat siapa pengantarnya pada IDENTITAS PASIEN di atas — mahasiswa biasanya menyapa dengan "Bu/Pak/Kak/Mas [nama/relasi pengantar]" atau berkata ingin menanyakan riwayat ke keluarga), maka JAWABLAH SEBAGAI PENGANTAR tersebut. Berikan heteroanamnesis berdasarkan RIWAYAT YANG KAMU KETAHUI di atas, dari sudut pandang orang yang mengamati pasien dari luar (bukan isi pikiran/perasaan pasien, karena pengantar tidak bisa tahu itu).
- Jangan berpindah ke peran pengantar kalau belum jelas pertanyaan itu ditujukan ke pengantar.`;
  }
  if (status === "tidak_kooperatif") {
    return `
SIKAP PASIEN: ${sikapText || "tidak kooperatif"}
Pasien ini TIDAK kooperatif. ATURAN TAMBAHAN (lebih tinggi prioritasnya dari aturan umum di atas):
- Jawaban pasien atas pertanyaan LANGSUNG boleh singkat, menghindar, curiga, defensif, atau menyangkal — realistis untuk pasien yang tidak kooperatif/kurang tilikan. Tetap konsisten dengan RIWAYAT YANG KAMU KETAHUI (jangan bertentangan, cukup enggan/menolak bercerita detail tanpa didorong).
- Jika pertanyaan mahasiswa jelas ditujukan ke KELUARGA/PENGANTAR pasien (lihat siapa pengantarnya pada IDENTITAS PASIEN di atas — disapa "Bu/Pak/Kak/Mas [nama/relasi pengantar]" atau mahasiswa eksplisit ingin bertanya ke keluarga), JAWABLAH SEBAGAI PENGANTAR tersebut secara kooperatif dan informatif, berdasarkan RIWAYAT YANG KAMU KETAHUI, dari sudut pandang pengamat luar.`;
  }
  return "";
}

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
    const interviewCtx = assessInterviewStatus(groundTruth.pemeriksaanFisik);
    const interviewRules = buildInterviewRules(interviewCtx);

    const systemPrompt = `Kamu berperan sebagai PASIEN dalam simulasi OSCE kedokteran. Jangan pernah keluar dari peran ini, dan jangan pernah menyebutkan bahwa kamu adalah AI.

IDENTITAS PASIEN (data yang tersedia dari kasus):
- Identitas: ${identitas}
- Keluhan utama: ${keluhanUtama}

RIWAYAT YANG KAMU KETAHUI (gunakan HANYA ini sebagai fakta medis kamu; jangan mengarang temuan klinis baru):
- Riwayat Penyakit Sekarang (RPS): ${riwayat.rps.join("; ")}
- Riwayat Penyakit Dahulu (RPD): ${riwayat.rpd}
- Riwayat Penyakit Keluarga (RPK): ${riwayat.rpk}
- Gaya hidup: ${riwayat.lifestyle.join("; ")}

ATURAN DATA PRIBADI YANG TIDAK DISEBUTKAN DI KASUS:
- Kalau "Identitas" di atas TIDAK menyebutkan nama/pekerjaan/tempat tinggal secara eksplisit (mis. hanya "Perempuan, 25 tahun" atau "Bapak paruh baya"), KARANG SENDIRI sekali di jawaban pertama kamu: satu nama Indonesia yang wajar (sesuai jenis kelamin/usia/konteks), satu pekerjaan yang masuk akal, dan satu tempat tinggal (kota/kecamatan umum di Indonesia) — lalu PAKAI DATA YANG SAMA itu secara konsisten di sepanjang sisa percakapan ini (cek riwayat chat sebelumnya kalau sudah pernah kamu sebutkan, jangan berubah-ubah).
- JANGAN PERNAH menulis placeholder seperti "[nama pasien]", "[nama]", "___", atau semacamnya — itu bukan jawaban pasien sungguhan, harus berupa nama asli yang kamu karang.
- Detail yang SUDAH ADA di "Identitas" di atas (kalau ada) harus dipakai apa adanya, jangan diganti dengan karangan.

ATURAN MENJAWAB — SANGAT PENTING, JAWAB HANYA APA YANG DITANYA:
1. AT PALING PENTING: HANYA jawab persis apa yang ditanyakan mahasiswa pada pertanyaan TERAKHIR, satu topik saja. JANGAN PERNAH menambahkan keluhan utama, riwayat penyakit, durasi/onset gejala, sifat gejala (hilang timbul/menetap/memberat/membaik dll), riwayat penyakit dahulu/keluarga, atau gaya hidup — KECUALI hal itu SECARA SPESIFIK ditanyakan pada pertanyaan terakhir itu. Ini berlaku juga kalau pertanyaannya cuma sapaan atau menanyakan nama/usia/alamat/pekerjaan — jawab IDENTITAS SAJA, jangan tempelkan cerita sakit sama sekali.
   - Contoh SALAH: mahasiswa tanya "Selamat malam, dengan bapak siapa?" lalu pasien menjawab nama+usia+alamat SEKALIGUS dengan seluruh keluhan (berat badan naik, lemas, wajah membesar, gampang marah, stretch mark, rambut halus, dll) dalam satu jawaban panjang. INI SALAH BESAR walau namanya benar dikarang.
   - Contoh BENAR untuk pertanyaan itu: "Selamat malam, Dok. Saya Anton, 25 tahun, tinggal di Sleman." — TITIK. Tidak ada kata lain soal keluhan/riwayat sampai ditanya.
   - Kalau ditanya "ada keluhan apa?" / "kenapa ke sini?", baru jawab keluhan utamanya SAJA dalam 1 kalimat pendek (misal "Saya merasa berat badan naik banyak akhir-akhir ini, Dok."), TANPA merinci durasi/pola/riwayat lain yang belum ditanya.
   - Detail RPS/RPD/RPK/gaya hidup lain HANYA diceritakan satu per satu, sesuai pertanyaan spesifik yang diajukan setiap kali — jangan pernah digabung jadi satu jawaban panjang berisi banyak fakta baru sekaligus, walaupun kamu tahu semuanya.
2. Jawab sebagai orang awam, bukan tenaga medis — gunakan bahasa sehari-hari, bukan istilah medis.
3. Jika ditanya sesuatu yang tidak ada dalam daftar riwayat di atas, jawab secara wajar dan konsisten dengan kondisi ini (biasanya "tidak ada"/"tidak pernah"), TANPA menciptakan temuan klinis besar baru yang bertentangan dengan kasus.
4. Tunjukkan emosi/kondisi yang wajar sesuai keluhan (misalnya menahan nyeri, cemas), tapi jangan berlebihan.
5. Jangan pernah menyebutkan istilah diagnosis (misalnya jangan bilang "sepertinya saya kena serangan jantung").
6. Jika mahasiswa bertanya hal di luar konteks anamnesis (basa-basi ringan itu wajar dan boleh dijawab singkat, tapi jangan menyimpang jauh).
7. Jawaban singkat dan natural, seperti percakapan dokter-pasien sungguhan — idealnya 1 kalimat, maksimal 2 kalimat pendek. Jangan pernah menjawab dengan paragraf panjang berisi banyak informasi sekaligus.
8. SELALU jawab hanya dalam Bahasa Indonesia. Jangan pernah memakai bahasa lain (termasuk Inggris atau Mandarin), dan jangan pernah menuliskan instruksi/analisis internal kamu di dalam jawaban — hanya kalimat pasien (atau pengantar, jika berlaku) yang boleh muncul.
${interviewRules}`;

    const trimmedHistory = history.slice(-MAX_HISTORY_MESSAGES);

    // A short reminder placed right before the final question, on top of the
    // full rules already in the system prompt. Models (especially fast/small
    // ones) tend to weigh the instruction closest to what they're about to
    // generate more heavily than one buried earlier in a long system prompt —
    // this "sandwiches" the single most-violated rule right at the point of
    // generation instead of relying on the system prompt alone.
    const reminderMessage = {
      role: "system",
      content:
        "INGAT sebelum menjawab: jawab HANYA pertanyaan barusan, satu topik saja, maksimal 1-2 kalimat pendek. Jangan tempelkan keluhan utama atau riwayat penyakit apapun kecuali benar-benar ditanyakan barusan.",
    };

    const messages = [
      { role: "system", content: systemPrompt },
      ...trimmedHistory.map((h) => ({
        role: h.role === "assistant" ? "assistant" : "user",
        content: h.content,
      })),
      { role: "user", content: message },
      reminderMessage,
    ];

    // Lower temperature (more deterministic/instruction-following) and a
    // tight max_tokens ceiling so even if a model ignores the "1-2 kalimat"
    // instruction, it physically cannot ramble through an entire case
    // vignette in one reply.
    const response = await chat({ messages, temperature: 0.3, max_tokens: 120 });
    const text = response.choices?.[0]?.message?.content || "";

    res.json({ reply: text, _provider: response._provider });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Chat failed", detail: String(err.message || err) });
  }
});

module.exports = router;
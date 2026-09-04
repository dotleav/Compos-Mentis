const express = require("express");
const router = express.Router();
const { chat } = require("../lib/providers");
const { loadCase } = require("../lib/caseLoader");
const { sanitizeText, sanitizeHistory, isSafeSlug, MAX_MESSAGE_LENGTH } = require("../lib/sanitize");
const { estimateTokens, fitHistoryToBudget } = require("../lib/contextWindow");

// History is no longer capped at a fixed message count. It's fitted to a
// TOKEN BUDGET instead (see lib/contextWindow.js) — short exchanges keep
// more real turns of memory, long/verbose ones get trimmed harder, but the
// request always stays inside a predictable token ceiling. The patient's
// actual facts (identitas/riwayat) always live in the system prompt
// regardless, so nothing medically important is lost either way.
// Kept comfortably under Ollama's num_ctx=8192 (see providers.js) so our
// own budget is never the thing doing the truncating.
const MAX_CONTEXT_TOKENS = 5000; // total budget: system prompt + history + new message + reply
const REPLY_RESERVE_TOKENS = 250; // ~ max_tokens: 120 reply + headroom

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
 * Detects whether this case involves a pediatric patient (usia < 18).
 * Parses `identitas` whether it is an object ({ usia: number }) or a
 * free-form string (e.g. "Andre, 8 tahun" / "Somat, 4 tahun, dibawa ibunya (Bella)").
 *
 * Returns:
 *   { isPediatric: false }                         — adult case, no change
 *   { isPediatric: true, usia, namaAnak,
 *     pengantarHint }                              — pediatric; pengantarHint may be
 *                                                    a string like "ibunya (Bella)"
 *                                                    extracted from identitas, or null.
 */
function detectPediatricCase(identitas) {
  let usia = null;
  let namaAnak = null;
  let pengantarHint = null;

  if (typeof identitas === "object" && identitas !== null) {
    usia = Number(identitas.usia);
    namaAnak = identitas.nama || null;
  } else if (typeof identitas === "string") {
    // Extract usia from strings like "Andre, 8 tahun" or "Anak laki-laki, 15 tahun"
    const usiaMatch = identitas.match(/(\d+)\s*tahun/i);
    if (usiaMatch) usia = parseInt(usiaMatch[1], 10);

    // Extract nama — typically the first token before the comma, unless it
    // starts with a generic label like "Anak", "Laki-laki", "Perempuan"
    const parts = identitas.split(",").map((s) => s.trim());
    if (parts.length > 0 && !/^(anak|laki-laki|perempuan|bayi|balita)/i.test(parts[0])) {
      namaAnak = parts[0];
    }

    // Extract pengantar hint from patterns like "dibawa ibunya (Bella)" or
    // "ditemani ayahnya" or "oleh orang tuanya"
    const pengantarMatch = identitas.match(
      /dibawa\s+([\w\s()]+?)(?:,|$)|ditemani\s+([\w\s()]+?)(?:,|$)|oleh\s+([\w\s()]+?)(?:,|$)/i
    );
    if (pengantarMatch) {
      pengantarHint = (pengantarMatch[1] || pengantarMatch[2] || pengantarMatch[3] || "").trim();
    }
  }

  if (usia !== null && !isNaN(usia) && usia < 18) {
    return { isPediatric: true, usia, namaAnak, pengantarHint };
  }
  return { isPediatric: false };
}

/**
 * Pool of guardian personas used in pediatric cases.
 * Rotated per-request so we don't always land on the same name.
 * Each entry has: relasi (relation label), panggilan (how the doctor might
 * address them), and nama (a plausible Indonesian name for that role).
 */
const GUARDIAN_PERSONAS = [
  { relasi: "ibu", panggilan: "Bu", nama: "Sri" },
  { relasi: "ibu", panggilan: "Bu", nama: "Ratna" },
  { relasi: "ibu", panggilan: "Bu", nama: "Dewi" },
  { relasi: "ayah", panggilan: "Pak", nama: "Budi" },
  { relasi: "ayah", panggilan: "Pak", nama: "Hendra" },
  { relasi: "nenek", panggilan: "Nek", nama: "Sari" },
  { relasi: "kakek", panggilan: "Kek", nama: "Marno" },
];
function randomGuardian() {
  return GUARDIAN_PERSONAS[Math.floor(Math.random() * GUARDIAN_PERSONAS.length)];
}

/**
 * Builds the system prompt for a pediatric case.
 * The AI plays the GUARDIAN (orang tua/wali), NOT the child.
 *
 * Key behaviours enforced:
 *  1. Opening "Ada keluhan apa?" → redirect that the child is the patient,
 *     briefly introduce the child, then state the chief complaint.
 *  2. Recall/uncertainty: guardian tries to remember details, uses phrases
 *     like "kalau tidak salah", "saya kurang ingat persisnya", "kayaknya",
 *     accompanied by pauses/thinking gestures (in italics) to simulate
 *     realistic proxy reporting.
 *  3. Third-person perspective: never says "saya merasa..." for symptoms;
 *     uses "anak saya", "si kecil", the child's name.
 *  4. All other existing rules (only answer what's asked, no diagnosis
 *     disclosure, stay in character, Indonesian only) are preserved.
 */
function buildPediatricSystemPrompt({ identitas, keluhanUtama, riwayat, interviewRules, ex, pediatricCtx }) {
  const { usia, namaAnak, pengantarHint } = pediatricCtx;

  // Resolve guardian identity:
  //  - If identitas already names the pengantar (e.g. "dibawa ibunya (Bella)"),
  //    use that hint as the relasi/nama label.
  //  - Otherwise, pick a random guardian persona.
  let guardian;
  if (pengantarHint) {
    // e.g. "ibunya (Bella)" — extract relasi and possibly a name in parens
    const relasiMatch = pengantarHint.match(/^(ibu|ayah|nenek|kakek|om|tante|kakak|paman|bibi)\w*/i);
    const namaMatch = pengantarHint.match(/\(([^)]+)\)/);
    guardian = {
      relasi: relasiMatch ? relasiMatch[1].toLowerCase() : "orang tua",
      panggilan: relasiMatch
        ? /ibu|nenek|tante|bibi/i.test(relasiMatch[1]) ? "Bu" : "Pak"
        : "Pak/Bu",
      nama: namaMatch ? namaMatch[1] : null,
    };
  } else {
    guardian = randomGuardian();
  }

  // Determine how to refer to the child throughout
  const sebutanAnak = namaAnak || (usia <= 5 ? "si kecil" : "anak saya");
  const genderHint = typeof identitas === "string"
    ? (/perempuan|wanita/i.test(identitas) ? "perempuan" : /laki-laki|pria/i.test(identitas) ? "laki-laki" : null)
    : null;
  const sebutanPronoun = genderHint === "perempuan" ? "dia (perempuan)" : genderHint === "laki-laki" ? "dia (laki-laki)" : "dia";

  // Guardian name/identity blurb for prompt
  const guardianNama = guardian.nama ? `${guardian.relasi}nya (${guardian.nama})` : guardian.relasi;
  const guardianSelf = guardian.nama
    ? `Kamu adalah ${guardian.relasi}nya (nama kamu: ${guardian.nama})`
    : `Kamu adalah ${guardian.relasi}nya`;

  return `Kamu berperan sebagai ORANG TUA/WALI PASIEN dalam simulasi OSCE kedokteran. Pasien yang kamu bawa adalah seorang anak berusia ${usia} tahun. Kamu yang membawa dan mendampingi anak ini ke dokter. Jangan pernah keluar dari peran ini, dan jangan pernah menyebutkan bahwa kamu adalah AI.

${guardianSelf}. Anakmu adalah ${sebutanAnak}${namaAnak ? `, ${usia} tahun` : `, ${usia} tahun`}.

IDENTITAS PASIEN ANAK (data dari kasus):
- Identitas anak: ${identitas}
- Keluhan utama yang kamu bawa ke dokter: ${keluhanUtama}

RIWAYAT YANG KAMU KETAHUI (sebagai orang tua/wali — kamu tahu ini karena mengamati anak dari luar, BUKAN dari dalam kepala/perasaan anak):
- Riwayat Penyakit Sekarang (RPS): ${riwayat.rps.join("; ")}
- Riwayat Penyakit Dahulu (RPD): ${riwayat.rpd}
- Riwayat Penyakit Keluarga (RPK): ${riwayat.rpk}
- Gaya hidup / kebiasaan anak: ${riwayat.lifestyle.join("; ")}

ATURAN DATA PRIBADI YANG TIDAK DISEBUTKAN DI KASUS:
- Kalau nama kamu (orang tua/wali) tidak disebutkan dalam data kasus, karang satu nama Indonesia yang wajar sesuai peranmu (${guardianNama}) — PAKAI KONSISTEN sepanjang percakapan ini.
- Kalau nama anak tidak disebutkan, karang satu nama anak Indonesia yang wajar — PAKAI KONSISTEN.
- Jangan pernah tulis placeholder seperti "[nama]", "___", dll — harus nama asli yang kamu karang.
- Detail yang SUDAH ADA di "Identitas anak" di atas harus dipakai apa adanya.
- SANGAT PENTING — jangan bocorkan nama/pekerjaan/alamat/pendamping sukarela di awal. Ungkap satu per satu hanya saat ditanya.

ATURAN KHUSUS PASIEN ANAK — SANGAT PENTING:

PERTAMA KALI DITANYA "Ada keluhan apa?" / "Kenapa ke sini?" / KALIMAT PEMBUKA PERTAMA DOKTER:
Kamu WAJIB melakukan 3 hal ini SEKALIGUS dalam satu respons pertama itu:
1. Alihkan bahwa yang sakit adalah anakmu, bukan kamu (mis. "Oh, bukan saya, Dok — anak saya yang sakit.")
2. Perkenalkan anak secara singkat (nama dan usia jika tahu, atau cukup "anak saya yang [usia] tahun").
3. Sebutkan keluhan utama anak dalam 1 kalimat pendek.
Contoh: "Oh, bukan saya yang sakit, Dok — anak saya, ${sebutanAnak}, ${usia} tahun. Dia sudah demam beberapa hari ini."
JANGAN langsung menjawab keluhan tanpa dulu menyebutkan bahwa yang sakit adalah sang anak.

GAYA BERBICARA SEBAGAI ORANG TUA/WALI — RECALL & KETIDAKPASTIAN:
Kamu bukan tenaga medis. Kamu mengamati dan mencoba mengingat kondisi anakmu. Tunjukkan ini secara alami:
- Gunakan frasa recall/ragu seperti: "kalau tidak salah...", "kayaknya...", "saya kurang ingat persis...", "sepertinya iya...", "duh, sebentar saya pikir-pikir dulu..."
- Sesekali tambahkan gestur berpikir dalam kurung miring sebelum atau di tengah jawaban, mis: *(mengingat-ingat)*, *(mengerutkan dahi)*, *(menoleh ke anak sebentar)*, *(garuk kepala)*.
- Untuk pertanyaan yang kamu tahu pasti (mis. kapan mulai, frekuensi yang kamu amati langsung): jawab lebih tegas.
- Untuk pertanyaan tentang detail internal anak (perasaan anak, skala nyeri versi anak, apa yang dirasakan anak dari dalam): akui bahwa kamu hanya tahu dari apa yang terlihat atau diceritakan anak.
- JANGAN berlebihan ragu di setiap kalimat — gunakan ragu hanya saat memang realistis tidak ingat/tidak tahu persis.

ATURAN SUDUT PANDANG:
- JANGAN PERNAH berkata "saya merasa...", "saya sakit...", "saya nyeri..." untuk kondisi anak — kamu bukan yang sakit.
- Selalu gunakan sudut pandang pengamat: "anak saya", "${sebutanAnak}", "dia", "si kecil".
- Kalau ditanya tentang kondisi kamu sendiri (bukan anak), jawab sesuai kondisi orang tua normal.

ATURAN MENJAWAB — SAMA SEPERTI SESI NORMAL, BERLAKU JUGA DI SINI:
1. HANYA jawab persis apa yang ditanyakan mahasiswa, satu topik saja. Jangan menambahkan informasi yang belum ditanyakan.
1a. PERTANYAAN YA/TIDAK: WAJIB jawab "Iya"/"Tidak" eksplisit dulu. Boleh tambah elaborasi singkat setelahnya. Boleh — tidak wajib — lanjutkan dengan SATU keluhan lain yang ada di RPS tapi belum pernah disebut, seolah baru teringat.
1b. PERTANYAAN MULTI-BAGIAN: jawab SEMUA bagian yang ditanya, tidak kurang tidak lebih.
2. Bahasa awam, bukan istilah medis. Bahasa sehari-hari orang tua Indonesia.
3. Kalau ditanya sesuatu yang tidak ada di riwayat, jawab "tidak ada" / "tidak pernah" secara wajar.
4. Tunjukkan ekspresi khawatir/cemas sebagai orang tua yang wajar — tidak berlebihan.
5. Jangan pernah sebut istilah diagnosis.
6. Basa-basi ringan boleh dijawab singkat, jangan menyimpang jauh.
7. Jawaban singkat dan natural — idealnya 1-2 kalimat, maksimal 3 kalimat. Jangan paragraf panjang.
8. SELALU jawab dalam Bahasa Indonesia. Jangan tulis instruksi/analisis internal — hanya kalimat orang tua yang boleh muncul.
${interviewRules}`;
}

// Pool of example identities used ONLY to demonstrate the answer FORMAT in
// the system prompt below. Rotated per-request (not fixed to one name) —
// otherwise the model tends to copy the literal example verbatim instead
// of inventing its own identity, e.g. every uninstructed case ending up
// with a patient named "Anton, 25 tahun, Sleman" because that exact string
// sat in the prompt every single time.
const EXAMPLE_IDENTITIES = [
  { nama: "Bambang", usia: 42, kota: "Bantul" },
  { nama: "Siti", usia: 31, kota: "Depok" },
  { nama: "Made", usia: 58, kota: "Denpasar" },
  { nama: "Yuni", usia: 25, kota: "Sleman" },
  { nama: "Hendra", usia: 47, kota: "Cimahi" },
  { nama: "Ratna", usia: 36, kota: "Malang" },
  { nama: "Fajar", usia: 29, kota: "Bekasi" },
  { nama: "Dewi", usia: 52, kota: "Surabaya" },
];
function randomExampleIdentity() {
  return EXAMPLE_IDENTITIES[Math.floor(Math.random() * EXAMPLE_IDENTITIES.length)];
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
    const { kategori, id, history = [], message, forceProvider } = req.body;
    if (!kategori || !id || !message) {
      return res.status(400).json({ error: "kategori, id, and message are required" });
    }
    // Cheap regex fail-fast: reject malformed ids before any file I/O or
    // model call is attempted.
    if (!isSafeSlug(kategori) || !isSafeSlug(id)) {
      return res.status(400).json({ error: "Invalid kategori or id" });
    }

    // Sanitize free-text fields once, up front — everything built from here
    // on (system prompt reminder, message array) uses the cleaned values.
    const cleanMessage = sanitizeText(message, { maxLength: MAX_MESSAGE_LENGTH });
    if (!cleanMessage) {
      return res.status(400).json({ error: "message is empty after sanitization" });
    }
    const cleanHistory = sanitizeHistory(history, { maxLength: MAX_MESSAGE_LENGTH });

    const kasus = loadCase(kategori, id);
    if (!kasus) return res.status(404).json({ error: "Case not found" });

    const { identitas, keluhanUtama, groundTruth } = kasus;
    const { riwayat } = groundTruth;
    const interviewCtx = assessInterviewStatus(groundTruth.pemeriksaanFisik);
    const interviewRules = buildInterviewRules(interviewCtx);
    const ex = randomExampleIdentity();

    // --- PEDIATRIC DETECTION ---
    // If the patient is under 18, the AI plays the guardian (orang tua/wali),
    // not the patient themselves. All other logic (context window, reminders,
    // provider routing) stays identical.
    const pediatricCtx = detectPediatricCase(identitas);

    let systemPrompt;
    if (pediatricCtx.isPediatric) {
      systemPrompt = buildPediatricSystemPrompt({
        identitas,
        keluhanUtama,
        riwayat,
        interviewRules,
        ex,
        pediatricCtx,
      });
    } else {
    systemPrompt = `Kamu berperan sebagai PASIEN dalam simulasi OSCE kedokteran. Jangan pernah keluar dari peran ini, dan jangan pernah menyebutkan bahwa kamu adalah AI.

IDENTITAS PASIEN (data yang tersedia dari kasus):
- Identitas: ${identitas}
- Keluhan utama: ${keluhanUtama}

RIWAYAT YANG KAMU KETAHUI (gunakan HANYA ini sebagai fakta medis kamu; jangan mengarang temuan klinis baru):
- Riwayat Penyakit Sekarang (RPS): ${riwayat.rps.join("; ")}
- Riwayat Penyakit Dahulu (RPD): ${riwayat.rpd}
- Riwayat Penyakit Keluarga (RPK): ${riwayat.rpk}
- Gaya hidup: ${riwayat.lifestyle.join("; ")}

ATURAN DATA PRIBADI YANG TIDAK DISEBUTKAN DI KASUS:
- Kalau "Identitas" di atas TIDAK menyebutkan nama/pekerjaan/tempat tinggal secara eksplisit (mis. hanya "Perempuan, 25 tahun" atau "Bapak paruh baya"), KARANG SENDIRI sekali di jawaban PERTAMA KALI hal itu ditanyakan: satu nama Indonesia yang wajar (sesuai jenis kelamin/usia/konteks), satu pekerjaan yang masuk akal, satu tempat tinggal (kota/kecamatan umum di Indonesia), dan — kalau ditanya — satu orang pendamping yang wajar (mis. anak, suami/istri, tetangga, atau "sendirian saja, Dok" kalau itu lebih masuk akal untuk kasusnya) — lalu PAKAI DATA YANG SAMA itu secara konsisten di sepanjang sisa percakapan ini (cek riwayat chat sebelumnya kalau sudah pernah kamu sebutkan, jangan berubah-ubah).
- PENTING: nama "${ex.nama}" dan kota "${ex.kota}" di CONTOH FORMAT pada aturan di bawah HANYA untuk menunjukkan bentuk kalimatnya — JANGAN pernah memakai nama/kota itu sendiri kecuali kebetulan itu yang paling wajar kamu pikirkan. Wajib karang nama, usia, pekerjaan, kota, dan pendamping yang BERBEDA dan bervariasi sendiri, jangan meniru contoh.
- JANGAN PERNAH menulis placeholder seperti "[nama pasien]", "[nama]", "___", atau semacamnya — itu bukan jawaban pasien sungguhan, harus berupa nama asli yang kamu karang.
- Detail yang SUDAH ADA di "Identitas" di atas (kalau ada) harus dipakai apa adanya, jangan diganti dengan karangan.
- SANGAT PENTING — jangan pernah SUKARELA membocorkan nama/pekerjaan/alamat/pendamping di awal percakapan (mis. langsung memperkenalkan diri lengkap tanpa ditanya). Detail-detail ini HANYA boleh disebutkan satu per satu, TEPAT saat masing-masing secara spesifik ditanyakan — lihat ATURAN MENJAWAB nomor 1 dan 1b di bawah untuk cara persisnya.

ATURAN MENJAWAB — SANGAT PENTING, JAWAB HANYA APA YANG DITANYA:
1. PALING PENTING: HANYA jawab persis apa yang ditanyakan mahasiswa pada pertanyaan TERAKHIR, satu topik saja. JANGAN PERNAH menambahkan keluhan utama, riwayat penyakit, durasi/onset gejala, sifat gejala (hilang timbul/menetap/memberat/membaik dll), riwayat penyakit dahulu/keluarga, atau gaya hidup — KECUALI hal itu SECARA SPESIFIK ditanyakan pada pertanyaan terakhir itu. Berlaku juga untuk identitas: nama, usia, pekerjaan, alamat/tempat tinggal, dan pendamping adalah 5 hal TERPISAH — kalau mahasiswa cuma tanya SATU dari kelimanya (mis. cuma "siapa namanya?"), jawab CUMA nama itu saja, JANGAN sekaligus menyebutkan usia/pekerjaan/alamat/pendamping walau kamu sudah tahu semuanya.
   - Contoh SALAH: ditanya "Dengan bapak siapa?" (HANYA menanyakan nama) lalu pasien menjawab "Saya ${ex.nama}, ${ex.usia} tahun, tinggal di ${ex.kota}, kerja sebagai buruh." — SALAH, karena usia/alamat/pekerjaan TIDAK ditanyakan, hanya nama yang ditanyakan.
   - Contoh BENAR untuk pertanyaan itu: "Saya ${ex.nama}, Dok." — TITIK. Field lain (usia/pekerjaan/alamat/pendamping) baru disebutkan kalau ditanya terpisah nanti.
   - Kalau ditanya "ada keluhan apa?" / "kenapa ke sini?", baru jawab keluhan utamanya SAJA dalam 1 kalimat pendek (misal "Saya merasa berat badan naik banyak akhir-akhir ini, Dok."), TANPA merinci durasi/pola/riwayat lain yang belum ditanya.
   - Detail RPS/RPD/RPK/gaya hidup lain HANYA diceritakan satu per satu, sesuai pertanyaan spesifik yang diajukan setiap kali — jangan pernah digabung jadi satu jawaban panjang berisi banyak fakta baru sekaligus, walaupun kamu tahu semuanya.
1a. KHUSUS PERTANYAAN YA/TIDAK (review sistem — mis. "apakah sering haus/lapar/kencing/demam/dst?"): urutan jawabnya WAJIB seperti ini —
   - LANGKAH 1 (WAJIB, paling pertama, tidak boleh dilewati): jawab "Iya"/"Tidak" secara eksplisit dulu. "Iya" kalau gejala itu memang ada di RIWAYAT YANG KAMU KETAHUI (boleh ditambah sedikit elaborasi singkat setelahnya), "Tidak" kalau gejala itu TIDAK ada di riwayat.
   - LANGKAH 2 (OPSIONAL, hanya SETELAH langkah 1 dijawab, dalam kalimat yang sama): kamu BOLEH — tidak wajib — menyambung dengan SATU keluhan lain yang memang ada di RPS tapi belum pernah kamu ceritakan sebelumnya di percakapan ini, seolah baru teringat. Jangan pernah lakukan langkah 2 tanpa langkah 1.
   - Contoh BENAR: ditanya "Sering lapar juga tidak?" padahal "sering lapar" TIDAK ada di RPS, tapi "mudah lelah" ADA di RPS dan belum pernah disebut → "Kalau sering lapar tidak, Dok, tapi saya jadi lebih sering lelah akhir-akhir ini."
   - Contoh SALAH (JANGAN LAKUKAN): ditanya "Sering lapar juga tidak?" lalu langsung jawab "Saya merasa mudah lelah dan mengantuk, Dok." — SALAH karena tidak ada jawaban ya/tidak untuk "lapar" sama sekali sebelum lompat ke keluhan lain.
1b. KHUSUS PERTANYAAN YANG BERISI BEBERAPA SUB-PERTANYAAN SEKALIGUS DALAM SATU KALIMAT (mis. "Halo, dengan siapa?", "Nama, usia, sama alamatnya apa, Bu?", "Ibu ke sini kerja apa dan tinggal di mana?"): jawab SEMUA bagian yang ditanyakan dalam kalimat itu SEKALIGUS dalam satu balasan pendek — jangan cuma jawab sebagian lalu diam soal bagian lainnya, tapi juga JANGAN menambahkan bagian yang TIDAK ditanyakan (tetap ikuti aturan #1). Hitung persis berapa sub-pertanyaan yang benar-benar ada di kalimat itu, lalu jawab TEPAT sejumlah itu, tidak kurang tidak lebih.
   - Contoh: ditanya "Halo, dengan siapa?" (2 bagian: sapaan + nama) → "Halo, Dok. Saya ${ex.nama}." (2 bagian dijawab, tidak lebih)
   - Contoh: ditanya "Nama, usia, sama alamatnya apa, Bu?" (3 bagian: nama+usia+alamat, TIDAK termasuk pekerjaan/pendamping) → "Saya ${ex.nama}, ${ex.usia} tahun, tinggal di ${ex.kota}, Dok." (3 bagian dijawab, TANPA pekerjaan/pendamping karena tidak ditanya)
   - Contoh SALAH: ditanya "Halo, dengan siapa?" lalu pasien HANYA menjawab "Halo, Dok." tanpa menyebutkan nama — SALAH, "dengan siapa" jelas ditanyakan juga.
2. Jawab sebagai orang awam, bukan tenaga medis — gunakan bahasa sehari-hari, bukan istilah medis.
3. Jika ditanya sesuatu yang tidak ada dalam daftar riwayat di atas, jawab secara wajar dan konsisten dengan kondisi ini (biasanya "tidak ada"/"tidak pernah"), TANPA menciptakan temuan klinis besar baru yang bertentangan dengan kasus.
4. Tunjukkan emosi/kondisi yang wajar sesuai keluhan (misalnya menahan nyeri, cemas), tapi jangan berlebihan.
5. Jangan pernah menyebutkan istilah diagnosis (misalnya jangan bilang "sepertinya saya kena serangan jantung").
6. Jika mahasiswa bertanya hal di luar konteks anamnesis (basa-basi ringan itu wajar dan boleh dijawab singkat, tapi jangan menyimpang jauh).
7. Jawaban singkat dan natural, seperti percakapan dokter-pasien sungguhan — idealnya 1 kalimat, maksimal 2 kalimat pendek. Jangan pernah menjawab dengan paragraf panjang berisi banyak informasi sekaligus.
8. SELALU jawab hanya dalam Bahasa Indonesia. Jangan pernah memakai bahasa lain (termasuk Inggris atau Mandarin), dan jangan pernah menuliskan instruksi/analisis internal kamu di dalam jawaban — hanya kalimat pasien (atau pengantar, jika berlaku) yang boleh muncul.
${interviewRules}`;
    } // end else (adult)

    // The reminder used to be sent as its own `system` message tacked on
    // AFTER the user's turn (system -> ...history -> user -> system). That
    // ordering confuses smaller/faster models (no assistant turn between
    // the user message and the next "system" message), and was the likely
    // cause of the model echoing the student's own sentence back verbatim
    // instead of answering in character. Folding the reminder into the
    // SAME user turn keeps a clean alternating user/assistant shape that
    // small models handle far more reliably.
    const REMINDER_TEXT = pediatricCtx.isPediatric
      ? "\n\n[INGAT: kamu adalah ORANG TUA/WALI pasien anak. Jawab HANYA pertanyaan barusan, satu topik, maksimal 2-3 kalimat. Gunakan sudut pandang orang tua (\"anak saya\", bukan \"saya\"). Kalau pertanyaannya ya/tidak, WAJIB mulai dengan \"Iya\"/\"Tidak\" eksplisit dulu. Sesekali tambahkan gestur berpikir/mengingat dalam *italic* kalau pertanyaannya tentang detail yang mungkin kamu tidak ingat persis. Jangan bocorkan info yang belum ditanya.]"
      : "\n\n[INGAT: jawab HANYA pertanyaan barusan, satu topik saja, maksimal 1-2 kalimat pendek. Kalau pertanyaannya berbentuk ya/tidak, WAJIB mulai jawaban dengan \"Iya\"/\"Tidak\" secara eksplisit dulu sebelum kalimat lain apapun. Jangan tempelkan keluhan utama atau riwayat penyakit apapun kecuali benar-benar ditanyakan barusan.]";

    // Dynamic context window: fit as much recent history as fits inside the
    // remaining token budget once the system prompt, reminder, new message,
    // and reply headroom are accounted for — rather than always keeping a
    // fixed message count.
    const fixedTokens =
      estimateTokens(systemPrompt) +
      estimateTokens(REMINDER_TEXT) +
      estimateTokens(cleanMessage);

    const { history: trimmedHistory } = fitHistoryToBudget(cleanHistory, {
      systemTokens: fixedTokens,
      reserveTokens: REPLY_RESERVE_TOKENS,
      maxContextTokens: MAX_CONTEXT_TOKENS,
    });

    const messages = [
      { role: "system", content: systemPrompt },
      ...trimmedHistory,
      { role: "user", content: cleanMessage + REMINDER_TEXT },
    ];

    // Lower temperature (more deterministic/instruction-following) and a
    // tight max_tokens ceiling so even if a model ignores the "1-2 kalimat"
    // instruction, it physically cannot ramble through an entire case
    // vignette in one reply.
    const response = await chat({ messages, temperature: 0.3, max_tokens: 120, forceProvider });
    const text = response.choices?.[0]?.message?.content || "";

    res.json({ reply: text, _provider: response._provider });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Chat failed", detail: String(err.message || err) });
  }
});

/**
 * POST /api/chat/empati
 * body: { history: [{role, content}, ...] }  (the anamnesis chat log)
 *
 * "Nilai Empati" — detects whether the student, at ANY point during
 * anamnesis, asked the patient about 4 rapport-building things that are
 * good practice but not strictly clinical: nama, pekerjaan, tempat
 * tinggal, dan siapa yang mengantar/menemani. Keyword matching is
 * deliberately NOT used here — real questions are phrased far too many
 * ways ("namanya siapa", "boleh tahu namanya", "dengan siapa saya bicara
 * ini") for a fixed pattern list to catch reliably. Instead this reuses
 * the same small-model chat() call the rest of the app uses, asking it to
 * classify the transcript and return strict JSON.
 */
router.post("/empati", async (req, res) => {
  try {
    const { history = [], forceProvider } = req.body;
    const cleanHistory = sanitizeHistory(history);

    const studentQuestions = cleanHistory
      .filter((h) => h.role === "user")
      .map((h, i) => `${i + 1}. ${h.content}`)
      .join("\n");

    if (!studentQuestions) {
      return res.json({ nama: false, pekerjaan: false, tempatTinggal: false, pendamping: false });
    }

    const systemPrompt = `Kamu adalah penilai (rater) simulasi OSCE. Tugasmu HANYA membaca daftar pertanyaan yang diajukan mahasiswa kepada pasien selama sesi anamnesis, lalu menentukan apakah mahasiswa itu MENANYAKAN (bukan menjawab, bukan mengasumsikan) 4 hal berikut, kapan saja selama sesi — boleh dengan kalimat apapun, tidak harus persis sama:
1. "nama": menanyakan nama pasien (mis. "Namanya siapa, Bu?", "Boleh tahu nama Bapak?", "Dengan siapa saya bicara ini?")
2. "pekerjaan": menanyakan pekerjaan/aktivitas sehari-hari pasien (mis. "Sehari-hari kerja apa?", "Kesehariannya ngapain aja, Pak?")
3. "tempatTinggal": menanyakan di mana pasien tinggal (mis. "Sekarang tinggal di mana?", "Rumahnya di daerah mana?")
4. "pendamping": menanyakan siapa yang mengantar/menemani pasien ke tempat periksa (mis. "Ke sini diantar siapa?", "Datang sendiri atau ditemani?")

Jawab HANYA dengan JSON valid, tanpa teks lain, tanpa markdown, format persis:
{"nama": true/false, "pekerjaan": true/false, "tempatTinggal": true/false, "pendamping": true/false}`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Daftar pertanyaan mahasiswa selama sesi ini:\n${studentQuestions}` },
    ];

    const response = await chat({ messages, temperature: 0, max_tokens: 150, forceProvider });
    const raw = response.choices?.[0]?.message?.content || "{}";
    // Small/reasoning models sometimes wrap JSON in ```json fences or add a
    // stray sentence despite the instruction — pull out just the {...}.
    const match = raw.match(/\{[\s\S]*\}/);
    let parsed = { nama: false, pekerjaan: false, tempatTinggal: false, pendamping: false };
    if (match) {
      try {
        const j = JSON.parse(match[0]);
        parsed = {
          nama: !!j.nama,
          pekerjaan: !!j.pekerjaan,
          tempatTinggal: !!j.tempatTinggal,
          pendamping: !!j.pendamping,
        };
      } catch {
        // keep default all-false if the model didn't return valid JSON
      }
    }

    res.json({ ...parsed, _provider: response._provider });
  } catch (err) {
    console.error(err);
    // Empathy scoring is a nice-to-have on top of the core session — never
    // let it block the student from reaching the reveal screen. Fail soft.
    res.json({ nama: false, pekerjaan: false, tempatTinggal: false, pendamping: false, _error: String(err.message || err) });
  }
});

module.exports = router;
# Cara bikin kasus lewat Word → konverter

## 1. Isi `scripts/CASE_TEMPLATE.docx`

- **1 tabel = 1 kasus.** Copy-paste seluruh tabel untuk tiap kasus baru.
- Kolom kiri (nama field) **jangan diubah**. Kolom kanan diisi.
- Field per baris:

| Field | Isi |
|---|---|
| ID | slug singkat, contoh `end_08`. Boleh kosong → dibuat otomatis dari Nama. |
| Kategori | *(diabaikan konverter — kategori ditentukan lewat flag `--kategori` saat run, supaya satu docx bisa isi banyak kategori sekaligus kalau perlu)* |
| Nama | label singkat di daftar kasus, contoh `Kasus 8 - Endokrin` |
| Level | level SKDI, opsional |
| Judul Kasus | satu kalimat ringkasan kasus |
| Identitas | `Nama: x, Usia: y, Pekerjaan: z, Alamat: w` dalam satu baris. **Ini TIDAK ditampilkan ke mahasiswa di awal sesi** — hanya dipakai AI pasien untuk menjawab kalau ditanya langsung saat anamnesis. |
| Skenario Awal | satu-dua kalimat NETRAL yang ditampilkan ke mahasiswa SEBELUM anamnesis, contoh: `Seorang pria 23 tahun, datang ke poli dengan keluhan nyeri kepala dan leher.` Sebutkan jenis kelamin + usia + alasan datang secara umum saja — JANGAN sebut nama/pekerjaan/alamat/detail keluhan di sini, itu harus digali lewat anamnesis. Boleh dikosongkan → dibuat otomatis dari Usia + Keluhan Utama (tanpa jenis kelamin, netral) — tapi lebih baik diisi manual kalau jenis kelamin pasien penting untuk kasusnya. |
| Keluhan Utama | satu kalimat. **Juga TIDAK ditampilkan di awal** — baru terungkap saat mahasiswa bertanya "ada keluhan apa?" ke AI pasien. |
| RPS | satu baris = satu poin riwayat penyakit sekarang |
| RPD | riwayat penyakit dahulu |
| RPK | riwayat penyakit keluarga |
| Lifestyle | satu baris = satu poin gaya hidup/sosial |
| Pemeriksaan Fisik | satu baris = satu temuan, format `Nama: Temuan`. Awali `*` kalau signifikan, awali `!` kalau mahasiswa harus melaporkan sendiri temuannya (lihat bagian "Wajib lapor" di bawah). **Bisa ditempeli gambar juga** (lihat bagian gambar di bawah — sekarang berlaku sama untuk PF maupun Penunjang, tidak hanya EKG/rontgen). |
| Pemeriksaan Penunjang | sama seperti di atas. |
| DD Benar | diagnosis kerja yang benar |
| DD Diferensial Benar | satu baris = satu diagnosis banding yang **secara klinis valid** untuk kasus ini (bukan pengecoh MCQ) — ini yang dicocokkan saat menilai jawaban diagnosis banding mahasiswa. |
| Tatalaksana | satu baris = satu opsi. Awali `+` = benar, `-` = salah. |
| Edukasi | sama seperti Tatalaksana |

### Soal gambar (EKG/rontgen/ruam kulit/deformitas sendi/dsb — SEMUA temuan bisa)

Word menyimpan tiap gambar sebagai paragraf tersendiri di dalam sel tabel.
Konverter membaca sel **paragraf demi paragraf, sesuai urutan di dokumen** —
begitu ia menemukan gambar, gambar itu langsung ditempelkan ke baris temuan
paling akhir yang dibaca sebelumnya. Berlaku di **Pemeriksaan Fisik maupun
Pemeriksaan Penunjang** — bukan cuma EKG/rontgen, foto ruam kulit di baris PF
"Kulit: ..." atau foto deformitas sendi di baris PF "Ekstremitas: ..." juga
akan ikut tertempel dengan cara yang sama. Jadi urutannya harus:

```
*EKG: Sinus takikardia ringan
[gambar EKG di sini]
Foto Thorax: Dalam batas normal
[gambar rontgen di sini]
*Kulit: Ruam eritematosa dengan skuama di ekstremitas fleksor
[gambar ruam kulit di sini]
```

Kalau satu temuan tidak ada gambarnya, cukup lanjut ke baris temuan berikutnya
— tidak perlu paragraf kosong.

### Wajib lapor (`!`) — temuan bergambar yang harus dilaporkan mahasiswa sendiri

Secara default, begitu mahasiswa mencocokkan sebuah temuan (misalnya minta
"EKG"), teks temuannya langsung tampil — gambar cuma pelengkap. Untuk
temuan-temuan tertentu (foto ulkus, foto wajah pasien, rontgen, EKG, dsb) kamu
bisa memaksa mahasiswa **menginterpretasikan gambarnya sendiri dulu** sebelum
tahu jawabannya:

- Awali baris temuan dengan `!`, contoh: `!EKG: Elevasi ST V1-V4`. Baris itu
  **wajib** juga ditempeli gambar (lihat bagian di atas) — kalau tidak ada
  gambarnya, tanda `!` diabaikan begitu saja dan temuan tampil seperti biasa
  (konverter akan mengingatkan lewat warning ⚠ kalau ini terjadi).
- Bisa digabung dengan `*` (signifikan), urutan bebas: `*!EKG: ...` atau
  `!*EKG: ...` sama-sama valid.
- Ini **modifier opsional per baris** — tidak semua temuan bergambar harus
  diberi tanda ini. Kalau tidak diberi tanda `!`, gambar & teks temuan tetap
  langsung tampil seperti biasa (perilaku lama, tidak berubah). Pasang `!`
  hanya di temuan yang memang kamu mau mahasiswa latihan membaca/interpretasi
  gambarnya sendiri.
- Efeknya di aplikasi: saat mahasiswa memicu temuan itu, yang tampil hanya
  gambarnya + kartu esai dengan instruksi "Laporkan temuan Anda" (jawaban
  tidak dinilai otomatis). Teks temuan yang sebenarnya baru muncul di layar
  Kunci Jawaban di akhir sesi, berdampingan dengan laporan mahasiswa —
  perlakuan yang sama seperti Tatalaksana dan Edukasi.

```
!EKG: Irama fibrilasi atrium, respons ventrikel ireguler, HR ±150x/menit
[gambar EKG di sini]
*Foto Thorax: Kardiomegali dengan CTR 60%
[gambar rontgen di sini]
```

Di contoh di atas, EKG akan meminta laporan mahasiswa dulu (baru dibandingkan
di Kunci Jawaban), sedangkan Foto Thorax langsung tampil seperti biasa (cuma
ditandai signifikan).

## 2. Jalankan konverter

```
node scripts/docx-to-case.js path/ke/file.docx --kategori endokrin
```

Ini akan:
- Membaca **setiap tabel** di file itu sebagai satu kasus.
- Menulis `data/cases/endokrin/<id>.json` sesuai `_SCHEMA.md`.
- Mengekstrak & mengganti nama gambar yang tertempel, lalu menaruhnya di
  `data/images/endokrin/<id>/<nama-temuan>.png`, dan otomatis mengisi field
  `"image"` di JSON-nya.
- Menulis dump teks mentah (`_raw_<nama file>.txt`) untuk pengecekan manual.

Baca **semua warning (⚠)** yang muncul di terminal — itu menandakan baris yang
tidak terbaca, DD Benar kosong, atau Pemeriksaan Penunjang kosong.

## 3. Selalu review hasilnya

Konverter ini murni transformasi struktural (docx → JSON + gambar). Ia
**tidak** memverifikasi kebenaran medis apa pun. Selalu buka file JSON hasilnya
dan cocokkan dengan dokumen aslinya sebelum dipakai di aplikasi.

## Kalau tabelnya beda bentuk

Kalau format tabel yang sudah kamu bikin sebelumnya beda (misal satu tabel
berisi banyak kasus sebagai baris, bukan satu tabel per kasus), bilang saja —
skema field-nya sudah fleksibel (lihat `FIELD_ALIASES` di
`scripts/docx-to-case.js`), tapi asumsi "gambar nempel ke paragraf tepat di
atasnya" perlu logika parsing yang berbeda kalau layoutnya berubah jadi
per-baris.

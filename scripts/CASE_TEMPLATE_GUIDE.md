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
| Identitas | `Nama: x, Usia: y, Pekerjaan: z, Alamat: w` dalam satu baris |
| Keluhan Utama | satu kalimat |
| RPS | satu baris = satu poin riwayat penyakit sekarang |
| RPD | riwayat penyakit dahulu |
| RPK | riwayat penyakit keluarga |
| Lifestyle | satu baris = satu poin gaya hidup/sosial |
| Pemeriksaan Fisik | satu baris = satu temuan, format `Nama: Temuan`. Awali `*` kalau signifikan. |
| Pemeriksaan Penunjang | sama seperti di atas. **Untuk taruh gambar** (EKG, rontgen, USG dll): sisipkan gambar sebagai paragraf baru **tepat di bawah** baris temuan itu, masih di sel yang sama. |
| DD Benar | diagnosis yang benar |
| DD Pilihan | satu baris = satu opsi (termasuk yang benar, ditulis ulang) |
| Tatalaksana | satu baris = satu opsi. Awali `+` = benar, `-` = salah. |
| Edukasi | sama seperti Tatalaksana |

### Soal gambar (EKG/rontgen/dsb)

Word menyimpan tiap gambar sebagai paragraf tersendiri di dalam sel tabel.
Konverter membaca sel **paragraf demi paragraf, sesuai urutan di dokumen** —
begitu ia menemukan gambar, gambar itu langsung ditempelkan ke baris temuan
paling akhir yang dibaca sebelumnya. Jadi urutannya harus:

```
*EKG: Sinus takikardia ringan
[gambar EKG di sini]
Foto Thorax: Dalam batas normal
[gambar rontgen di sini]
```

Kalau satu temuan tidak ada gambarnya, cukup lanjut ke baris temuan berikutnya
— tidak perlu paragraf kosong.

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

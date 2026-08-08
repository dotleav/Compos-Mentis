# Case JSON schema

Every case lives at `data/cases/<kategori>/<id>.json`. Images referenced by a case
live at `data/images/<kategori>/<id>/<filename>`.

```jsonc
{
  "id": "stemi_anteroseptal",          // matches filename
  "kategori": "kardio",                // matches folder
  "level": "3B",                       // SKDI competency level, optional
  "nama": "Kasus 1 – Kardiovaskular",  // shown in case list
  "judulKasus": "Pak Indra, 40 tahun, riwayat hipertensi & hiperkolesterol, datang dengan nyeri dada mendadak",
  "identitas": { "nama": "Indra", "usia": 40, "pekerjaan": "-", "alamat": "-" },
  "keluhanUtama": "Nyeri dada kiri tiba-tiba sejak 3 jam yang lalu",

  // Everything the STUDENT should never see directly — this is the AI's
  // ground truth. It is sent to the LLM as hidden context, never to the client.
  "groundTruth": {
    "riwayat": {
      "rps": ["Nyeri dada kiri tiba-tiba, 3 jam yang lalu", "..."],
      "rpd": "Hipertensi 10 tahun, hiperkolesterol 8 tahun",
      "rpk": "-",
      "lifestyle": ["Merokok 1 bungkus/hari (lama)", "Jarang minum obat rutin"]
    },

    // Flat list — used for BOTH display (after being "performed") and for
    // the matching tool the AI uses to interpret free-text requests.
    "pemeriksaanFisik": [
      {
        "id": "vs_td",
        "kelompok": "vital",           // vital | survei_primer | survei_sekunder | khas | distraksi
        "nama": "Tekanan Darah",
        "temuan": "140/70 mmHg",
        "signifikan": false
      }
    ],

    "penunjang": [
      {
        "id": "ekg",
        "nama": "EKG",
        "temuan": "Irama sinus reguler, elevasi ST di V1-V4 (khas STEMI Anteroseptal)",
        "signifikan": true,
        "image": "ekg_stemi_anteroseptal.png"   // optional, filename in data/images/<kategori>/<id>/
      }
    ],

    // Fallback text used when the student asks for something reasonable that
    // isn't in the lists above, so the AI never has to invent a clinical value.
    "defaultNormal": {
      "pemeriksaanFisik": "Dalam batas normal, tidak ditemukan kelainan bermakna.",
      "penunjang": "Hasil dalam batas normal, tidak ditemukan kelainan bermakna."
    }
  },

  "dd": {
    "benar": "STEMI Anteroseptal (V1-V4)",
    "pilihan": ["STEMI Anteroseptal (V1-V4)", "NSTEMI", "UAP", "GERD", "Angina pektoris stabil"]
  },

  "tatalaksana": [
    { "opsi": "MONA + rujuk segera Sp.JP", "benar": true },
    { "opsi": "Amlodipin sebagai lini pertama", "benar": false }
  ],

  "edukasi": [
    { "opsi": "Perlu segera dirujuk untuk pemasangan ring (PCI)", "benar": true },
    { "opsi": "Boleh tunda berobat jika nyeri membaik sendiri", "benar": false }
  ]
}
```

## Design notes

- **Anamnesis** is free-form chat. The whole `groundTruth.riwayat` + `identitas` +
  `keluhanUtama` is embedded in the patient persona's system prompt. The model
  answers *in character*, in Indonesian, only revealing what's asked.
- **Physical exam & Penunjang** are *not* free generation. The student types what
  they want to do/order in free text (e.g. "auskultasi jantung", "cek troponin").
  The backend asks the model to pick the closest matching `id` from the case's
  list via forced tool-use (`select_finding`), then returns the **exact stored
  `temuan` text** — the model never invents a clinical value. If nothing matches
  well, it falls back to `defaultNormal`. This is what fixes the old "unstable
  search engine" — matching is now semantic (LLM-driven) instead of brittle
  string search, while findings themselves stay deterministic and instructor-authored.
- If a `penunjang` item has an `image`, the frontend displays it alongside the
  text finding whenever that item is revealed.

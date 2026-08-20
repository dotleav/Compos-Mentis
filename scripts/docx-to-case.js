#!/usr/bin/env node
/**
 * Convert a .docx case bank into case JSON + extracted images.
 *
 * DOCX CONVENTION (see scripts/CASE_TEMPLATE_GUIDE.md and the .docx template
 * in the same folder for a ready-to-fill example):
 *
 *   - One Word TABLE per case. Two columns: "Field" | "Isi".
 *   - Row order and field names are matched case-insensitively against the
 *     labels in FIELD_ALIASES below (Indonesian, with a few common synonyms).
 *   - Anamnesis (RPS/Lifestyle), Pemeriksaan Fisik, Pemeriksaan Penunjang,
 *     DD Pilihan, Tatalaksana, Edukasi are all "one point per paragraph/line"
 *     inside their cell.
 *   - Pemeriksaan Fisik / Pemeriksaan Penunjang lines use:
 *       Nama: Temuan
 *     Prefix the line with "*" to mark it `signifikan: true`.
 *   - To attach an image (EKG, rontgen, etc.) to a Pemeriksaan Penunjang
 *     item, insert the picture as its OWN paragraph directly under that
 *     item's line, still inside the same table cell. The script walks the
 *     cell paragraph-by-paragraph in document order and attaches any image
 *     it finds to the most recent item line above it.
 *   - Tatalaksana / Edukasi lines: prefix "+" = correct option, "-" = wrong
 *     option (defaults to wrong if no prefix given).
 *
 * Usage:
 *   node scripts/docx-to-case.js <path-to.docx> --kategori kardio
 *
 * Output:
 *   data/cases/<kategori>/<id>.json              (one per table/case)
 *   data/images/<kategori>/<id>/<image files>     (renamed, referenced by id)
 *   data/cases/<kategori>/_raw_<docx-basename>.txt  (debug dump, always written)
 *
 * Anything the script can't confidently parse is left as "" / [] and logged
 * as a WARNING to the console — always skim the warnings and the resulting
 * JSON before treating a case as ready to use.
 */

const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const { XMLParser } = require("fast-xml-parser");
const mammoth = require("mammoth");

const args = process.argv.slice(2);
const docxPath = args[0];
const kategori = args.includes("--kategori") ? args[args.indexOf("--kategori") + 1] : null;

if (!docxPath || !kategori) {
  console.error("Usage: node scripts/docx-to-case.js <path-to.docx> --kategori <kategori>");
  process.exit(1);
}

const ROOT = path.join(__dirname, "..");
const base = path.basename(docxPath, path.extname(docxPath)).replace(/[^a-zA-Z0-9_-]/g, "_");

const FIELD_ALIASES = {
  id: ["id", "kode", "id kasus"],
  nama: ["nama", "nama kasus", "judul list"],
  level: ["level", "level skdi", "skdi"],
  judulKasus: ["judul kasus", "judul"],
  identitas: ["identitas", "identitas pasien"],
  skenarioAwal: ["skenario awal", "skenario", "vinyet awal", "vignette"],
  keluhanUtama: ["keluhan utama"],
  rps: ["rps", "riwayat penyakit sekarang", "anamnesis"],
  rpd: ["rpd", "riwayat penyakit dahulu"],
  rpk: ["rpk", "riwayat penyakit keluarga"],
  lifestyle: ["lifestyle", "riwayat sosial", "kebiasaan"],
  pemeriksaanFisik: ["pemeriksaan fisik", "pf"],
  penunjang: ["pemeriksaan penunjang", "penunjang"],
  ddBenar: ["dd benar", "diagnosis benar", "diagnosis"],
  ddDifferensial: ["dd diferensial", "diferensial benar", "dd differensial", "differensial benar", "diagnosis banding benar", "dd pilihan", "pilihan dd", "differential diagnosis"],
  tatalaksana: ["tatalaksana"],
  edukasi: ["edukasi"],
};

function normLabel(s) {
  return (s || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[:：]$/, "");
}

function matchField(label) {
  const n = normLabel(label);
  for (const [key, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.some((a) => n === a || n.startsWith(a + " ") || a.startsWith(n))) return key;
  }
  return null;
}

function slugify(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 40);
}

// ---------- Low-level docx XML walking ----------

function loadDocx(docxPath) {
  const zip = new AdmZip(docxPath);
  const getText = (entryName) => {
    const e = zip.getEntry(entryName);
    return e ? zip.readAsText(e) : null;
  };
  const documentXml = getText("word/document.xml");
  const relsXml = getText("word/_rels/document.xml.rels");
  if (!documentXml) throw new Error("word/document.xml not found — is this a valid .docx?");

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    preserveOrder: true,
    removeNSPrefix: false,
  });

  const relMap = {}; // rId -> media path (word/media/xxx.png)
  if (relsXml) {
    const relsDoc = parser.parse(relsXml);
    const relsRoot = findTag(relsDoc, "Relationships");
    const relEntries = relsRoot ? relsRoot["Relationships"] || [] : [];
    for (const entry of relEntries) {
      if (entry["Relationship"] !== undefined) {
        const attrs = entry[":@"] || {};
        const id = attrs["@_Id"];
        const target = attrs["@_Target"];
        if (id && target && target.startsWith("media/")) {
          relMap[id] = "word/" + target;
        }
      }
    }
  }

  const doc = parser.parse(documentXml);
  return { zip, doc, relMap };
}

// preserveOrder gives arrays of {tagName: children, ":@": attrs} objects.
// findTag walks the FIRST match of a tag name inside a preserveOrder node array.
function findTag(nodeArray, tagName) {
  if (!Array.isArray(nodeArray)) return null;
  for (const node of nodeArray) {
    if (node[tagName] !== undefined) return { [tagName]: node[tagName], ":@": node[":@"] };
  }
  return null;
}

function findAllTags(nodeArray, tagName) {
  const out = [];
  if (!Array.isArray(nodeArray)) return out;
  for (const node of nodeArray) {
    if (node[tagName] !== undefined) out.push(node[tagName]);
  }
  return out;
}

// Recursively find all descendant nodes with a given tag name, regardless of depth.
function findAllDescendants(nodeArray, tagName, acc = []) {
  if (!Array.isArray(nodeArray)) return acc;
  for (const node of nodeArray) {
    for (const key of Object.keys(node)) {
      if (key === ":@") continue;
      if (key === tagName) acc.push(node[key]);
      if (Array.isArray(node[key])) findAllDescendants(node[key], tagName, acc);
    }
  }
  return acc;
}

function getAttr(node, attrName) {
  return node && node[":@"] ? node[":@"][attrName] : undefined;
}

// Extract plain text of a w:p (paragraph) node's children array.
function paragraphText(pChildren) {
  const texts = findAllDescendants(pChildren, "w:t");
  return texts
    .map((t) => (Array.isArray(t) && t[0] && t[0]["#text"] !== undefined ? t[0]["#text"] : ""))
    .join("");
}

// fast-xml-parser preserveOrder wraps attributes at the node's own level (node[":@"]).
// Recursively walk to find a:blip elements anywhere under this paragraph and pull r:embed.
function extractBlipRelIds(node) {
  const ids = [];
  const walk = (n) => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (n && typeof n === "object") {
      if (n["a:blip"] !== undefined) {
        const attrs = n[":@"] || {};
        const rid = attrs["@_r:embed"] || attrs["@_r:link"];
        if (rid) ids.push(rid);
      }
      for (const key of Object.keys(n)) {
        if (key === ":@") continue;
        walk(n[key]);
      }
    }
  };
  walk(node);
  return ids;
}

// Given a w:tc (table cell) children array, return an ordered list of
// { text: string, images: [relId,...] } — one entry per paragraph, in doc order.
function cellParagraphs(tcChildren) {
  const paras = findAllTags(tcChildren, "w:p");
  return paras.map((pChildren) => ({
    text: paragraphText(pChildren).trim(),
    images: extractBlipRelIds(pChildren),
  }));
}

// Given a w:tbl (table) children array, return rows as [{label, paragraphs}]
// where paragraphs is the cellParagraphs() output of the 2nd cell (the "Isi" column).
function parseCaseTable(tblChildren) {
  const rows = findAllTags(tblChildren, "w:tr");
  const out = [];
  for (const rowChildren of rows) {
    const cells = findAllTags(rowChildren, "w:tc");
    if (cells.length < 2) continue;
    const label = cellParagraphs(cells[0])
      .map((p) => p.text)
      .join(" ")
      .trim();
    const paragraphs = cellParagraphs(cells[1]);
    out.push({ label, paragraphs });
  }
  return out;
}

// ---------- Line-item parsing helpers ----------

function linesOf(paragraphs) {
  return paragraphs.map((p) => p.text).filter((t) => t.length > 0);
}

function parseBulletList(paragraphs) {
  return linesOf(paragraphs).map((l) => l.replace(/^[-*•]\s*/, "").trim());
}

// "Nama: Temuan" lines -> [{nama, temuan, signifikan}], attaching any image
// paragraph that follows a line (before the next labeled line) to that item.
function parseFindingList(paragraphs, idPrefix) {
  const items = [];
  let current = null;
  let counter = 1;
  for (const para of paragraphs) {
    const hasColon = para.text.includes(":");
    if (para.text && hasColon) {
      let text = para.text.trim();
      let signifikan = false;
      if (text.startsWith("*")) {
        signifikan = true;
        text = text.slice(1).trim();
      }
      const idx = text.indexOf(":");
      const nama = text.slice(0, idx).trim();
      const temuan = text.slice(idx + 1).trim();
      current = {
        id: `${idPrefix}_${slugify(nama) || counter}`,
        nama,
        temuan,
        signifikan,
        _images: [],
      };
      counter++;
      items.push(current);
    } else if (para.text && !hasColon) {
      // Non-colon line with no active item yet, or a continuation — append to temuan.
      if (current) current.temuan += (current.temuan ? " " : "") + para.text.trim();
    }
    if (para.images.length && current) {
      current._images.push(...para.images);
    }
  }
  return items;
}

function parseOptionList(paragraphs) {
  return linesOf(paragraphs).map((l) => {
    let opsi = l.trim();
    let benar = false;
    if (opsi.startsWith("+")) {
      benar = true;
      opsi = opsi.slice(1).trim();
    } else if (opsi.startsWith("-")) {
      benar = false;
      opsi = opsi.slice(1).trim();
    }
    return { opsi, benar };
  });
}

function parseIdentitas(paragraphs) {
  // Returns a plain string, e.g. "Rudi, 23 tahun, PNS" — matches the schema
  // every case in data/cases/ actually uses. (An earlier version of this
  // script emitted {nama, usia, pekerjaan, alamat} as a nested object —
  // that silently broke the app: identitas gets template-interpolated
  // directly as a string both in the UI and in the AI patient's system
  // prompt, so an object rendered as literal "[object Object]" in both
  // places. Only accepts either format from the docx (see below) but
  // always OUTPUTS a string now.)
  const text = linesOf(paragraphs).join(", ");
  // Accepts either "Nama: x, Usia: y, Pekerjaan: z, Alamat: w" labeled
  // form, or a single free-text line typed directly ("Rudi, 23 tahun,
  // PNS") — if no "Nama:"-style labels are found, use the line as-is.
  if (!/nama\s*:/i.test(text)) return text || "-";
  const get = (key) => {
    const re = new RegExp(key + "\\s*:\\s*([^,]+)", "i");
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };
  const parts = [get("nama"), get("usia") ? `${get("usia")} tahun` : null, get("pekerjaan"), get("alamat")]
    .filter((v) => v && v !== "-");
  return parts.join(", ") || "-";
}

// ---------- Main conversion ----------

async function main() {
  const { zip, doc, relMap } = loadDocx(docxPath);
  const body = findTag(findTag(doc, "w:document")["w:document"], "w:body")["w:body"];
  const tables = findAllDescendants(body, "w:tbl");

  if (tables.length === 0) {
    console.error(
      "No tables found in this docx. This converter expects ONE TABLE PER CASE — see scripts/CASE_TEMPLATE_GUIDE.md."
    );
    process.exit(1);
  }

  console.log(`Found ${tables.length} table(s) — treating each as one case.\n`);

  const casesDir = path.join(ROOT, "data", "cases", kategori);
  fs.mkdirSync(casesDir, { recursive: true });

  // Also dump raw text for debugging/reference, same as before.
  const { value: rawText } = await mammoth.extractRawText({ path: docxPath });
  fs.writeFileSync(path.join(casesDir, `_raw_${base}.txt`), rawText, "utf-8");

  const results = [];

  for (let t = 0; t < tables.length; t++) {
    const rows = parseCaseTable(tables[t]);
    const fields = {};
    const unmatched = [];
    for (const row of rows) {
      const key = matchField(row.label);
      if (key) fields[key] = row.paragraphs;
      else if (row.label) unmatched.push(row.label);
    }

    const nama = fields.nama ? linesOf(fields.nama).join(" ") : `Kasus ${t + 1}`;
    const judulKasus = fields.judulKasus ? linesOf(fields.judulKasus).join(" ") : "";
    let id = fields.id ? slugify(linesOf(fields.id).join("")) : "";
    if (!id) id = `${kategori}_${slugify(nama) || t + 1}`;
    const identitas = fields.identitas ? parseIdentitas(fields.identitas) : "-";
    const keluhanUtama = fields.keluhanUtama ? linesOf(fields.keluhanUtama).join(" ") : "";
    // "Skenario Awal" is the ONLY thing shown to the student before the
    // session starts — identitas/keluhanUtama are withheld until asked
    // during anamnesis (see server/routes/chat.js). If the docx doesn't
    // have an explicit "Skenario Awal" row, fall back to a generic
    // gender-neutral sentence built from age (parsed out of identitas) +
    // keluhan utama — reusing already-authored data rather than inventing
    // new clinical content. Authors should fill in "Skenario Awal"
    // explicitly whenever they know the patient's gender, since this
    // fallback can't infer that from "Nama: x, Usia: y" alone.
    let skenarioAwal = fields.skenarioAwal ? linesOf(fields.skenarioAwal).join(" ") : "";
    if (!skenarioAwal) {
      const usiaMatch = identitas.match(/(\d+)\s*tahun/);
      const usiaTxt = usiaMatch ? `${usiaMatch[1]} tahun` : "";
      const keluhanTxt = keluhanUtama ? keluhanUtama.charAt(0).toLowerCase() + keluhanUtama.slice(1) : "keluhan yang belum diketahui";
      skenarioAwal = `Seorang pasien${usiaTxt ? " " + usiaTxt : ""}, datang ke poli dengan${keluhanUtama ? " keluhan " + keluhanTxt : " " + keluhanTxt}.`;
      console.warn(`  ⚠ [${id}] Tidak ada baris "Skenario Awal" — dibuat otomatis (netral gender): "${skenarioAwal}". Isi manual kalau jenis kelamin pasien penting.`);
    }

    const pfItems = fields.pemeriksaanFisik ? parseFindingList(fields.pemeriksaanFisik, "pf") : [];
    const penunjangItems = fields.penunjang ? parseFindingList(fields.penunjang, "pnj") : [];

    // Resolve + copy images for ANY finding that has one attached — Pemeriksaan
    // Fisik and Pemeriksaan Penunjang are treated identically. (Previously
    // only penunjangItems images were ever written to disk; pfItems images
    // were extracted from the docx but then silently discarded — so e.g. a
    // photo of a rash or a joint deformity attached to a PF line never made
    // it into the case at all. Any finding can carry an image now, not just
    // EKG/rontgen under Penunjang.)
    const imgOutDir = path.join(ROOT, "data", "images", kategori, id);
    let imagesWritten = 0;
    function writeAttachedImages(items) {
      for (const item of items) {
        if (item._images && item._images.length) {
          const relId = item._images[0]; // one image per finding is the expected case
          const mediaPath = relMap[relId];
          if (mediaPath) {
            const entry = zip.getEntry(mediaPath);
            if (entry) {
              fs.mkdirSync(imgOutDir, { recursive: true });
              const ext = path.extname(mediaPath) || ".png";
              const fname = `${item.id}${ext}`;
              fs.writeFileSync(path.join(imgOutDir, fname), zip.readFile(entry));
              item.image = fname;
              imagesWritten++;
            }
          }
          if (item._images.length > 1) {
            console.warn(`  ⚠ [${id}] "${item.nama}" has more than one image attached — only the first was used.`);
          }
        }
        delete item._images;
      }
    }
    writeAttachedImages(pfItems);
    writeAttachedImages(penunjangItems);

    const caseObj = {
      id,
      kategori,
      level: fields.level ? linesOf(fields.level).join(" ") : "",
      nama,
      judulKasus,
      identitas,
      skenarioAwal,
      keluhanUtama,
      groundTruth: {
        riwayat: {
          rps: fields.rps ? parseBulletList(fields.rps) : [],
          rpd: fields.rpd ? linesOf(fields.rpd).join(" ") : "-",
          rpk: fields.rpk ? linesOf(fields.rpk).join(" ") : "-",
          lifestyle: fields.lifestyle ? parseBulletList(fields.lifestyle) : [],
        },
        pemeriksaanFisik: pfItems,
        penunjang: penunjangItems,
        defaultNormal: {
          pemeriksaanFisik: "Dalam batas normal, tidak ditemukan kelainan bermakna.",
          penunjang: "Hasil dalam batas normal, tidak ditemukan kelainan bermakna.",
        },
      },
      dd: {
        benar: fields.ddBenar ? linesOf(fields.ddBenar).join(" ") : "",
        differensialBenar: fields.ddDifferensial ? parseBulletList(fields.ddDifferensial) : [],
      },
      tatalaksana: fields.tatalaksana ? parseOptionList(fields.tatalaksana) : [],
      edukasi: fields.edukasi ? parseOptionList(fields.edukasi) : [],
    };

    const outPath = path.join(casesDir, `${id}.json`);
    fs.writeFileSync(outPath, JSON.stringify(caseObj, null, 2), "utf-8");
    console.log(
      `✔ Case ${t + 1}/${tables.length}: ${path.relative(ROOT, outPath)}  (${imagesWritten} image(s) attached)`
    );
    if (unmatched.length) {
      console.log(`  ⚠ Unrecognized row label(s), skipped: ${unmatched.join(" | ")}`);
    }
    if (!fields.ddBenar) console.log(`  ⚠ [${id}] Missing "DD Benar" row.`);
    if (!penunjangItems.length) console.log(`  ⚠ [${id}] No Pemeriksaan Penunjang items parsed.`);

    results.push(caseObj);
  }

  console.log(
    `\nDone. ${results.length} case(s) written to ${path.relative(ROOT, casesDir)}, images (if any) to ${path.relative(
      ROOT,
      path.join(ROOT, "data", "images", kategori)
    )}/<case-id>/.`
  );
  console.log("⚠ Always review each JSON file before treating it as a finished case — this is a structural");
  console.log("  conversion only; it does not verify medical accuracy.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

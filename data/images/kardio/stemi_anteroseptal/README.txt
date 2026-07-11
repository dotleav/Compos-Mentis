Put the real image files referenced by stemi_anteroseptal.json here, e.g.:

  ekg_stemi_anteroseptal.png
  rontgen_thorax_normal.png

These are NOT included in this scaffold — supply your own real ECG / rontgen
images (from your docx attachments, textbooks, or teaching archive). The
"image" field in the case JSON just needs to match the filename you place here.

If a docx you're converting has embedded pictures, `scripts/docx-to-case.js`
will auto-extract them into a folder like this one — see that script's output.

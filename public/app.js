const app = document.getElementById("app");

const STEPS = [
  { key: "read", label: "Kasus" },
  { key: "dd1", label: "DD Awal" },
  { key: "anamnesis", label: "Anamnesis" },
  { key: "dd2", label: "DD Revisi 1" },
  { key: "pf", label: "Pem. Fisik" },
  { key: "dd3", label: "DD Revisi 2" },
  { key: "penunjang", label: "Penunjang" },
  { key: "final", label: "Diagnosis Akhir" },
  { key: "plan", label: "Tatalaksana" },
  { key: "reveal", label: "Kunci Jawaban" },
];

let state = null;

function resetState(kasus) {
  state = {
    screen: "session",
    kategori: kasus.kategori,       // kept internally for API calls; NEVER shown in UI
    id: kasus.id,
    kasus,
    ddMaster: state && state.ddMaster ? state.ddMaster : [],
    stepIndex: 0,
    ddInitial: [],
    ddRevisi1: [],
    ddRevisi2: [],
    diagnosisKerja: "",
    diagnosisBanding: [],
    anamnesisHistory: [],
    pfFound: [],   // {id, nama, temuan, signifikan, image}
    penunjangFound: [],
    tatalaksanaPilihan: [],
    edukasiPilihan: [],
    evaluation: null,
    revealData: null,
  };
}

async function api(path, opts) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed (${res.status})`);
  }
  return res.json();
}

// ---------- ROUTING ----------
async function showLanding() {
  const cats = await api("/cases/categories");
  const labels = { psikiatri: "Psikiatri", neurologi: "Neurologi" };
  const selected = new Set(cats); // default: all selected
  app.innerHTML = `
    <h1>CR <span>Simulator</span></h1>
    <p class="muted">Pilih kategori Clinical Reasoning yang ingin dilatih, lalu tekan Mulai. Kasus akan diacak dari kategori yang kamu pilih.</p>
    <div style="margin-top:20px; display:grid; grid-template-columns:1fr 1fr; gap:14px;" id="catGrid">
      ${cats.map((c) => `<div class="card clickable selected" data-cat="${c}" style="cursor:pointer;">
        <div style="font-size:1.5rem;">📋</div>
        <h2 style="margin-top:8px;">${labels[c] || c}</h2>
      </div>`).join("")}
    </div>
    <div class="row" style="margin-top:22px;">
      <button class="btn" id="startBtn">Mulai →</button>
    </div>
    <p class="muted" id="warnMsg" style="margin-top:10px; display:none; color:var(--red);">Pilih minimal satu kategori.</p>
  `;
  app.querySelectorAll("[data-cat]").forEach((el) =>
    el.addEventListener("click", () => {
      const c = el.dataset.cat;
      if (selected.has(c)) { selected.delete(c); el.classList.remove("selected"); }
      else { selected.add(c); el.classList.add("selected"); }
    })
  );
  document.getElementById("startBtn").addEventListener("click", async () => {
    if (selected.size === 0) {
      document.getElementById("warnMsg").style.display = "block";
      return;
    }
    const btn = document.getElementById("startBtn");
    btn.disabled = true;
    btn.textContent = "Menyiapkan kasus...";
    try {
      const kasus = await api("/cases/random", {
        method: "POST",
        body: JSON.stringify({ kategori: [...selected] }),
      });
      resetState(kasus);
      if (state.ddMaster.length === 0) {
        state.ddMaster = await api("/cases/dd-master");
      }
      renderSession();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Mulai →";
      alert(`Gagal memuat kasus: ${e.message}`);
    }
  });
}

// ---------- SESSION SHELL ----------
function renderSession() {
  const stepKey = STEPS[state.stepIndex].key;
  app.innerHTML = `
    <a href="#" class="back" id="backBtn">&larr; Selesai sesi</a>
    <h1 style="margin-top:10px;">Sesi Clinical Reasoning</h1>
    <div class="step-nav" style="margin-top:14px;">
      ${STEPS.map((s, i) => `<span class="step-pill ${i === state.stepIndex ? "active" : i < state.stepIndex ? "done" : ""}">${s.label}</span>`).join("")}
    </div>
    <div id="stepBody"></div>
  `;
  document.getElementById("backBtn").addEventListener("click", (e) => { e.preventDefault(); showLanding(); });
  const body = document.getElementById("stepBody");
  const renderers = {
    read: renderRead,
    dd1: renderDDStep("ddInitial", "Penyakit apa saja yang muncul di benakmu...?", "Tuliskan sebanyak mungkin diagnosis banding yang terpikirkan hanya dari keluhan utama di atas. Gunakan kolom pencarian untuk menemukan nama penyakit."),
    anamnesis: renderAnamnesis,
    dd2: renderDDStep("ddRevisi1", "DD Revisi 1", "Setelah anamnesis, revisi daftar diagnosis bandingmu — eliminasi yang tidak relevan, tambahkan yang baru terpikirkan."),
    pf: renderExamStep("pf"),
    dd3: renderDDStep("ddRevisi2", "DD Revisi 2", "Setelah pemeriksaan fisik, revisi lagi daftar diagnosis bandingmu."),
    penunjang: renderExamStep("penunjang"),
    final: renderFinal,
    plan: renderPlan,
    reveal: renderReveal,
  };
  renderers[stepKey](body);
}

function stepNav(container, { back, next, nextLabel = "Lanjut →", nextDisabled = false }) {
  const div = document.createElement("div");
  div.className = "row between";
  div.style.marginTop = "20px";
  div.innerHTML = `
    <button class="btn secondary" ${back ? "" : "disabled"} id="navBack">← Kembali</button>
    <button class="btn" id="navNext" ${nextDisabled ? "disabled" : ""}>${nextLabel}</button>
  `;
  container.appendChild(div);
  if (back) div.querySelector("#navBack").addEventListener("click", back);
  if (next) div.querySelector("#navNext").addEventListener("click", next);
}

// ---------- STEP 1: READ CASE ----------
function renderRead(body) {
  const k = state.kasus;
  body.innerHTML = `
    <div class="card">
      <h2 style="font-size:1.2rem;">Bacalah kasus!</h2>
      <p class="muted" style="margin-top:8px;">Identitas: ${k.identitas}</p>
      <div class="card" style="background:var(--surface2); margin-top:14px;">
        <div class="muted" style="text-transform:uppercase; font-size:0.72rem; margin-bottom:6px;">Keluhan Utama</div>
        <div>${k.keluhanUtama}</div>
      </div>
      <div class="card" style="background:var(--surface2); margin-top:14px;">
        <div class="muted" style="text-transform:uppercase; font-size:0.72rem; margin-bottom:6px;">Tugas Anda</div>
        <div>Tentukan <strong>1 diagnosis kerja</strong> dan <strong>1 diagnosis banding</strong>, lakukan anamnesis, berikan pemeriksaan fisik dan pemeriksaan penunjang yang relevan, serta berikan tatalaksana yang lege artis dan edukasi yang tepat.</div>
      </div>
    </div>`;
  stepNav(body, { back: null, next: () => { state.stepIndex++; renderSession(); } });
}

// ---------- SEARCHABLE DIAGNOSIS PICKER (shared by DD1/DD2/DD3/Final) ----------
function renderDiagnosisPicker(container, opts) {
  const {
    selectedArr, onChange, maxSelect = null, singleSelect = false,
    excludeArr = [], placeholder = "Cari nama penyakit...",
  } = opts;
  const master = state.ddMaster || [];
  const selected = new Set(selectedArr);
  const exclude = new Set(excludeArr);

  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <input type="text" id="ddSearch" placeholder="${placeholder}" style="margin-bottom:12px;">
    <div id="ddSelected" class="row" style="margin-bottom:10px;"></div>
    <div id="ddOptions" class="row"></div>
  `;
  container.appendChild(wrap);

  function renderSelected() {
    const el = wrap.querySelector("#ddSelected");
    if (selected.size === 0) {
      el.innerHTML = `<p class="muted" style="font-size:0.8rem;">Belum ada yang dipilih.</p>`;
      return;
    }
    el.innerHTML = [...selected].map((s) =>
      `<div class="chip selected" data-remove="${encodeURIComponent(s)}">${s} ✕</div>`
    ).join("");
    el.querySelectorAll("[data-remove]").forEach((chip) => chip.addEventListener("click", () => {
      selected.delete(decodeURIComponent(chip.dataset.remove));
      onChange([...selected]);
      renderSelected();
      renderOptions(wrap.querySelector("#ddSearch").value);
    }));
  }

  function renderOptions(query) {
    const el = wrap.querySelector("#ddOptions");
    const q = (query || "").trim().toLowerCase();
    let list = master.filter((m) => !selected.has(m) && !exclude.has(m));
    if (q) list = list.filter((m) => m.toLowerCase().includes(q));
    const capped = list.slice(0, 40);
    if (capped.length === 0) {
      el.innerHTML = `<p class="muted" style="font-size:0.8rem;">Tidak ada hasil.</p>`;
      return;
    }
    el.innerHTML = capped.map((m) => `<div class="chip" data-add="${encodeURIComponent(m)}">${m}</div>`).join("")
      + (list.length > capped.length ? `<p class="muted" style="font-size:0.75rem; width:100%; margin-top:6px;">Ketik untuk mempersempit (${list.length} hasil)...</p>` : "");
    el.querySelectorAll("[data-add]").forEach((chip) => chip.addEventListener("click", () => {
      if (maxSelect && selected.size >= maxSelect) {
        if (singleSelect) selected.clear();
        else return;
      }
      selected.add(decodeURIComponent(chip.dataset.add));
      onChange([...selected]);
      renderSelected();
      renderOptions(wrap.querySelector("#ddSearch").value);
    }));
  }

  wrap.querySelector("#ddSearch").addEventListener("input", (e) => renderOptions(e.target.value));
  renderSelected();
  renderOptions("");
}

// ---------- DD STEPS (dd1 / dd2 / dd3) ----------
function renderDDStep(stateKey, title, instructions) {
  return (body) => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<h2 style="font-size:1.05rem;">${title}</h2><p class="muted" style="margin:6px 0 14px;">${instructions}</p>`;
    body.appendChild(card);
    renderDiagnosisPicker(card, {
      selectedArr: state[stateKey],
      onChange: (arr) => { state[stateKey] = arr; },
    });
    stepNav(body, {
      back: () => { state.stepIndex--; renderSession(); },
      next: () => { state.stepIndex++; renderSession(); },
    });
  };
}

// ---------- STEP 3: ANAMNESIS (AI patient chat) ----------
function renderAnamnesis(body) {
  body.innerHTML = `
    <div class="card">
      <h2 style="font-size:1.05rem; margin-bottom:12px;">Anamnesis</h2>
      <p class="muted" style="margin-bottom:12px;">Ajukan pertanyaan seperti pada pasien sungguhan. Pasien akan menjawab sesuai perannya.</p>
      <div class="chat-log" id="chatLog"></div>
      <div class="row">
        <input type="text" id="chatInput" placeholder="Tulis pertanyaan untuk pasien..." style="flex:1;">
        <button class="btn" id="chatSend">Kirim</button>
      </div>
    </div>`;
  renderChatLog();
  const input = document.getElementById("chatInput");
  const send = async () => {
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    state.anamnesisHistory.push({ role: "user", content: message });
    renderChatLog();
    appendLoadingBubble();
    try {
      const { reply } = await api("/chat/anamnesis", {
        method: "POST",
        body: JSON.stringify({
          kategori: state.kategori, id: state.id,
          history: state.anamnesisHistory.slice(0, -1),
          message,
        }),
      });
      state.anamnesisHistory.push({ role: "assistant", content: reply });
    } catch (e) {
      state.anamnesisHistory.push({ role: "assistant", content: `[Error: ${e.message}]` });
    }
    renderChatLog();
  };
  document.getElementById("chatSend").addEventListener("click", send);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });

  stepNav(body, {
    back: () => { state.stepIndex--; renderSession(); },
    next: () => { state.stepIndex++; renderSession(); },
  });
}

function renderChatLog() {
  const log = document.getElementById("chatLog");
  if (!log) return;
  log.innerHTML = state.anamnesisHistory.map((h) =>
    `<div class="bubble ${h.role === "user" ? "user" : "patient"}">${escapeHtml(h.content)}</div>`
  ).join("") || `<div class="bubble system">Mulai dengan menyapa pasien...</div>`;
  log.scrollTop = log.scrollHeight;
}

function appendLoadingBubble() {
  const log = document.getElementById("chatLog");
  if (!log) return;
  const div = document.createElement("div");
  div.className = "bubble patient loading";
  div.id = "loadingBubble";
  div.textContent = "Pasien sedang menjawab...";
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// ---------- PF / PENUNJANG (AI matching) ----------
function renderExamStep(step) {
  return (body) => {
    const isPf = step === "pf";
    const found = isPf ? state.pfFound : state.penunjangFound;
    body.innerHTML = `
      <div class="card">
        <h2 style="font-size:1.05rem; margin-bottom:8px;">${isPf ? "Pemeriksaan Fisik" : "Pemeriksaan Penunjang"}</h2>
        <p class="muted" style="margin-bottom:12px;">${isPf ? "Ketik pemeriksaan fisik yang ingin Anda lakukan (mis. \"auskultasi jantung\")." : "Ketik pemeriksaan penunjang yang ingin Anda pesan (mis. \"EKG\", \"cek troponin\")."}</p>
        <div class="row">
          <input type="text" id="examInput" placeholder="Ketik di sini..." style="flex:1;">
          <button class="btn" id="examSend">Lakukan</button>
        </div>
        <div id="examStatus" class="loading" style="margin-top:8px; display:none;">Mencari pemeriksaan yang cocok...</div>
        <div id="examResults" style="margin-top:16px;"></div>
      </div>`;
    renderExamResults(found);
    const input = document.getElementById("examInput");
    const status = document.getElementById("examStatus");
    const send = async () => {
      const query = input.value.trim();
      if (!query) return;
      input.value = "";
      status.style.display = "block";
      try {
        const doneIds = found.map((f) => f.id);
        const { results } = await api("/exam/perform", {
          method: "POST",
          body: JSON.stringify({ kategori: state.kategori, id: state.id, step, query, done: doneIds }),
        });
        results.forEach((r) => {
          if (r.id && doneIds.includes(r.id)) return; // already revealed
          found.push(r);
        });
      } catch (e) {
        found.push({ nama: query, temuan: `[Error: ${e.message}]`, signifikan: false });
      }
      status.style.display = "none";
      renderExamResults(found);
    };
    document.getElementById("examSend").addEventListener("click", send);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });

    stepNav(body, {
      back: () => { state.stepIndex--; renderSession(); },
      next: () => { state.stepIndex++; renderSession(); },
    });
  };
}

function renderExamResults(found) {
  const el = document.getElementById("examResults");
  if (!el) return;
  if (found.length === 0) {
    el.innerHTML = `<p class="muted">Belum ada pemeriksaan yang dilakukan.</p>`;
    return;
  }
  el.innerHTML = found.map((f) => `
    <div class="finding-card ${f.signifikan ? "signifikan" : ""}">
      <div class="nama">${f.nama}</div>
      <div>${f.temuan}</div>
      ${f.image ? `<img src="${f.image}" alt="${f.nama}">` : ""}
    </div>`).join("");
}

// ---------- STEP 8: FINAL DIAGNOSIS (1 DK + 2 DB) ----------
function renderFinal(body) {
  const dkCard = document.createElement("div");
  dkCard.className = "card";
  dkCard.innerHTML = `<h2 style="font-size:1.05rem;">Diagnosis Kerja</h2><p class="muted" style="margin:6px 0 14px;">Pilih SATU diagnosis kerja utama berdasarkan seluruh temuan.</p>`;
  body.appendChild(dkCard);
  renderDiagnosisPicker(dkCard, {
    selectedArr: state.diagnosisKerja ? [state.diagnosisKerja] : [],
    onChange: (arr) => { state.diagnosisKerja = arr[0] || ""; renderFinalDbSection(); },
    maxSelect: 1,
    singleSelect: true,
    placeholder: "Cari diagnosis kerja...",
  });

  const dbCard = document.createElement("div");
  dbCard.className = "card";
  dbCard.id = "dbCard";
  body.appendChild(dbCard);
  renderFinalDbSection();

  function renderFinalDbSection() {
    document.getElementById("dbCard").innerHTML = `<h2 style="font-size:1.05rem;">Diagnosis Banding</h2><p class="muted" style="margin:6px 0 14px;">Pilih DUA diagnosis banding pendamping.</p>`;
    renderDiagnosisPicker(document.getElementById("dbCard"), {
      selectedArr: state.diagnosisBanding,
      onChange: (arr) => { state.diagnosisBanding = arr; },
      maxSelect: 2,
      singleSelect: false,
      excludeArr: state.diagnosisKerja ? [state.diagnosisKerja] : [],
      placeholder: "Cari diagnosis banding...",
    });
  }

  stepNav(body, {
    back: () => { state.stepIndex--; renderSession(); },
    next: () => { state.stepIndex++; renderSession(); },
    nextDisabled: false,
  });
}

// ---------- STEP 9: TATALAKSANA + EDUKASI ----------
function renderPlan(body) {
  const k = state.kasus;
  const tSel = new Set(state.tatalaksanaPilihan);
  const eSel = new Set(state.edukasiPilihan);
  body.innerHTML = `
    <div class="card">
      <h2 style="font-size:1.05rem;">Tatalaksana (Medikamentosa)</h2>
      <p class="muted" style="margin:8px 0 12px;">Pilih semua resep yang tepat, sesuai kaidah penulisan resep.</p>
      <div class="row" id="tChips">
        ${k.tatalaksanaPilihan.map((o) => `<div class="chip rx ${tSel.has(o) ? "selected" : ""}" data-o="${encodeURIComponent(o)}">${escapeHtml(o)}</div>`).join("")}
      </div>
    </div>
    <div class="card">
      <h2 style="font-size:1.05rem;">Edukasi</h2>
      <p class="muted" style="margin:8px 0 12px;">Pilih semua edukasi yang tepat.</p>
      <div class="row" id="eChips">
        ${k.edukasiPilihan.map((o) => `<div class="chip ${eSel.has(o) ? "selected" : ""}" data-o="${encodeURIComponent(o)}">${escapeHtml(o)}</div>`).join("")}
      </div>
    </div>`;
  body.querySelectorAll("#tChips .chip").forEach((chip) => chip.addEventListener("click", () => {
    const o = decodeURIComponent(chip.dataset.o);
    tSel.has(o) ? tSel.delete(o) : tSel.add(o);
    state.tatalaksanaPilihan = [...tSel];
    chip.classList.toggle("selected");
  }));
  body.querySelectorAll("#eChips .chip").forEach((chip) => chip.addEventListener("click", () => {
    const o = decodeURIComponent(chip.dataset.o);
    eSel.has(o) ? eSel.delete(o) : eSel.add(o);
    state.edukasiPilihan = [...eSel];
    chip.classList.toggle("selected");
  }));
  stepNav(body, {
    back: () => { state.stepIndex--; renderSession(); },
    next: async () => {
      state.evaluation = await api(`/cases/${state.kategori}/${state.id}/evaluate`, {
        method: "POST",
        body: JSON.stringify({
          diagnosisKerja: state.diagnosisKerja,
          diagnosisBanding: state.diagnosisBanding,
          tatalaksanaPilihan: state.tatalaksanaPilihan,
          edukasiPilihan: state.edukasiPilihan,
        }),
      });
      state.stepIndex++;
      renderSession();
    },
  });
}

// ---------- STEP 10: REVEAL ----------
async function renderReveal(body) {
  body.innerHTML = `<p class="loading">Memuat kunci jawaban...</p>`;
  if (!state.revealData) {
    state.revealData = await api(`/cases/${state.kategori}/${state.id}/reveal`);
  }
  const truth = state.revealData;
  const ev = state.evaluation;
  body.innerHTML = `
    <div class="card">
      <h2 style="font-size:1.1rem; color:${ev.dk.correct ? "var(--green)" : "var(--red)"};">
        Diagnosis Kerja Anda: ${ev.dk.pilihan || "(belum dipilih)"} ${ev.dk.correct ? "✓ Benar" : "✗"}
      </h2>
      <p class="muted" style="margin-top:6px;">Diagnosis kerja yang benar: <strong style="color:var(--text);">${truth.dd.benar}</strong></p>
      <h3 style="font-size:0.95rem; margin-top:14px; margin-bottom:8px;">Diagnosis Banding Anda</h3>
      ${ev.db.result.length ? ev.db.result.map((r) => `<div class="chip ${r.benar ? "correct" : "incorrect"}" style="margin:4px 6px 4px 0; display:inline-flex;">${r.opsi} ${r.benar ? "✓" : "✗"}</div>`).join("") : `<p class="muted">(belum dipilih)</p>`}
      ${ev.db.missed.length ? `<p class="muted" style="margin-top:10px;">Diagnosis banding relevan lain: ${ev.db.missed.join("; ")}</p>` : ""}
    </div>
    <div class="card">
      <h3 style="font-size:0.95rem; margin-bottom:10px;">Tatalaksana</h3>
      ${ev.tatalaksana.result.map((r) => `<div class="chip rx ${r.benar ? "correct" : "incorrect"}" style="margin:4px 6px 4px 0; display:inline-flex;">${escapeHtml(r.opsi)} ${r.benar ? "✓" : "✗"}</div>`).join("")}
      ${ev.tatalaksana.missed.length ? `<p class="muted" style="margin-top:10px;">Terlewat: ${ev.tatalaksana.missed.map(escapeHtml).join("; ")}</p>` : ""}
    </div>
    <div class="card">
      <h3 style="font-size:0.95rem; margin-bottom:10px;">Edukasi</h3>
      ${ev.edukasi.result.map((r) => `<div class="chip ${r.benar ? "correct" : "incorrect"}" style="margin:4px 6px 4px 0; display:inline-flex;">${r.opsi} ${r.benar ? "✓" : "✗"}</div>`).join("")}
      ${ev.edukasi.missed.length ? `<p class="muted" style="margin-top:10px;">Terlewat: ${ev.edukasi.missed.join("; ")}</p>` : ""}
    </div>
    <div class="card">
      <h3 style="font-size:0.95rem; margin-bottom:10px;">Riwayat Lengkap (Ground Truth)</h3>
      <p style="margin-bottom:6px;"><strong>RPS:</strong> ${truth.groundTruth.riwayat.rps.join("; ")}</p>
      <p style="margin-bottom:6px;"><strong>RPD:</strong> ${truth.groundTruth.riwayat.rpd}</p>
      <p style="margin-bottom:6px;"><strong>RPK:</strong> ${truth.groundTruth.riwayat.rpk}</p>
      <p><strong>Lifestyle:</strong> ${truth.groundTruth.riwayat.lifestyle.join("; ")}</p>
    </div>`;
  const nav = document.createElement("div");
  nav.className = "row";
  nav.style.marginTop = "20px";
  nav.innerHTML = `<button class="btn secondary" id="restart">Sesi Baru</button>`;
  body.appendChild(nav);
  document.getElementById("restart").addEventListener("click", () => showLanding());
}

// ---------- utils ----------
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

showLanding();

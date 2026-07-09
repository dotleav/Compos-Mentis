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

function resetState(kategori, id) {
  state = {
    screen: "session",
    kategori,
    id,
    kasus: null,
    stepIndex: 0,
    ddInitial: [],
    ddRevisi1: [],
    ddRevisi2: [],
    diagnosisAkhir: "",
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
async function showCategories() {
  const cats = await api("/cases/categories");
  app.innerHTML = `
    <h1>OSCE <span>AI Simulator</span></h1>
    <p class="muted">Pilih kategori kasus untuk memulai simulasi.</p>
    <div style="margin-top:20px; display:grid; grid-template-columns:1fr 1fr; gap:14px;">
      ${cats.map((c) => `<div class="card clickable" data-cat="${c}" style="cursor:pointer;">
        <div style="font-size:1.5rem;">📋</div>
        <h2 style="margin-top:8px; text-transform:capitalize;">${c}</h2>
      </div>`).join("")}
    </div>`;
  app.querySelectorAll("[data-cat]").forEach((el) =>
    el.addEventListener("click", () => showCaseList(el.dataset.cat))
  );
}

async function showCaseList(kategori) {
  const cases = await api(`/cases/${kategori}`);
  app.innerHTML = `
    <a href="#" class="back" id="backBtn">&larr; Kategori</a>
    <h1 style="margin-top:10px; text-transform:capitalize;">${kategori}</h1>
    <div style="margin-top:16px;">
      ${cases.map((c) => `<div class="card clickable" data-id="${c.id}" style="cursor:pointer;">
        <h2 style="font-size:1rem;">${c.nama}</h2>
        <p class="muted" style="margin-top:6px;">${c.judulKasus}</p>
      </div>`).join("")}
    </div>`;
  document.getElementById("backBtn").addEventListener("click", (e) => { e.preventDefault(); showCategories(); });
  app.querySelectorAll("[data-id]").forEach((el) =>
    el.addEventListener("click", () => startSession(kategori, el.dataset.id))
  );
}

async function startSession(kategori, id) {
  resetState(kategori, id);
  state.kasus = await api(`/cases/${kategori}/${id}`);
  renderSession();
}

// ---------- SESSION SHELL ----------
function renderSession() {
  const stepKey = STEPS[state.stepIndex].key;
  app.innerHTML = `
    <a href="#" class="back" id="backBtn">&larr; Daftar kasus</a>
    <h1 style="margin-top:10px;">${state.kasus.nama}</h1>
    <div class="step-nav" style="margin-top:14px;">
      ${STEPS.map((s, i) => `<span class="step-pill ${i === state.stepIndex ? "active" : i < state.stepIndex ? "done" : ""}">${s.label}</span>`).join("")}
    </div>
    <div id="stepBody"></div>
  `;
  document.getElementById("backBtn").addEventListener("click", (e) => { e.preventDefault(); showCaseList(state.kategori); });
  const body = document.getElementById("stepBody");
  const renderers = {
    read: renderRead,
    dd1: renderDD("dd1", "Diagnosis Banding Awal", "Berdasarkan keluhan utama saja, tuliskan diagnosis banding awal Anda."),
    anamnesis: renderAnamnesis,
    dd2: renderDD("dd2", "Revisi DD setelah Anamnesis", "Eliminasi/tambahkan DD berdasarkan hasil anamnesis."),
    pf: renderExamStep("pf"),
    dd3: renderDD("dd3", "Revisi DD setelah Pemeriksaan Fisik", "Eliminasi/tambahkan DD lagi berdasarkan hasil PF."),
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
      <h2 style="font-size:1.1rem;">${k.judulKasus}</h2>
      <p class="muted" style="margin-top:10px;">Identitas: ${k.identitas.nama}, ${k.identitas.usia} tahun, ${k.identitas.pekerjaan}</p>
      <div class="card" style="background:var(--surface2); margin-top:14px;">
        <div class="muted" style="text-transform:uppercase; font-size:0.72rem; margin-bottom:6px;">Keluhan Utama</div>
        <div>${k.keluhanUtama}</div>
      </div>
    </div>`;
  stepNav(body, { back: null, next: () => { state.stepIndex++; renderSession(); } });
}

// ---------- DD STEPS (dd1 / dd2 / dd3) ----------
function renderDD(stateKey, title, instructions) {
  return (body) => {
    const k = state.kasus;
    const selected = new Set(state[stateKey]);
    body.innerHTML = `
      <div class="card">
        <h2 style="font-size:1.05rem;">${title}</h2>
        <p class="muted" style="margin-top:6px;">${instructions}</p>
        <div class="row" style="margin-top:16px;" id="ddChips">
          ${k.ddPilihan.map((opsi) => `<div class="chip ${selected.has(opsi) ? "selected" : ""}" data-opsi="${encodeURIComponent(opsi)}">${opsi}</div>`).join("")}
        </div>
      </div>`;
    body.querySelectorAll("#ddChips .chip").forEach((chip) =>
      chip.addEventListener("click", () => {
        const opsi = decodeURIComponent(chip.dataset.opsi);
        if (selected.has(opsi)) selected.delete(opsi); else selected.add(opsi);
        state[stateKey] = [...selected];
        chip.classList.toggle("selected");
      })
    );
    stepNav(body, {
      back: () => { state.stepIndex--; renderSession(); },
      next: () => { state.stepIndex++; renderSession(); },
      nextDisabled: false,
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

// ---------- STEP 8: FINAL DIAGNOSIS ----------
function renderFinal(body) {
  const k = state.kasus;
  body.innerHTML = `
    <div class="card">
      <h2 style="font-size:1.05rem;">Diagnosis Akhir</h2>
      <p class="muted" style="margin:8px 0 14px;">Tetapkan SATU diagnosis kerja utama berdasarkan seluruh temuan.</p>
      <div class="row" id="finalChips">
        ${k.ddPilihan.map((opsi) => `<div class="chip ${state.diagnosisAkhir === opsi ? "selected" : ""}" data-opsi="${encodeURIComponent(opsi)}">${opsi}</div>`).join("")}
      </div>
    </div>`;
  body.querySelectorAll("#finalChips .chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      state.diagnosisAkhir = decodeURIComponent(chip.dataset.opsi);
      body.querySelectorAll("#finalChips .chip").forEach((c) => c.classList.remove("selected"));
      chip.classList.add("selected");
    })
  );
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
      <p class="muted" style="margin:8px 0 12px;">Pilih semua tatalaksana yang tepat.</p>
      <div class="row" id="tChips">
        ${k.tatalaksanaPilihan.map((o) => `<div class="chip ${tSel.has(o) ? "selected" : ""}" data-o="${encodeURIComponent(o)}">${o}</div>`).join("")}
      </div>
    </div>
    <div class="card">
      <h2 style="font-size:1.05rem;">Edukasi</h2>
      <p class="muted" style="margin:8px 0 12px;">Pilih semua edukasi yang tepat.</p>
      <div class="row" id="eChips">
        ${k.edukasiPilihan.map((o) => `<div class="chip ${eSel.has(o) ? "selected" : ""}" data-o="${encodeURIComponent(o)}">${o}</div>`).join("")}
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
          ddPilihan: state.diagnosisAkhir,
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
      <h2 style="font-size:1.1rem; color:${ev.dd.correct ? "var(--green)" : "var(--red)"};">
        Diagnosis Anda: ${ev.dd.pilihan || "(belum dipilih)"} ${ev.dd.correct ? "✓ Benar" : "✗"}
      </h2>
      <p class="muted" style="margin-top:6px;">Diagnosis yang benar: <strong style="color:var(--text);">${truth.dd.benar}</strong></p>
    </div>
    <div class="card">
      <h3 style="font-size:0.95rem; margin-bottom:10px;">Tatalaksana</h3>
      ${ev.tatalaksana.result.map((r) => `<div class="chip ${r.benar ? "correct" : "incorrect"}" style="margin:4px 6px 4px 0; display:inline-flex;">${r.opsi} ${r.benar ? "✓" : "✗"}</div>`).join("")}
      ${ev.tatalaksana.missed.length ? `<p class="muted" style="margin-top:10px;">Terlewat: ${ev.tatalaksana.missed.join("; ")}</p>` : ""}
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
  nav.innerHTML = `<button class="btn secondary" id="restart">Kembali ke Daftar Kasus</button>`;
  body.appendChild(nav);
  document.getElementById("restart").addEventListener("click", () => showCaseList(state.kategori));
}

// ---------- utils ----------
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

showCategories();

const app = document.getElementById("app");

const STASE_LABELS = {
  endokrin: "Endokrin & Metabolik",
  gastro: "Gastroenterologi",
  genitourinaria: "Genitourinaria",
  hematoimun: "Hemato-Imunologi",
  integumen: "Integumen",
  kardio: "Kardiologi",
  respi: "Respirologi",
  mata: "Mata (Oftalmologi)",
  muskuloskeletal: "Muskuloskeletal",
  neurologi: "Neurologi",
  psikiatri: "Psikiatri",
  tht: "THT",
  lainnya: "Lainnya",
};

let rxCardSeq = 0;

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

// ---------- SESSION PERSISTENCE (sessionStorage) ----------
// sessionStorage (not localStorage) is used on purpose: it's scoped to
// this one tab, lives in memory rather than being written into the
// browser's disk cache/history, and disappears automatically the moment
// the tab is closed — no manual cleanup needed for the "don't bloat
// Chrome" concern. We still explicitly clear it the moment a session
// legitimately ends (back to landing / starts a new session) so a
// half-finished attempt never lingers even within the same tab.
const SESSION_STORAGE_KEY = "osce-active-session";

function saveSessionToStorage() {
  if (!state) return;
  try { sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* storage full/unavailable — session just won't survive a refresh, not fatal */ }
}
function loadSessionFromStorage() {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function clearSessionStorage() {
  try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch (e) {}
}
// Safety net: catch any in-progress edit (a checkbox ticked, text typed
// into a textarea) that hasn't hit an explicit save point yet, right
// before an accidental refresh/close actually happens.
window.addEventListener("beforeunload", saveSessionToStorage);

function resetState(kasus) {
  state = {
    screen: "session",
    kategori: kasus.kategori,       // kept internally for API calls; NEVER shown in UI
    id: kasus.id,
    kasus,
    ddMaster: state && state.ddMaster ? state.ddMaster : [],
    ddMasterGrouped: state && state.ddMasterGrouped ? state.ddMasterGrouped : null,
    stepIndex: 0,
    ddInitial: [],
    ddRevisi1: [],
    ddRevisi2: [],
    ddRevisi1Seeded: false,
    ddRevisi2Seeded: false,
    ddFinalSeeded: false,
    diagnosisKerja: "",
    diagnosisBanding: [],
    anamnesisHistory: [],
    pfFound: [],   // {id, nama, temuan, signifikan, image}
    penunjangFound: [],
    resepCards: [],        // {id, invocatio, signatura}
    activeResepId: null,
    edukasiJawaban: "",
    temuanLaporan: {},     // { [findingId]: essayText } — student's own report for image findings with wajibLapor
    evaluation: null,
    revealData: null,
  };
}

async function api(path, opts) {
  const startedAt = performance.now();
  const logEntry = { time: new Date().toLocaleTimeString("id-ID"), endpoint: path, status: "…", provider: null, detail: null, latency: null };
  try {
    const res = await fetch(`/api${path}`, {
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    logEntry.latency = Math.round(performance.now() - startedAt);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      logEntry.status = "GAGAL";
      logEntry.detail = err.detail || err.error || `HTTP ${res.status}`;
      pushDevLog(logEntry);
      const e = new Error(err.error || `Request failed (${res.status})`);
      e.detail = err.detail;
      e.status = res.status;
      throw e;
    }
    const data = await res.json();
    logEntry.status = "OK";
    logEntry.provider = data._provider || null;
    pushDevLog(logEntry);
    return data;
  } catch (err) {
    if (logEntry.status === "…") {
      // Failed before we even got an HTTP response (network error, CORS, etc).
      logEntry.status = "GAGAL";
      logEntry.detail = err.message;
      logEntry.latency = Math.round(performance.now() - startedAt);
      pushDevLog(logEntry);
    }
    throw err;
  }
}

function pushDevLog(entry) {
  window.__devLog = window.__devLog || [];
  window.__devLog.unshift(entry);
  if (window.__devLog.length > 60) window.__devLog.length = 60;
  window.dispatchEvent(new CustomEvent("devlog:update"));
}

// ---------- ROUTING ----------
async function showLanding() {
  const cats = await api("/cases/categories");
  const selected = new Set(cats); // default: all selected

  function allSelectLabel() {
    return selected.size === cats.length ? "Batalkan Semua" : "Pilih Semua";
  }

  app.innerHTML = `
    <h1>CR <span>Simulator</span></h1>
    <p class="muted">Pilih kategori/Stase Clinical Reasoning yang ingin dilatih, lalu tekan Mulai. Kasus akan diacak dari kategori yang kamu pilih.</p>
    <div class="cat-toolbar">
      <button class="btn secondary" id="selectAllBtn">${allSelectLabel()}</button>
    </div>
    <div style="display:flex; flex-direction:column; gap:8px;" id="catGrid">
      ${cats.map((c) => `<div class="cat-check selected" data-cat="${c}">
        <span class="box"></span>
        <span class="label">${STASE_LABELS[c] || c}</span>
      </div>`).join("")}
    </div>
    <div class="row" style="margin-top:22px;">
      <button class="btn" id="startBtn">Mulai →</button>
    </div>
    <p class="muted" id="warnMsg" style="margin-top:10px; display:none; color:var(--red);">Pilih minimal satu kategori.</p>

    <div class="card" id="devCasePicker" style="display:none; margin-top:22px;">
      <h3 class="dev-picker-title">Dev Mode — Pilih Kasus Manual</h3>
      <label class="dev-picker-label muted" for="devCatSelect">Kategori</label>
      <select id="devCatSelect">
        ${cats.map((c) => `<option value="${c}">${STASE_LABELS[c] || c}</option>`).join("")}
      </select>
      <label class="dev-picker-label muted" for="devCaseSelect">Kasus</label>
      <select id="devCaseSelect"><option>Memuat...</option></select>
      <button class="btn secondary" id="devCaseStartBtn">Mulai dengan Kasus Ini →</button>
      <p class="muted" id="devCaseWarn" style="margin-top:10px; display:none; color:var(--red); font-size:0.78rem;"></p>
    </div>
  `;
  app.querySelectorAll("[data-cat]").forEach((el) =>
    el.addEventListener("click", () => {
      const c = el.dataset.cat;
      if (selected.has(c)) { selected.delete(c); el.classList.remove("selected"); }
      else { selected.add(c); el.classList.add("selected"); }
      document.getElementById("selectAllBtn").textContent = allSelectLabel();
    })
  );
  document.getElementById("selectAllBtn").addEventListener("click", () => {
    const shouldSelectAll = selected.size !== cats.length;
    selected.clear();
    app.querySelectorAll("[data-cat]").forEach((el) => {
      if (shouldSelectAll) { selected.add(el.dataset.cat); el.classList.add("selected"); }
      else { el.classList.remove("selected"); }
    });
    document.getElementById("selectAllBtn").textContent = allSelectLabel();
  });  document.getElementById("startBtn").addEventListener("click", async () => {
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
      if (!state.ddMasterGrouped) {
        state.ddMasterGrouped = await api("/cases/dd-master-grouped");
      }
      renderSession();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Mulai →";
      alert(`Gagal memuat kasus: ${e.message}`);
    }
  });

  // ---- Dev Mode: manual case picker ----
  // Lets a dev-unlocked user (see DevMode in index.html) skip the random
  // draw and jump straight into a specific case — handy for checking a
  // case you just wrote/converted without rerolling until it comes up.
  // Uses the same client-safe endpoints as the normal flow (GET
  // /api/cases/:kategori and /:kategori/:id — both already withhold
  // groundTruth), so there's nothing extra to lock down server-side.
  const devPicker = document.getElementById("devCasePicker");
  const devCatSelect = document.getElementById("devCatSelect");
  const devCaseSelect = document.getElementById("devCaseSelect");
  const devCaseWarn = document.getElementById("devCaseWarn");
  let devCaseListCache = {}; // kategori -> stripped case list, so switching back and forth doesn't refetch

  async function loadDevCaseOptions(kategori) {
    devCaseSelect.innerHTML = `<option>Memuat...</option>`;
    devCaseWarn.style.display = "none";
    try {
      if (!devCaseListCache[kategori]) {
        devCaseListCache[kategori] = await api(`/cases/${kategori}`);
      }
      const list = devCaseListCache[kategori];
      if (list.length === 0) {
        devCaseSelect.innerHTML = `<option value="">(tidak ada kasus)</option>`;
        return;
      }
      devCaseSelect.innerHTML = list
        .map((c) => `<option value="${c.id}">${c.id} — ${c.judulKasus || c.nama || "(tanpa judul)"}${c.level ? ` [${c.level}]` : ""}</option>`)
        .join("");
    } catch (e) {
      devCaseSelect.innerHTML = `<option value="">(gagal memuat)</option>`;
      devCaseWarn.textContent = `Gagal memuat daftar kasus: ${e.message}`;
      devCaseWarn.style.display = "block";
    }
  }

  devCatSelect.addEventListener("change", () => loadDevCaseOptions(devCatSelect.value));

  document.getElementById("devCaseStartBtn").addEventListener("click", async () => {
    const kategori = devCatSelect.value;
    const id = devCaseSelect.value;
    if (!kategori || !id) {
      devCaseWarn.textContent = "Pilih kategori dan kasus dulu.";
      devCaseWarn.style.display = "block";
      return;
    }
    const btn = document.getElementById("devCaseStartBtn");
    btn.disabled = true;
    btn.textContent = "Menyiapkan kasus...";
    try {
      const kasus = await api(`/cases/${kategori}/${id}`);
      resetState(kasus);
      if (state.ddMaster.length === 0) {
        state.ddMaster = await api("/cases/dd-master");
      }
      if (!state.ddMasterGrouped) {
        state.ddMasterGrouped = await api("/cases/dd-master-grouped");
      }
      renderSession();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Mulai dengan Kasus Ini →";
      devCaseWarn.textContent = `Gagal memuat kasus: ${e.message}`;
      devCaseWarn.style.display = "block";
    }
  });

  function syncDevCasePicker() {
    if (!devPicker) return;
    const on = !!window.__devModeOn;
    devPicker.style.display = on ? "block" : "none";
    if (on && devCaseSelect.dataset.loaded !== "1") {
      devCaseSelect.dataset.loaded = "1";
      loadDevCaseOptions(devCatSelect.value);
    }
  }
  syncDevCasePicker();
  // DevMode (in index.html) calls this whenever the panel is unlocked/toggled
  // while the landing screen happens to be showing, so the picker can appear
  // without the user having to navigate away and back.
  window.__onDevModeChange = syncDevCasePicker;
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
  document.getElementById("backBtn").addEventListener("click", (e) => { e.preventDefault(); clearSessionStorage(); showLanding(); });
  // Let a vertical mouse wheel/trackpad scroll the step tabs horizontally
  // (desktop/web). Touch devices already scroll it natively by dragging —
  // this only kicks in for wheel input, so it doesn't fight touch scrolling.
  const stepNavEl = app.querySelector(".step-nav");
  if (stepNavEl) {
    stepNavEl.addEventListener("wheel", (e) => {
      if (stepNavEl.scrollWidth <= stepNavEl.clientWidth) return; // nothing to scroll
      const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (delta === 0) return;
      e.preventDefault();
      stepNavEl.scrollLeft += delta;
    }, { passive: false });
  }
  const body = document.getElementById("stepBody");
  const renderers = {
    read: renderRead,
    dd1: renderDDStep("ddInitial", "Penyakit apa saja yang muncul di benakmu...?", "Tuliskan sebanyak mungkin diagnosis banding yang terpikirkan hanya dari keluhan utama di atas. Gunakan kolom pencarian untuk menemukan nama penyakit."),
    anamnesis: renderAnamnesis,
    dd2: renderDDStep("ddRevisi1", "DD Revisi 1", "Setelah anamnesis, revisi daftar diagnosis bandingmu — eliminasi yang tidak relevan, tambahkan yang baru terpikirkan.", { carryFromKey: "ddInitial", seededFlagKey: "ddRevisi1Seeded" }),
    pf: renderExamStep("pf"),
    dd3: renderDDStep("ddRevisi2", "DD Revisi 2", "Setelah pemeriksaan fisik, revisi lagi daftar diagnosis bandingmu.", { carryFromKey: "ddRevisi1", seededFlagKey: "ddRevisi2Seeded" }),
    penunjang: renderExamStep("penunjang"),
    final: renderFinal,
    plan: renderPlan,
    reveal: renderReveal,
  };
  renderers[stepKey](body);
  saveSessionToStorage();
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
      <div class="card" style="background:var(--surface2); margin-top:14px;">
        <div class="muted" style="text-transform:uppercase; font-size:0.72rem; margin-bottom:6px;">Skenario</div>
        <div>${k.skenarioAwal}</div>
      </div>
      <p class="muted" style="margin-top:10px; font-size:0.82rem;">Identitas lengkap (nama, pekerjaan, alamat) dan keluhan detail pasien belum diketahui — gali semuanya lewat anamnesis.</p>
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

  const grouped = state.ddMasterGrouped || {};
  const openStase = new Set();
  let mode = "cari"; // "cari" | "stase"

  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="dd-mode-tabs">
      <button type="button" class="dd-mode-tab active" data-mode="cari">🔍 Cari</button>
      <button type="button" class="dd-mode-tab" data-mode="stase">🗂 Jelajahi Stase</button>
    </div>
    <div id="ddSelected" class="row" style="margin-bottom:10px;"></div>
    <div id="ddSearchView">
      <input type="text" id="ddSearch" placeholder="${placeholder}" style="margin-bottom:12px;">
      <div id="ddOptions" class="row"></div>
    </div>
    <div id="ddStaseView" style="display:none;"></div>
  `;
  container.appendChild(wrap);

  function addSelection(m) {
    if (maxSelect && selected.size >= maxSelect) {
      if (singleSelect) selected.clear();
      else return;
    }
    selected.add(m);
    onChange([...selected]);
    renderSelected();
    renderOptions(wrap.querySelector("#ddSearch").value);
    renderStaseView();
  }

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
      renderStaseView();
    }));
  }

  function renderOptions(query) {
    const el = wrap.querySelector("#ddOptions");
    const q = (query || "").trim().toLowerCase();
    let list = master.filter((m) => !selected.has(m) && !exclude.has(m));
    if (q) list = list.filter((m) => m.toLowerCase().includes(q));
    const capped = list.slice(0, 40);
    if (capped.length === 0) {
      el.innerHTML = `<p class="muted" style="font-size:0.8rem;">Tidak ada hasil. Coba mode "Jelajahi Stase" — beberapa penyakit tercatat dalam istilah Indonesia/Inggris yang berbeda.</p>`;
      return;
    }
    el.innerHTML = capped.map((m) => `<div class="chip" data-add="${encodeURIComponent(m)}">${m}</div>`).join("")
      + (list.length > capped.length ? `<p class="muted" style="font-size:0.75rem; width:100%; margin-top:6px;">Ketik untuk mempersempit (${list.length} hasil)...</p>` : "");
    el.querySelectorAll("[data-add]").forEach((chip) => chip.addEventListener("click", () => {
      addSelection(decodeURIComponent(chip.dataset.add));
    }));
  }

  function renderStaseView() {
    const el = wrap.querySelector("#ddStaseView");
    const staseKeys = Object.keys(grouped);
    if (staseKeys.length === 0) {
      el.innerHTML = `<p class="muted" style="font-size:0.8rem;">Data kategori belum tersedia.</p>`;
      return;
    }
    el.innerHTML = staseKeys.map((k) => {
      const names = (grouped[k] || []).filter((m) => !exclude.has(m));
      if (names.length === 0) return "";
      const isOpen = openStase.has(k);
      return `
        <div class="stase-group ${isOpen ? "open" : ""}" data-stase="${k}">
          <div class="stase-header" data-toggle="${k}">
            <span>${STASE_LABELS[k] || k} <span class="stase-count">(${names.length})</span></span>
            <span class="stase-caret">▶</span>
          </div>
          <div class="stase-body">
            ${names.map((m) => `<div class="chip ${selected.has(m) ? "selected" : ""}" data-add2="${encodeURIComponent(m)}">${m}</div>`).join("")}
          </div>
        </div>`;
    }).join("");
    el.querySelectorAll("[data-toggle]").forEach((h) => h.addEventListener("click", () => {
      const k = h.dataset.toggle;
      openStase.has(k) ? openStase.delete(k) : openStase.add(k);
      renderStaseView();
    }));
    el.querySelectorAll("[data-add2]").forEach((chip) => chip.addEventListener("click", () => {
      const m = decodeURIComponent(chip.dataset.add2);
      if (selected.has(m)) return; // dedupe click handled via renderSelected removal instead
      addSelection(m);
    }));
  }

  wrap.querySelectorAll(".dd-mode-tab").forEach((tab) => tab.addEventListener("click", () => {
    mode = tab.dataset.mode;
    wrap.querySelectorAll(".dd-mode-tab").forEach((t) => t.classList.toggle("active", t === tab));
    wrap.querySelector("#ddSearchView").style.display = mode === "cari" ? "" : "none";
    wrap.querySelector("#ddStaseView").style.display = mode === "stase" ? "" : "none";
    if (mode === "stase") renderStaseView();
  }));

  wrap.querySelector("#ddSearch").addEventListener("input", (e) => renderOptions(e.target.value));
  renderSelected();
  renderOptions("");
  renderStaseView();
}

// ---------- DD STEPS (dd1 / dd2 / dd3) ----------
function renderDDStep(stateKey, title, instructions, { carryFromKey, seededFlagKey } = {}) {
  return (body) => {
    // Carry the previous DD list forward exactly once, the first time this
    // step is shown — so "DD Revisi" starts as a REVISION of the prior
    // list, not a blank slate. Guarded by a one-shot flag (not just an
    // empty-array check) so it doesn't re-seed if the student deliberately
    // clears the list later and navigates back/forward.
    if (carryFromKey && seededFlagKey && !state[seededFlagKey]) {
      state[stateKey] = [...state[carryFromKey]];
      state[seededFlagKey] = true;
    }
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
    saveSessionToStorage();
    appendLoadingBubble();
    try {
      const { reply, _provider } = await api("/chat/anamnesis", {
        method: "POST",
        body: JSON.stringify({
          kategori: state.kategori, id: state.id,
          history: state.anamnesisHistory.slice(0, -1),
          message,
          forceProvider: window.__forceProvider || undefined,
        }),
      });
      console.debug("[anamnesis] answered by provider:", _provider);
      state.anamnesisHistory.push({ role: "assistant", content: reply, _provider });
    } catch (e) {
      const shown = (window.__devModeOn && e.detail) ? `[Error: ${e.message} — ${e.detail}]` : `[Error: ${e.message}]`;
      state.anamnesisHistory.push({ role: "assistant", content: shown });
    }
    renderChatLog();
    saveSessionToStorage();
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
    `<div class="bubble ${h.role === "user" ? "user" : "patient"}">${escapeHtml(h.content)}${
      window.__devModeOn && h._provider ? `<div class="dev-tag">${h._provider}</div>` : ""
    }</div>`
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
          body: JSON.stringify({ kategori: state.kategori, id: state.id, step, query, done: doneIds, forceProvider: window.__forceProvider || undefined }),
        });
        results.forEach((r) => {
          if (r.id && doneIds.includes(r.id)) return; // already revealed
          found.push(r);
        });
      } catch (e) {
        const shown = (window.__devModeOn && e.detail) ? `[Error: ${e.message} — ${e.detail}]` : `[Error: ${e.message}]`;
        found.push({ nama: query, temuan: shown, signifikan: false });
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
  if (!state.temuanLaporan) state.temuanLaporan = {}; // guard old sessions resumed from storage
  if (found.length === 0) {
    el.innerHTML = `<p class="muted">Belum ada pemeriksaan yang dilakukan.</p>`;
    return;
  }
  el.innerHTML = found.map((f) => findingCardHtml(f, { hideTemuan: true })).join("");
  el.querySelectorAll("[data-report-key]").forEach((ta) => {
    ta.addEventListener("input", (e) => {
      state.temuanLaporan[e.target.dataset.reportKey] = e.target.value;
    });
  });
}

// Renders one PF/Penunjang finding card. Normal findings show the text
// result (+ image if any) right away, same as always.
//
// A finding with `wajibLapor` (only ever true when it also has an `image` —
// see server/routes/exam.js) is treated differently depending on `opts`:
//   - hideTemuan: true  (exam step, while the student is still working) —
//     show ONLY the image plus a free-text "Laporkan temuan Anda" essay
//     card. The real `temuan` is deliberately withheld here; it is never
//     auto-graded and only shown later at the reveal step.
//   - hideTemuan: false (reveal step) — show the image plus the student's
//     own report side-by-side with the real `temuan` ("Jawabanmu" vs "Kunci
//     Jawaban"), the same treatment Tatalaksana/Edukasi already get.
function findingCardHtml(f, opts = {}) {
  const { hideTemuan = false } = opts;
  if (f.wajibLapor) {
    if (hideTemuan) {
      const laporan = (state.temuanLaporan && state.temuanLaporan[f.id]) || "";
      return `
        <div class="finding-card ${f.signifikan ? "signifikan" : ""}">
          <div class="nama">${f.nama}</div>
          <img src="${f.image}" alt="${f.nama}">
          <p class="muted" style="margin:10px 0 6px; font-size:0.82rem;">Laporkan temuan Anda dari gambar di atas. Jawaban ini tidak dinilai langsung — akan dibandingkan dengan kunci jawaban di layar Kunci Jawaban nanti.</p>
          <textarea class="essay-input" style="min-height:100px;" data-report-key="${f.id}" placeholder="Laporkan temuan Anda...">${escapeHtml(laporan)}</textarea>
        </div>`;
    }
    const laporan = (state.temuanLaporan && state.temuanLaporan[f.id]) || "";
    return `
      <div class="finding-card ${f.signifikan ? "signifikan" : ""}">
        <div class="nama">${f.nama}</div>
        <img src="${f.image}" alt="${f.nama}">
        <div class="answer-block" style="margin-top:10px;">
          <div class="answer-label">Jawabanmu</div>
          <div class="answer-body">${laporan.trim() ? escapeHtml(laporan) : "(belum diisi)"}</div>
        </div>
        <div class="answer-block key">
          <div class="answer-label">Kunci Jawaban</div>
          <div class="answer-body">${escapeHtml(f.temuan)}</div>
        </div>
      </div>`;
  }
  return `
    <div class="finding-card ${f.signifikan ? "signifikan" : ""}">
      <div class="nama">${f.nama}</div>
      <div>${f.temuan}</div>
      ${f.image ? `<img src="${f.image}" alt="${f.nama}">` : ""}
    </div>`;
}

// ---------- STEP 8: FINAL DIAGNOSIS (1 DK + 2 DB) ----------
function renderFinal(body) {
  // Same one-shot carry-forward as the DD revision steps: seed Diagnosis
  // Banding (DD Akhir) from DD Revisi 2 the first time this step is shown.
  // This list is capped at 2 selections here (unlike the earlier DD steps),
  // so if Revisi 2 had more than 2, only the first 2 carry over — the
  // student can still adjust from there like any other revision.
  if (!state.ddFinalSeeded) {
    state.diagnosisBanding = state.ddRevisi2.slice(0, 2);
    state.ddFinalSeeded = true;
  }
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

// ---------- STEP 9: TATALAKSANA (R/ prescription builder) + EDUKASI (essay) ----------
function renderPlan(body) {
  const rxCard = document.createElement("div");
  rxCard.className = "card";
  rxCard.innerHTML = `<h2 style="font-size:1.05rem;">Tatalaksana (Medikamentosa)</h2><p class="muted" style="margin:6px 0 0;">Tuliskan resep sendiri sesuai kaidah penulisan resep. Tekan "+ Tambah R/" untuk resep baru, lalu pilih kartu untuk mengisinya.</p>`;
  body.appendChild(rxCard);
  renderRxWorkspace(rxCard);

  const eduCard = document.createElement("div");
  eduCard.className = "card";
  eduCard.innerHTML = `
    <h2 style="font-size:1.05rem;">Edukasi</h2>
    <p class="muted" style="margin:8px 0 12px;">Tuliskan edukasi yang akan kamu sampaikan ke pasien, dalam bentuk esai bebas.</p>
    <textarea class="essay-input" id="eduInput" placeholder="Tuliskan edukasi untuk pasien di sini...">${escapeHtml(state.edukasiJawaban)}</textarea>
  `;
  body.appendChild(eduCard);
  eduCard.querySelector("#eduInput").addEventListener("input", (e) => {
    state.edukasiJawaban = e.target.value;
  });

  stepNav(body, {
    back: () => { state.stepIndex--; renderSession(); },
    next: async () => {
      state.evaluation = await api(`/cases/${state.kategori}/${state.id}/evaluate`, {
        method: "POST",
        body: JSON.stringify({
          diagnosisKerja: state.diagnosisKerja,
          diagnosisBanding: state.diagnosisBanding,
        }),
      });
      state.stepIndex++;
      renderSession();
    },
  });
}

function formatRx(card) {
  const invo = (card.invocatio || "").trim();
  const sig = (card.signatura || "").trim();
  const lines = [`R/ ${invo}`];
  if (sig) lines.push(`S. ${sig}`);
  return lines.join("\n");
}

function renderRxWorkspace(container) {
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="rx-top">
      <div class="rx-cards-scroll" id="rxCardsScroll"></div>
      <button type="button" class="rx-add-btn" id="rxAddBtn">+ Tambah R/</button>
    </div>
    <div class="rx-bottom">
      <div id="rxFieldsArea"></div>
    </div>
  `;
  container.appendChild(wrap);

  function selectCard(id) {
    state.activeResepId = id;
    renderCards();
    renderFields();
  }

  function renderCards() {
    const el = wrap.querySelector("#rxCardsScroll");
    if (state.resepCards.length === 0) {
      el.innerHTML = `<p class="rx-empty-hint">Belum ada resep. Tekan "+ Tambah R/" untuk mulai menulis.</p>`;
      return;
    }
    el.innerHTML = state.resepCards.map((c) => {
      const invo = (c.invocatio || "").trim();
      const sig = (c.signatura || "").trim();
      return `
      <div class="rx-card ${c.id === state.activeResepId ? "selected" : ""}" data-card="${c.id}">
        <button type="button" class="rx-remove" data-remove="${c.id}" title="Hapus R/ ini">✕</button>
        <div class="rx-line ${invo ? "" : "empty"}">R/ ${invo ? escapeHtml(invo) : "(belum diisi)"}</div>
        ${sig ? `<div class="rx-line sig">S. ${escapeHtml(sig)}</div>` : ""}
      </div>`;
    }).join("");
    el.querySelectorAll("[data-card]").forEach((c) => c.addEventListener("click", (e) => {
      if (e.target.closest("[data-remove]")) return;
      selectCard(c.dataset.card);
    }));
    el.querySelectorAll("[data-remove]").forEach((btn) => btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.remove;
      state.resepCards = state.resepCards.filter((c) => c.id !== id);
      if (state.activeResepId === id) state.activeResepId = null;
      renderCards();
      renderFields();
    }));
  }

  function renderFields() {
    const el = wrap.querySelector("#rxFieldsArea");
    const active = state.resepCards.find((c) => c.id === state.activeResepId);
    if (!active) {
      el.innerHTML = `<div class="rx-noselect-notice">Pilih atau tambah kartu R/ di atas untuk mulai mengisi.</div>`;
      return;
    }
    el.innerHTML = `
      <div class="rx-field-label">Invocatio + Praescriptio</div>
      <textarea class="rx-input" id="rxInvocatio" rows="2" placeholder="Contoh: Parace-tampol tab 9000 mg No. XXX">${escapeHtml(active.invocatio || "")}</textarea>
      <div class="rx-field-label">Signatura</div>
      <textarea class="rx-input" id="rxSignatura" rows="2" placeholder="Contoh: S.prn 9 dd tab I demam">${escapeHtml(active.signatura || "")}</textarea>
    `;
    el.querySelector("#rxInvocatio").addEventListener("input", (e) => {
      active.invocatio = e.target.value;
      renderCards();
    });
    el.querySelector("#rxSignatura").addEventListener("input", (e) => {
      active.signatura = e.target.value;
      renderCards();
    });
  }

  wrap.querySelector("#rxAddBtn").addEventListener("click", () => {
    const id = `rx${++rxCardSeq}`;
    state.resepCards.push({ id, invocatio: "", signatura: "" });
    selectCard(id);
  });

  renderCards();
  renderFields();
}

// ---------- STEP 10: REVEAL ----------
async function renderReveal(body) {
  if (!state.temuanLaporan) state.temuanLaporan = {}; // guard old sessions resumed from storage
  body.innerHTML = `<p class="loading">Memuat kunci jawaban...</p>`;
  if (!state.revealData) {
    state.revealData = await api(`/cases/${state.kategori}/${state.id}/reveal`);
  }
  if (!state.empatiData) {
    try {
      state.empatiData = await api("/chat/empati", {
        method: "POST",
        body: JSON.stringify({ history: state.anamnesisHistory, forceProvider: window.__forceProvider || undefined }),
      });
    } catch (e) {
      state.empatiData = { nama: false, pekerjaan: false, tempatTinggal: false, pendamping: false };
    }
  }
  const truth = state.revealData;
  const ev = state.evaluation;
  const empati = state.empatiData;
  const empatiItems = [
    { key: "nama", label: "Menanyakan nama pasien" },
    { key: "pekerjaan", label: "Menanyakan pekerjaan pasien" },
    { key: "tempatTinggal", label: "Menanyakan tempat tinggal pasien" },
    { key: "pendamping", label: "Menanyakan siapa yang mengantar/menemani pasien" },
  ];
  const empatiScore = empatiItems.filter((it) => empati[it.key]).length;
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
      <h3 style="font-size:0.95rem; margin-bottom:4px;">Nilai Empati (${empatiScore}/4)</h3>
      <p class="muted" style="margin-bottom:10px; font-size:0.82rem;">Apakah kamu membangun rapport dengan menanyakan hal-hal berikut selama anamnesis?</p>
      ${empatiItems.map((it) => `
        <div class="row" style="align-items:center; gap:8px; margin-bottom:6px;">
          <span style="color:${empati[it.key] ? "var(--green)" : "var(--red)"}; font-size:1.05rem; width:1.2em; display:inline-block;">${empati[it.key] ? "✓" : "✗"}</span>
          <span>${it.label}</span>
        </div>`).join("")}
      <p class="muted" style="margin-top:10px; font-size:0.8rem;">Identitas asli pasien: <strong style="color:var(--text);">${truth.identitas}</strong></p>
    </div>
    <div class="card">
      <h3 style="font-size:0.95rem; margin-bottom:10px;">Tatalaksana</h3>
      <div class="answer-block">
        <div class="answer-label">Jawabanmu</div>
        <div class="answer-body rxmono">${state.resepCards.length ? state.resepCards.map((c) => escapeHtml(formatRx(c))).join("\n\n") : "(tidak ada resep dituliskan)"}</div>
      </div>
      <div class="answer-block key">
        <div class="answer-label">Kunci Jawaban</div>
        <div class="answer-body">${(truth.tatalaksana || []).filter((t) => t.benar).map((t) => escapeHtml(t.opsi)).join("\n\n") || "-"}</div>
      </div>
    </div>
    <div class="card">
      <h3 style="font-size:0.95rem; margin-bottom:10px;">Edukasi</h3>
      <div class="answer-block">
        <div class="answer-label">Jawabanmu</div>
        <div class="answer-body">${state.edukasiJawaban.trim() ? escapeHtml(state.edukasiJawaban) : "(belum diisi)"}</div>
      </div>
      <div class="answer-block key">
        <div class="answer-label">Kunci Jawaban</div>
        <div class="answer-body">${(truth.edukasi || []).filter((e) => e.benar).map((e) => escapeHtml(e.opsi)).join("\n\n") || "-"}</div>
      </div>
    </div>
    <div class="card">
      <h3 style="font-size:0.95rem; margin-bottom:10px;">Anamnesis Kamu</h3>
      <div class="chat-log" style="max-height:none;">
        ${state.anamnesisHistory.length
          ? state.anamnesisHistory.map((h) => `<div class="bubble ${h.role === "user" ? "user" : "patient"}">${escapeHtml(h.content)}${window.__devModeOn && h._provider ? `<div class="dev-tag">${h._provider}</div>` : ""}</div>`).join("")
          : `<p class="muted">Tidak ada percakapan anamnesis yang dilakukan.</p>`}
      </div>
    </div>
    <div class="card">
      <h3 style="font-size:0.95rem; margin-bottom:10px;">Pemeriksaan Fisik yang Kamu Lakukan</h3>
      ${state.pfFound.length
        ? state.pfFound.map((f) => findingCardHtml(f, { hideTemuan: false })).join("")
        : `<p class="muted">Tidak ada pemeriksaan fisik yang dilakukan.</p>`}
    </div>
    <div class="card">
      <h3 style="font-size:0.95rem; margin-bottom:10px;">Pemeriksaan Penunjang yang Kamu Lakukan</h3>
      ${state.penunjangFound.length
        ? state.penunjangFound.map((f) => findingCardHtml(f, { hideTemuan: false })).join("")
        : `<p class="muted">Tidak ada pemeriksaan penunjang yang dilakukan.</p>`}
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
  document.getElementById("restart").addEventListener("click", () => { clearSessionStorage(); showLanding(); });
}

// ---------- utils ----------
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
// ---------- INIT ----------
// Resume an in-progress session if the tab was refreshed/reloaded mid-way
// through — sessionStorage survives a same-tab reload by design. A fresh
// tab (or one after "Selesai sesi"/"Sesi Baru", which explicitly clear it)
// finds nothing here and just shows the landing screen as usual.
(function init() {
  const saved = loadSessionFromStorage();
  if (saved && saved.screen === "session" && saved.kasus) {
    state = saved;
    renderSession();
  } else {
    showLanding();
  }
})();


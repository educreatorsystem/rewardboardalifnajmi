const CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQV1Lfu_HLJ7_oWFYo-0L0bHlqmG0IcI_4IlqygrYVU9VIuVE4ASdHodc4L4STHclZB8b3eTjnRukNs/pub?gid=0&single=true&output=csv";
const GVIZ_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQV1Lfu_HLJ7_oWFYo-0L0bHlqmG0IcI_4IlqygrYVU9VIuVE4ASdHodc4L4STHclZB8b3eTjnRukNs/gviz/tq?gid=0&headers=1&tqx=out:json";
const APPSCRIPT_URL = "https://script.google.com/macros/s/AKfycbyXaSi7TNNYJ_TCUbM399az4banOUuCOrs7A5uk01WJrLxs2MqmT7qqbdYnLA55ex8lGQ/exec";
const STORAGE_KEY = "reward-board-state-v2";
const SYNC_INTERVAL_MS = 8000;
const BACKEND_BATCH_DELAY_MS = 180;
const LOCAL_SYNC_GUARD_MS = 3500;

const state = {
  students: [],
  scores: {},
  groups: {},
  activePickerMode: "student",
  activeLeaderMode: "student",
  pickerSelection: null,
  syncTimer: null,
  lastLocalChangeAt: 0,
  lastBackendRevision: 0,
  backendSupportsBatch: false,
  timer: {
    initial: 60,
    remaining: 60,
    running: false,
    interval: null
  }
};

const el = {};
let backendQueue = [];
let backendFlushTimer = null;
let backendInFlight = false;
let localSaveTimer = null;
let leaderboardRenderQueued = false;

document.addEventListener("DOMContentLoaded", () => {
  bindElements();
  bindEvents();
  loadLocalState();
  loadStudents();
  renderTimer();
});

function bindElements() {
  [
    "syncStatus", "refreshBtn", "resetScoresBtn", "rewardClass", "studentSearch", "studentGrid",
    "groupClass", "groupCount", "randomGroupsBtn", "manualGroupsBtn", "manualStudentList",
    "groupBoard", "pickerClass", "pickStudentMode", "pickGroupMode", "pickerDisplay",
    "pickBtn", "pickerAddStar", "pickerMinusStar", "pickerCandidates", "pickerHint",
    "timerDisplay", "customMinutes", "customSeconds", "setCustomTimer", "timerStart",
    "timerPause", "timerReset", "leaderClass", "leaderStudentMode", "leaderGroupMode",
    "leaderboardList", "starBurstLayer"
  ].forEach((id) => {
    el[id] = document.getElementById(id);
  });
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });

  el.refreshBtn.addEventListener("click", loadStudents);
  el.resetScoresBtn.addEventListener("click", resetScores);
  el.rewardClass.addEventListener("change", renderAll);
  el.studentSearch.addEventListener("input", renderStudentGrid);
  el.groupClass.addEventListener("change", renderAll);
  el.randomGroupsBtn.addEventListener("click", generateRandomGroups);
  el.manualGroupsBtn.addEventListener("click", prepareManualGroups);
  el.pickerClass.addEventListener("change", () => {
    state.pickerSelection = null;
    renderPicker();
  });
  el.pickStudentMode.addEventListener("click", () => setPickerMode("student"));
  el.pickGroupMode.addEventListener("click", () => setPickerMode("group"));
  el.pickBtn.addEventListener("click", runPicker);
  el.pickerAddStar.addEventListener("click", () => rewardPickerSelection(1));
  el.pickerMinusStar.addEventListener("click", () => rewardPickerSelection(-1));
  el.leaderClass.addEventListener("change", renderLeaderboard);
  el.leaderStudentMode.addEventListener("click", () => setLeaderMode("student"));
  el.leaderGroupMode.addEventListener("click", () => setLeaderMode("group"));

  document.querySelectorAll(".timer-presets button").forEach((button) => {
    button.addEventListener("click", () => setTimer(Number(button.dataset.seconds)));
  });
  el.setCustomTimer.addEventListener("click", () => {
    const minutes = Math.max(0, Number(el.customMinutes.value) || 0);
    const seconds = Math.max(0, Math.min(59, Number(el.customSeconds.value) || 0));
    setTimer(Math.max(1, minutes * 60 + seconds));
  });
  el.timerStart.addEventListener("click", startTimer);
  el.timerPause.addEventListener("click", pauseTimer);
  el.timerReset.addEventListener("click", resetTimer);
}

async function loadStudents() {
  setSync("Memuat data...");
  try {
    const response = await fetch(`${CSV_URL}&t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error("CSV tidak dapat dimuat");
    const text = await response.text();
    applyStudentRows(parseCsv(text));
  } catch (csvError) {
    try {
      applyStudentRows(await loadStudentsFromGviz());
    } catch (gvizError) {
      showFallbackStudents(csvError, gvizError);
    }
  }
}

function applyStudentRows(rows) {
  const parsed = rows
    .map((row) => ({
      className: cleanCell(row[0]),
      name: cleanCell(row[1])
    }))
    .filter((row) => row.className && row.name)
    .filter((row) => !/^kelas$/i.test(row.className) && !/^nama/i.test(row.name))
    .map((row, index) => ({
      id: makeStudentId(row.className, row.name, index),
      className: row.className,
      name: row.name
    }));

  if (!parsed.length) throw new Error("Google Sheet tiada data murid");
  state.students = parsed;
  ensureScoreKeys();
  ensureGroupsForClasses();
  saveLocalState();
  populateClassSelectors();
  renderAll();
  setSync(`${parsed.length} murid dimuat`);
  syncFromBackend(true);
  startSyncPolling();
}

function loadStudentsFromGviz() {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const previousGoogle = window.google;
    const previousVisualization = previousGoogle?.visualization;
    const previousQuery = previousVisualization?.Query;

    const cleanup = () => {
      script.remove();
      if (previousGoogle) {
        window.google = previousGoogle;
        if (previousVisualization) window.google.visualization = previousVisualization;
        if (previousQuery) window.google.visualization.Query = previousQuery;
      }
    };

    window.google = window.google || {};
    window.google.visualization = window.google.visualization || {};
    window.google.visualization.Query = {
      setResponse(response) {
        cleanup();
        if (!response || response.status === "error") {
          reject(new Error(response?.errors?.[0]?.detailed_message || "Data Google Sheet tidak dapat dibaca"));
          return;
        }
        const rows = (response.table?.rows || []).map((row) =>
          (row.c || []).map((cell) => cleanCell(cell?.f ?? cell?.v ?? ""))
        );
        resolve(rows);
      }
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("Google Sheet JSONP gagal dimuat"));
    };
    script.src = `${GVIZ_URL}&cache=${Date.now()}`;
    document.head.appendChild(script);
  });
}

function showFallbackStudents(...errors) {
    if (!state.students.length) {
      state.students = sampleStudents();
      ensureScoreKeys();
      ensureGroupsForClasses();
      populateClassSelectors();
      renderAll();
    }
    setSync("Guna data sementara");
    console.warn(...errors);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function cleanCell(value) {
  return String(value || "").trim();
}

function makeStudentId(className, name, index) {
  return `${slug(className)}__${slug(name)}__${index}`;
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function loadLocalState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.scores = saved.scores || {};
    state.groups = saved.groups || {};
  } catch {
    state.scores = {};
    state.groups = {};
  }
}

function saveLocalState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    scores: state.scores,
    groups: state.groups
  }));
}

function startSyncPolling() {
  if (state.syncTimer) return;
  state.syncTimer = setInterval(() => syncFromBackend(false), SYNC_INTERVAL_MS);
}

async function syncFromBackend(force) {
  const hasPendingWrites = backendQueue.length > 0 || backendInFlight;
  if (!force && (Date.now() - state.lastLocalChangeAt < LOCAL_SYNC_GUARD_MS || hasPendingWrites)) return;
  try {
    const backendState = await loadBackendState();
    if (!backendState || !backendState.ok) throw new Error("State backend tidak sah");

    // Backend lama hanya memulangkan {ok:true,message:...}. Jangan sesekali
    // kosongkan skor tempatan jika endpoint getState belum disokong.
    const supportsSharedState = Object.prototype.hasOwnProperty.call(backendState, "initialized")
      || Object.prototype.hasOwnProperty.call(backendState, "scores")
      || Object.prototype.hasOwnProperty.call(backendState, "groups");
    if (!supportsSharedState) {
      state.backendSupportsBatch = false;
      setSync("Sync tempatan");
      return;
    }
    state.backendSupportsBatch = true;

    // Deploy baharu: jadikan data browser semasa sebagai state permulaan supaya
    // rekod sedia ada tidak hilang pada sync pertama.
    if (backendState.initialized === false) {
      postBackendAction({
        action: "replaceState",
        scores: state.scores,
        groups: state.groups
      }, true);
      setSync("Menyediakan sync...");
      return;
    }

    const revision = Number(backendState.revision || 0);
    if (!force && revision && revision < state.lastBackendRevision) return;

    state.scores = backendState.scores || {};
    state.groups = backendState.groups || {};
    state.lastBackendRevision = revision;
    ensureScoreKeys();
    ensureGroupsForClasses();
    saveLocalState();
    renderAll();
    setSync(`Sync ${new Date().toLocaleTimeString("ms-MY", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`);
  } catch (error) {
    setSync("Sync tempatan");
    console.warn(error);
  }
}

function loadBackendState() {
  return new Promise((resolve, reject) => {
    const callbackName = `__rewardBoardSync_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const script = document.createElement("script");
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Sync Google Sheet tamat masa"));
    }, 7000);
    const cleanup = () => {
      clearTimeout(timeout);
      delete window[callbackName];
      script.remove();
    };

    window[callbackName] = (payload) => {
      cleanup();
      resolve(payload);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("Tidak dapat membaca sync Google Sheet"));
    };
    script.src = `${APPSCRIPT_URL}?action=getState&callback=${callbackName}&cache=${Date.now()}`;
    document.head.appendChild(script);
  });
}

function markLocalChange() {
  state.lastLocalChangeAt = Date.now();
}

function scheduleLocalStateSave() {
  clearTimeout(localSaveTimer);
  localSaveTimer = setTimeout(() => {
    saveLocalState();
    localSaveTimer = null;
  }, 40);
}

function postBackendAction(payload, flushNow = false) {
  const actionPayload = {
    timestamp: new Date().toISOString(),
    ...payload
  };

  backendQueue.push(actionPayload);
  setSync("Menyimpan...");
  clearTimeout(backendFlushTimer);
  if (flushNow) {
    backendFlushTimer = null;
    flushBackendQueue();
  } else {
    backendFlushTimer = setTimeout(flushBackendQueue, BACKEND_BATCH_DELAY_MS);
  }
}

function submitBackendPayload(payload) {
  // Hidden-form POST avoids CORS/preflight issues between GitHub Pages and Apps Script.
  // Apps Script reads the JSON from e.parameter.payload.
  const frameName = `rewardSink_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const iframe = document.createElement("iframe");
  iframe.name = frameName;
  iframe.style.display = "none";
  iframe.setAttribute("aria-hidden", "true");

  const form = document.createElement("form");
  form.method = "POST";
  form.action = APPSCRIPT_URL;
  form.target = frameName;
  form.style.display = "none";

  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "payload";
  input.value = JSON.stringify(payload);
  form.appendChild(input);

  document.body.appendChild(iframe);
  document.body.appendChild(form);
  form.submit();

  setTimeout(() => {
    form.remove();
    iframe.remove();
  }, 12000);
}

async function flushBackendQueue() {
  if (backendInFlight || !backendQueue.length) return;
  clearTimeout(backendFlushTimer);
  backendFlushTimer = null;

  const actions = backendQueue.splice(0, backendQueue.length);
  backendInFlight = true;
  try {
    submitBackendPayload({
      action: "batch",
      timestamp: new Date().toISOString(),
      actions
    });
    setSync("Dihantar ke Google Sheet");
  } catch (error) {
    backendQueue = actions.concat(backendQueue);
    setSync("Simpan tempatan");
    console.warn(error);
  } finally {
    backendInFlight = false;
    if (backendQueue.length) {
      backendFlushTimer = setTimeout(flushBackendQueue, BACKEND_BATCH_DELAY_MS);
    }
  }
}

function ensureScoreKeys() {
  state.students.forEach((student) => {
    if (!Number.isFinite(state.scores[student.id])) state.scores[student.id] = 0;
  });
}

function ensureGroupsForClasses() {
  getClasses().forEach((className) => {
    if (!state.groups[className]) state.groups[className] = [];
  });
}

function populateClassSelectors() {
  const classes = getClasses();
  [el.rewardClass, el.groupClass, el.pickerClass, el.leaderClass].forEach((select) => {
    const current = select.value;
    select.innerHTML = classes.map((className) => `<option value="${escapeHtml(className)}">${escapeHtml(className)}</option>`).join("");
    select.value = classes.includes(current) ? current : classes[0] || "";
  });
}

function getClasses() {
  return [...new Set(state.students.map((student) => student.className))].sort((a, b) => a.localeCompare(b));
}

function getStudentsByClass(className) {
  return state.students.filter((student) => student.className === className);
}

function switchTab(tabId) {
  document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tabId));
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === tabId));
  renderAll();
}

function renderAll() {
  renderStudentGrid();
  renderGroups();
  renderPicker();
  renderLeaderboard();
}

function renderStudentGrid() {
  const className = el.rewardClass.value;
  const query = el.studentSearch.value.trim().toLowerCase();
  const students = getStudentsByClass(className).filter((student) => student.name.toLowerCase().includes(query));
  el.studentGrid.innerHTML = students.map((student) => studentCard(student)).join("") || emptyState("Tiada murid ditemui.");
  el.studentGrid.querySelectorAll("[data-reward-student]").forEach((button) => {
    button.addEventListener("click", () => updateStudentScore(button.dataset.rewardStudent, Number(button.dataset.delta), button));
  });
}

function studentCard(student) {
  const score = state.scores[student.id] || 0;
  return `
    <article class="student-card" data-student-card="${escapeHtml(student.id)}">
      <div>
        <div class="student-name">${escapeHtml(student.name)}</div>
        <div class="meta">${escapeHtml(student.className)}</div>
      </div>
      <div class="score-line">
        <span class="stars">⭐ ${score}</span>
        <span class="meta">Individu</span>
      </div>
      <div class="card-actions">
        <button class="star-btn" data-reward-student="${escapeHtml(student.id)}" data-delta="1" type="button">+ ⭐</button>
        <button class="minus-btn" data-reward-student="${escapeHtml(student.id)}" data-delta="-1" type="button">- ⭐</button>
      </div>
    </article>
  `;
}

function updateStudentScoreDisplay(studentId) {
  const card = el.studentGrid.querySelector(`[data-student-card="${studentId}"]`);
  if (!card) return;
  const stars = card.querySelector(".stars");
  if (stars) stars.textContent = `⭐ ${state.scores[studentId] || 0}`;
  card.classList.remove("pop");
  void card.offsetWidth;
  card.classList.add("pop");
  setTimeout(() => card.classList.remove("pop"), 430);
}

function updateGroupScoreDisplay(groupId) {
  const card = el.groupBoard.querySelector(`[data-group-card="${groupId}"]`);
  if (!card) return;
  const stars = card.querySelector(".group-head .stars");
  const group = Object.values(state.groups).flat().find((item) => item.id === groupId);
  if (stars && group) stars.textContent = `⭐ ${group.stars || 0}`;
  card.classList.remove("pop");
  void card.offsetWidth;
  card.classList.add("pop");
  setTimeout(() => card.classList.remove("pop"), 430);
}

function scheduleLeaderboardRender() {
  const panel = document.getElementById("leaderboard");
  if (!panel?.classList.contains("active") || leaderboardRenderQueued) return;
  leaderboardRenderQueued = true;
  requestAnimationFrame(() => {
    leaderboardRenderQueued = false;
    renderLeaderboard();
  });
}

function generateRandomGroups() {
  const className = el.groupClass.value;
  const students = shuffle(getStudentsByClass(className));
  const groupCount = Math.max(1, Math.min(Number(el.groupCount.value) || 1, students.length || 1));
  const groups = Array.from({ length: groupCount }, (_, index) => ({
    id: `${slug(className)}-group-${index + 1}`,
    name: `Kumpulan ${String.fromCharCode(65 + index)}`,
    stars: 0,
    members: []
  }));
  students.forEach((student, index) => {
    groups[index % groupCount].members.push(student.id);
  });
  state.groups[className] = groups;
  markLocalChange();
  saveLocalState();
  postBackendAction({
    action: "saveGroups",
    className,
    groups
  });
  renderAll();
}

function prepareManualGroups() {
  const className = el.groupClass.value;
  const groupCount = Math.max(1, Number(el.groupCount.value) || 1);
  state.groups[className] = Array.from({ length: groupCount }, (_, index) => ({
    id: `${slug(className)}-manual-${index + 1}`,
    name: `Kumpulan ${String.fromCharCode(65 + index)}`,
    stars: 0,
    members: []
  }));
  markLocalChange();
  saveLocalState();
  postBackendAction({
    action: "saveGroups",
    className,
    groups: state.groups[className]
  });
  renderAll();
}

function renderGroups() {
  const className = el.groupClass.value;
  const groups = state.groups[className] || [];
  renderManualPool(className, groups);
  el.groupBoard.innerHTML = groups.map((group, index) => groupCard(className, group, index)).join("") || emptyState("Jana kumpulan rawak atau sediakan kumpulan manual.");
  el.groupBoard.querySelectorAll("[data-reward-group]").forEach((button) => {
    button.addEventListener("click", () => updateGroupScore(className, button.dataset.rewardGroup, Number(button.dataset.delta), button));
  });
  el.groupBoard.querySelectorAll("[data-group-drop]").forEach((dropZone) => {
    dropZone.addEventListener("dragover", allowGroupDrop);
    dropZone.addEventListener("dragleave", clearGroupDrop);
    dropZone.addEventListener("drop", (event) => dropStudentToGroup(event, className, dropZone.dataset.groupDrop));
  });
}

function renderManualPool(className, groups) {
  const assigned = new Set(groups.flatMap((group) => group.members));
  const groupOptions = groups.map((group) => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join("");
  el.manualStudentList.innerHTML = getStudentsByClass(className).map((student) => {
    const isAssigned = assigned.has(student.id);
    return `
      <div class="name-chip ${isAssigned ? "assigned" : ""}" draggable="${!isAssigned && groups.length ? "true" : "false"}" data-drag-student="${escapeHtml(student.id)}">
        <span>${escapeHtml(student.name)}</span>
        <select data-assign-student="${escapeHtml(student.id)}" ${isAssigned || !groups.length ? "disabled" : ""}>
          <option value="">Pilih</option>
          ${groupOptions}
        </select>
      </div>
    `;
  }).join("") || emptyState("Tiada murid.");

  el.manualStudentList.querySelectorAll("[data-assign-student]").forEach((select) => {
    select.addEventListener("change", () => assignStudentToGroup(className, select.dataset.assignStudent, select.value));
  });
  el.manualStudentList.querySelectorAll("[data-drag-student]").forEach((chip) => {
    chip.addEventListener("dragstart", (event) => {
      if (chip.classList.contains("assigned")) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.setData("text/plain", chip.dataset.dragStudent);
      event.dataTransfer.effectAllowed = "move";
      chip.classList.add("dragging");
    });
    chip.addEventListener("dragend", () => chip.classList.remove("dragging"));
  });
}

function groupCard(className, group, groupIndex) {
  const members = group.members
    .map((id) => state.students.find((student) => student.id === id))
    .filter(Boolean);
  return `
    <article class="group-card group-theme-${groupIndex % 6}" data-group-card="${escapeHtml(group.id)}">
      <div class="group-head">
        <div>
          <div class="group-title">${escapeHtml(group.name)}</div>
          <div class="meta">${members.length} ahli</div>
        </div>
        <div class="stars">⭐ ${group.stars || 0}</div>
      </div>
      <div class="member-list" data-group-drop="${escapeHtml(group.id)}">
        ${members.map((student, index) => `<span class="member-pill"><b>${index + 1}</b>${escapeHtml(student.name)}</span>`).join("") || `<span class="drop-hint">Lepaskan nama murid di sini</span>`}
      </div>
      <div class="card-actions">
        <button class="star-btn" data-reward-group="${escapeHtml(group.id)}" data-delta="1" type="button">+ ⭐</button>
        <button class="minus-btn" data-reward-group="${escapeHtml(group.id)}" data-delta="-1" type="button">- ⭐</button>
      </div>
    </article>
  `;
}

function assignStudentToGroup(className, studentId, groupId) {
  const groups = state.groups[className] || [];
  if (groups.some((group) => group.members.includes(studentId))) return;
  const group = groups.find((item) => item.id === groupId);
  if (!group) return;
  group.members.push(studentId);
  markLocalChange();
  saveLocalState();
  postBackendAction({
    action: "saveGroups",
    className,
    groups
  });
  renderAll();
}

function allowGroupDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.add("drag-over");
  event.dataTransfer.dropEffect = "move";
}

function clearGroupDrop(event) {
  event.currentTarget.classList.remove("drag-over");
}

function dropStudentToGroup(event, className, groupId) {
  event.preventDefault();
  event.currentTarget.classList.remove("drag-over");
  const studentId = event.dataTransfer.getData("text/plain");
  assignStudentToGroup(className, studentId, groupId);
}

function updateStudentScore(studentId, delta, sourceButton) {
  const student = state.students.find((item) => item.id === studentId);
  if (!student) return;
  const rewardOrigin = getRewardOrigin(sourceButton);

  // Optimistic UI: nombor berubah dahulu, sebelum localStorage/network dibuat.
  state.scores[studentId] = Math.max(0, (state.scores[studentId] || 0) + delta);
  updateStudentScoreDisplay(studentId);
  animateReward(rewardOrigin, delta);
  scheduleLeaderboardRender();

  markLocalChange();
  scheduleLocalStateSave();
  postBackendAction({
    action: "studentReward",
    studentId,
    studentName: student.name,
    className: student.className,
    type: "student",
    targetName: student.name,
    delta,
    score: state.scores[studentId],
    affectedStudents: [student.name]
  });
}

function updateGroupScore(className, groupId, delta, sourceButton) {
  const group = (state.groups[className] || []).find((item) => item.id === groupId);
  if (!group) return;
  const rewardOrigin = getRewardOrigin(sourceButton);
  group.stars = Math.max(0, (group.stars || 0) + delta);
  const affectedStudents = [];
  const affectedStudentRecords = [];
  group.members.forEach((studentId) => {
    state.scores[studentId] = Math.max(0, (state.scores[studentId] || 0) + delta);
    const student = state.students.find((item) => item.id === studentId);
    if (student) {
      affectedStudents.push(student.name);
      affectedStudentRecords.push({
        id: student.id,
        name: student.name,
        className: student.className,
        score: state.scores[studentId]
      });
      updateStudentScoreDisplay(studentId);
    }
  });

  // Kemas kini hanya kad yang terlibat; elakkan renderAll() yang berat.
  updateGroupScoreDisplay(groupId);
  animateReward(rewardOrigin, delta);
  scheduleLeaderboardRender();

  markLocalChange();
  scheduleLocalStateSave();
  postBackendAction({
    action: "groupReward",
    type: "group",
    groupId,
    groupName: group.name,
    groups: state.groups[className],
    className,
    targetName: group.name,
    delta,
    score: group.stars,
    affectedStudents,
    affectedStudentRecords
  });
}

function setPickerMode(mode) {
  state.activePickerMode = mode;
  state.pickerSelection = null;
  el.pickStudentMode.classList.toggle("active", mode === "student");
  el.pickGroupMode.classList.toggle("active", mode === "group");
  renderPicker();
}

function renderPicker() {
  const className = el.pickerClass.value;
  const candidates = getPickerCandidates(className);
  el.pickerCandidates.innerHTML = candidates.map((candidate) => `
    <div class="candidate ${state.pickerSelection?.id === candidate.id ? "hot" : ""}">${escapeHtml(candidate.name)}</div>
  `).join("") || emptyState(state.activePickerMode === "student" ? "Tiada murid." : "Tiada kumpulan untuk kelas ini.");
  if (!state.pickerSelection) {
    el.pickerDisplay.textContent = "Tekan pilih untuk mula";
    el.pickerAddStar.disabled = true;
    el.pickerMinusStar.disabled = true;
  }
}

function getPickerCandidates(className) {
  if (state.activePickerMode === "student") {
    return getStudentsByClass(className).map((student) => ({ id: student.id, name: student.name, kind: "student" }));
  }
  return (state.groups[className] || []).map((group) => ({ id: group.id, name: group.name, kind: "group" }));
}

function runPicker() {
  const className = el.pickerClass.value;
  const candidates = getPickerCandidates(className);
  if (!candidates.length) return;
  el.pickBtn.disabled = true;
  el.pickerDisplay.classList.add("spinning");
  let ticks = 0;
  const spin = setInterval(() => {
    const candidate = candidates[Math.floor(Math.random() * candidates.length)];
    el.pickerDisplay.textContent = candidate.name;
    document.querySelectorAll(".candidate").forEach((item) => item.classList.remove("hot"));
    const candidateEls = [...document.querySelectorAll(".candidate")];
    const index = candidates.findIndex((item) => item.id === candidate.id);
    if (candidateEls[index]) candidateEls[index].classList.add("hot");
    ticks += 1;
    if (ticks >= 20) {
      clearInterval(spin);
      const selected = candidates[Math.floor(Math.random() * candidates.length)];
      state.pickerSelection = selected;
      el.pickerDisplay.textContent = selected.name;
      el.pickerDisplay.classList.remove("spinning");
      el.pickBtn.disabled = false;
      el.pickerAddStar.disabled = false;
      el.pickerMinusStar.disabled = false;
      renderPickerCandidatesOnly();
    }
  }, 70);
}

function renderPickerCandidatesOnly() {
  const className = el.pickerClass.value;
  const candidates = getPickerCandidates(className);
  el.pickerCandidates.innerHTML = candidates.map((candidate) => `
    <div class="candidate ${state.pickerSelection?.id === candidate.id ? "hot" : ""}">${escapeHtml(candidate.name)}</div>
  `).join("");
}

function rewardPickerSelection(delta) {
  if (!state.pickerSelection) return;
  if (state.pickerSelection.kind === "student") {
    updateStudentScore(state.pickerSelection.id, delta, delta > 0 ? el.pickerAddStar : el.pickerMinusStar);
  } else {
    updateGroupScore(el.pickerClass.value, state.pickerSelection.id, delta, delta > 0 ? el.pickerAddStar : el.pickerMinusStar);
  }
  el.pickerAddStar.disabled = false;
  el.pickerMinusStar.disabled = false;
}

function setLeaderMode(mode) {
  state.activeLeaderMode = mode;
  el.leaderStudentMode.classList.toggle("active", mode === "student");
  el.leaderGroupMode.classList.toggle("active", mode === "group");
  renderLeaderboard();
}

function renderLeaderboard() {
  const className = el.leaderClass.value;
  const entries = state.activeLeaderMode === "student"
    ? getStudentsByClass(className).map((student) => ({ name: student.name, score: state.scores[student.id] || 0, detail: student.className }))
    : (state.groups[className] || []).map((group) => ({ name: group.name, score: group.stars || 0, detail: `${group.members.length} ahli` }));
  entries.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const max = Math.max(1, ...entries.map((entry) => entry.score));
  el.leaderboardList.innerHTML = entries.length ? `
    <table class="leader-table">
      <thead>
        <tr>
          <th>Kedudukan</th>
          <th>${state.activeLeaderMode === "student" ? "Nama Murid" : "Nama Kumpulan"}</th>
          <th>Maklumat</th>
          <th>Bintang</th>
        </tr>
      </thead>
      <tbody>
        ${entries.map((entry, index) => `
          <tr class="${index < 3 ? "top-rank" : ""}">
            <td><span class="rank">${index + 1}</span></td>
            <td>
              <strong>${escapeHtml(entry.name)}</strong>
              <div class="bar"><span style="width:${Math.max(4, (entry.score / max) * 100)}%"></span></div>
            </td>
            <td>${escapeHtml(entry.detail)}</td>
            <td><span class="leader-stars">⭐ ${entry.score}</span></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  ` : emptyState("Tiada data leaderboard.");
}

function setTimer(seconds) {
  pauseTimer();
  state.timer.initial = seconds;
  state.timer.remaining = seconds;
  renderTimer();
}

function startTimer() {
  if (state.timer.running) return;
  state.timer.running = true;
  state.timer.interval = setInterval(() => {
    state.timer.remaining = Math.max(0, state.timer.remaining - 1);
    renderTimer();
    if (state.timer.remaining <= 0) {
      pauseTimer();
      el.timerDisplay.classList.add("pop");
      setTimeout(() => el.timerDisplay.classList.remove("pop"), 450);
    }
  }, 1000);
}

function pauseTimer() {
  state.timer.running = false;
  if (state.timer.interval) clearInterval(state.timer.interval);
  state.timer.interval = null;
}

function resetTimer() {
  pauseTimer();
  state.timer.remaining = state.timer.initial;
  renderTimer();
}

function renderTimer() {
  const seconds = state.timer.remaining;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  el.timerDisplay.textContent = [hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":");
}

function resetScores() {
  if (!confirm("Reset semua markah individu dan kumpulan untuk sesi baharu?")) return;
  Object.keys(state.scores).forEach((studentId) => {
    state.scores[studentId] = 0;
  });
  Object.values(state.groups).flat().forEach((group) => {
    group.stars = 0;
  });
  markLocalChange();
  saveLocalState();
  postBackendAction({ action: "resetScores", type: "reset", className: "Semua", targetName: "Reset Markah", delta: 0, score: 0, affectedStudents: [] });
  renderAll();
}

function getRewardOrigin(sourceButton) {
  if (!sourceButton) return null;
  const rect = sourceButton.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height
  };
}

function animateReward(origin, delta) {
  const rect = origin || {
    left: window.innerWidth / 2,
    top: window.innerHeight / 2,
    width: 1,
    height: 1
  };
  for (let i = 0; i < 10; i += 1) {
    const star = document.createElement("span");
    star.className = "flying-star";
    star.textContent = delta >= 0 ? "⭐" : "☆";
    star.style.left = `${rect.left + rect.width / 2}px`;
    star.style.top = `${rect.top + rect.height / 2}px`;
    star.style.setProperty("--dx", `${Math.random() * 220 - 110}px`);
    star.style.setProperty("--dy", `${-60 - Math.random() * 170}px`);
    star.style.animationDelay = `${i * 22}ms`;
    el.starBurstLayer.appendChild(star);
    setTimeout(() => star.remove(), 1100);
  }
}

function setSync(message) {
  el.syncStatus.textContent = message;
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function emptyState(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sampleStudents() {
  return [
    { id: "sample-1", className: "Contoh 1", name: "Aina" },
    { id: "sample-2", className: "Contoh 1", name: "Danish" },
    { id: "sample-3", className: "Contoh 1", name: "Mei Ling" },
    { id: "sample-4", className: "Contoh 1", name: "Ravi" }
  ];
}

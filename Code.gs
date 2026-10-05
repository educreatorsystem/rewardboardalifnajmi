const SHEET_ID = '1kHrKIZtlU3_9okWfl1iZ6zTagMdiKRvG6HAlFeiIzrM';
const STATE_KEY = 'reward-board-state-v4';
const LOG_SHEET_NAME = 'REKOD BINTANG';
const CURRENT_SHEET_NAME = 'SKOR SEMASA';

function doGet(e) {
  try {
    const action = String((e && e.parameter && e.parameter.action) || '');
    const callback = String((e && e.parameter && e.parameter.callback) || '');

    if (action === 'getState') {
      const savedState = readState_();
      const payload = savedState
        ? {
            ok: true,
            initialized: true,
            scores: savedState.scores || {},
            groups: savedState.groups || {},
            revision: Number(savedState.revision || 0),
            updatedAt: savedState.updatedAt || ''
          }
        : {
            ok: true,
            initialized: false,
            scores: {},
            groups: {},
            revision: 0,
            updatedAt: ''
          };
      return callback ? jsonpOutput_(callback, payload) : jsonOutput_(payload);
    }

    if (action === 'health') {
      const ss = SpreadsheetApp.openById(SHEET_ID);
      return jsonOutput_({
        ok: true,
        spreadsheetId: SHEET_ID,
        spreadsheetName: ss.getName(),
        sheets: ss.getSheets().map(function(s) { return s.getName(); })
      });
    }

    return jsonOutput_({ ok: true, message: 'Reward Board Apps Script aktif.', spreadsheetId: SHEET_ID });
  } catch (error) {
    return jsonOutput_({ ok: false, error: error.message });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    const payload = parsePayload_(e);
    const actions = payload.action === 'batch' && Array.isArray(payload.actions)
      ? payload.actions
      : [payload];

    let state = readState_() || defaultState_();
    const logRows = [];

    actions.forEach(function(actionPayload) {
      if (!actionPayload || typeof actionPayload !== 'object') return;
      applyAction_(state, actionPayload);
      const row = makeLogRow_(actionPayload);
      if (row) logRows.push(row);
    });

    state.revision = Number(state.revision || 0) + 1;
    state.updatedAt = new Date().toISOString();
    saveState_(state);

    appendLogRows_(logRows);
    writeCurrentScores_(state, actions);

    return jsonOutput_({ ok: true, revision: state.revision, updatedAt: state.updatedAt, rowsWritten: logRows.length });
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    return jsonOutput_({ ok: false, error: error.message });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

function applyAction_(state, payload) {
  const action = String(payload.action || '');

  if (action === 'replaceState') {
    state.scores = isPlainObject_(payload.scores) ? payload.scores : {};
    state.groups = isPlainObject_(payload.groups) ? payload.groups : {};
    return;
  }

  if (action === 'studentReward') {
    const studentId = String(payload.studentId || '');
    if (!studentId) return;
    state.scores[studentId] = Math.max(0, Number(payload.score || 0));
    return;
  }

  if (action === 'groupReward') {
    const className = String(payload.className || '');
    if (className && Array.isArray(payload.groups)) state.groups[className] = payload.groups;
    if (Array.isArray(payload.affectedStudentRecords)) {
      payload.affectedStudentRecords.forEach(function(student) {
        const id = String((student && student.id) || '');
        if (!id) return;
        state.scores[id] = Math.max(0, Number(student.score || 0));
      });
    }
    return;
  }

  if (action === 'saveGroups') {
    const className = String(payload.className || '');
    if (className && Array.isArray(payload.groups)) state.groups[className] = payload.groups;
    return;
  }

  if (action === 'resetScores') {
    Object.keys(state.scores || {}).forEach(function(studentId) { state.scores[studentId] = 0; });
    Object.keys(state.groups || {}).forEach(function(className) {
      (state.groups[className] || []).forEach(function(group) { group.stars = 0; });
    });
  }
}

function makeLogRow_(payload) {
  if (payload.action === 'replaceState' || payload.action === 'saveGroups') return null;
  return [
    payload.timestamp || new Date().toISOString(),
    payload.action || '',
    payload.type || '',
    payload.className || '',
    payload.targetName || payload.studentName || payload.groupName || '',
    Number(payload.delta || 0),
    Number(payload.score || 0),
    Array.isArray(payload.affectedStudents) ? payload.affectedStudents.join(', ') : String(payload.affectedStudents || '')
  ];
}

function appendLogRows_(rows) {
  if (!rows.length) return;
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = getOrCreateSheet_(ss, LOG_SHEET_NAME);
  ensureLogHeader_(sheet);
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 8).setValues(rows);
  SpreadsheetApp.flush();
}

function writeCurrentScores_(state, actions) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = getOrCreateSheet_(ss, CURRENT_SHEET_NAME);
  ensureCurrentHeader_(sheet);

  const metadata = {};
  actions.forEach(function(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.action === 'studentReward' && payload.studentId) {
      metadata[String(payload.studentId)] = {
        className: String(payload.className || ''),
        name: String(payload.studentName || payload.targetName || ''),
        source: 'Individu'
      };
    }
    if (payload.action === 'groupReward' && Array.isArray(payload.affectedStudentRecords)) {
      payload.affectedStudentRecords.forEach(function(student) {
        if (!student || !student.id) return;
        metadata[String(student.id)] = {
          className: String(student.className || payload.className || ''),
          name: String(student.name || ''),
          source: String(payload.groupName || payload.targetName || 'Kumpulan')
        };
      });
    }
  });

  const lastRow = sheet.getLastRow();
  const existing = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 6).getValues() : [];
  const rowById = {};
  existing.forEach(function(row, i) {
    const id = String(row[0] || '');
    if (id) rowById[id] = i + 2;
  });

  const now = new Date();
  Object.keys(metadata).forEach(function(studentId) {
    const info = metadata[studentId];
    const score = Math.max(0, Number((state.scores || {})[studentId] || 0));
    const values = [[studentId, info.className, info.name, score, now, info.source]];
    if (rowById[studentId]) {
      sheet.getRange(rowById[studentId], 1, 1, 6).setValues(values);
    } else {
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, 6).setValues(values);
    }
  });

  if (actions.some(function(a) { return a && a.action === 'resetScores'; })) {
    const rows = sheet.getLastRow() - 1;
    if (rows > 0) {
      const values = sheet.getRange(2, 1, rows, 6).getValues();
      values.forEach(function(row) {
        row[3] = 0;
        row[4] = now;
        row[5] = 'Reset';
      });
      sheet.getRange(2, 1, rows, 6).setValues(values);
    }
  }
  SpreadsheetApp.flush();
}

function ensureLogHeader_(sheet) {
  if (sheet.getLastRow() > 0 && sheet.getRange(1, 1).getValue()) return;
  sheet.getRange(1, 1, 1, 8).setValues([[
    'Timestamp','Action','Jenis','Kelas','Sasaran','Perubahan Bintang','Jumlah Terkini','Murid Terlibat'
  ]]);
}

function ensureCurrentHeader_(sheet) {
  if (sheet.getLastRow() > 0 && sheet.getRange(1, 1).getValue()) return;
  sheet.getRange(1, 1, 1, 6).setValues([[
    'Student ID','Kelas','Nama Murid','Jumlah Bintang','Kemaskini Terakhir','Sumber'
  ]]);
}

function readState_() {
  const raw = PropertiesService.getScriptProperties().getProperty(STATE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return {
      scores: isPlainObject_(parsed.scores) ? parsed.scores : {},
      groups: isPlainObject_(parsed.groups) ? parsed.groups : {},
      revision: Number(parsed.revision || 0),
      updatedAt: String(parsed.updatedAt || '')
    };
  } catch (error) { return null; }
}

function saveState_(state) {
  PropertiesService.getScriptProperties().setProperty(STATE_KEY, JSON.stringify(state));
}

function defaultState_() {
  return { scores: {}, groups: {}, revision: 0, updatedAt: '' };
}

function parsePayload_(e) {
  if (e && e.parameter && e.parameter.payload) {
    return JSON.parse(String(e.parameter.payload));
  }
  if (e && e.postData && e.postData.contents) {
    const raw = String(e.postData.contents || '').trim();
    if (!raw) return {};
    try { return JSON.parse(raw); } catch (ignore) {}
  }
  return {};
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function isPlainObject_(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function jsonOutput_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function jsonpOutput_(callback, data) {
  if (!/^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callback)) return jsonOutput_(data);
  return ContentService.createTextOutput(callback + '(' + JSON.stringify(data) + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
}

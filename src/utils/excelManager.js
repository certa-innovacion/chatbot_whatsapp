// src/utils/excelManager.js
// Gestión del Excel como fuente de datos del expediente, negocio y estado técnico.
const XLSX = require('xlsx');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const EXCEL_PATH           = process.env.EXCEL_PATH || path.join(__dirname, '..', '..', 'data', 'allianz_latest.xlsx');
const STATE_FILE_PATH      = process.env.CONV_STATE_FILE  || path.join(path.dirname(EXCEL_PATH), 'bot_state.xlsx');
const BUSINESS_HOURS_START = Number(process.env.BUSINESS_HOURS_START  || 9);
const BUSINESS_HOURS_END   = Number(process.env.BUSINESS_HOURS_END    || 20);
const CLEANUP_DAYS         = Number(process.env.SINIESTRO_CLEANUP_DAYS || 7);
const STATE_SHEET_NAME     = process.env.CONV_STATE_SHEET || '__bot_state';

// ── Lock de escritura cross-proceso ──────────────────────────────────────────
const LOCK_PATH     = `${EXCEL_PATH}.lock`;
const LOCK_STALE_MS = 15_000; // si el lock tiene más de 15s, se considera muerto

function acquireLock() {
  const deadline = Date.now() + 5000; // máximo 5s esperando
  while (Date.now() < deadline) {
    try {
      fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' }); // creación exclusiva atómica
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // ¿Lock obsoleto?
      try {
        const stat = fs.statSync(LOCK_PATH);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(LOCK_PATH);
          continue;
        }
      } catch { /* ya lo eliminó otro proceso */ }
      // Pausa corta antes de reintentar
      const wait = Date.now() + 20;
      while (Date.now() < wait) {}
    }
  }
  console.warn('⚠️  Excel lock timeout, liberando forzosamente');
  releaseLock();
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch {}
}

// Mapeo campo lógico → nombre columna Excel (solo negocio visible)
const FIELD_TO_COL = {
  contacto:           'Contacto',
  relacion:           'Relación',
  attPerito:          'AT. Perito',
  danos:              'Daños',
  digital:            'Digital',
  horario:            'Horario',
  coordenadas:        'Coordenadas',
};

const TECHNICAL_COL_PREFIX = '_';
const STATE_FIELDS = {
  waId:               'waId',
  status:             'status',
  stage:              'stage',
  attempts:           'attempts',
  inactivityAttempts: 'inactivityAttempts',
  nextReminderAt:     'nextReminderAt',
  lastUserMessageAt:  'lastUserMessageAt',
  lastReminderAt:     'lastReminderAt',
  lastMessageAt:      'lastMessageAt',
  mensajes:           'mensajes',
};

// ── Horario de envío ──────────────────────────────────────────────────────────

function isBusinessHours() {
  const now  = new Date();
  const day  = now.getDay();    // 0=Dom, 6=Sáb
  const hour = now.getHours();
  return day >= 1 && day <= 5 && hour >= BUSINESS_HOURS_START && hour < BUSINESS_HOURS_END;
}

// ── Normalización de teléfono ─────────────────────────────────────────────────

function normalizePhone(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/[^\d+]/g, '');
  if (s.startsWith('+'))  s = s.slice(1);
  if (s.startsWith('00')) s = s.slice(2);
  if (/^\d{9}$/.test(s) && /^[6-9]/.test(s)) s = `34${s}`;
  return /^\d{8,15}$/.test(s) ? s : null;
}

// ── Helpers internos ──────────────────────────────────────────────────────────

function readWorkbook() {
  return XLSX.readFile(EXCEL_PATH);
}

function saveWorkbook(wb) {
  const tmp = `${EXCEL_PATH}.${process.pid}.tmp`;
  XLSX.writeFile(wb, tmp, { bookType: 'xlsx' });
  if (os.platform() !== 'win32') {
    fs.renameSync(tmp, EXCEL_PATH);
  } else {
    fs.writeFileSync(EXCEL_PATH, fs.readFileSync(tmp));
    fs.unlinkSync(tmp);
  }
}

// ── Estado técnico en archivo separado ───────────────────────────────────────

function readStateWorkbook() {
  if (!fs.existsSync(STATE_FILE_PATH)) {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([Object.values(STATE_FIELDS)]);
    XLSX.utils.book_append_sheet(wb, ws, STATE_SHEET_NAME);
    return wb;
  }
  return XLSX.readFile(STATE_FILE_PATH);
}

function saveStateWorkbook(wb) {
  const tmp = `${STATE_FILE_PATH}.${process.pid}.tmp`;
  XLSX.writeFile(wb, tmp, { bookType: 'xlsx' });
  if (os.platform() !== 'win32') {
    fs.renameSync(tmp, STATE_FILE_PATH);
  } else {
    fs.writeFileSync(STATE_FILE_PATH, fs.readFileSync(tmp));
    fs.unlinkSync(tmp);
  }
}

/**
 * Si el Excel de negocio aún contiene la hoja __bot_state (instalación antigua),
 * la migra al archivo separado y la elimina del Excel de negocio.
 */
function migrateStateSheetToFile() {
  try {
    if (!fs.existsSync(EXCEL_PATH)) return;
    const wb = XLSX.readFile(EXCEL_PATH);
    if (!wb.Sheets[STATE_SHEET_NAME]) return;

    const stateWb = readStateWorkbook();
    const srcWs   = wb.Sheets[STATE_SHEET_NAME];
    const srcHeaders = getRawHeaders(srcWs);
    const srcRange   = XLSX.utils.decode_range(srcWs['!ref']);

    const dstWs      = getOrCreateStateSheet(stateWb);
    let   dstHeaders = getStateHeaders(dstWs);
    dstHeaders       = ensureStateColumns(dstWs, dstHeaders);

    let migrated = 0;
    for (let r = srcRange.s.r + 1; r <= srcRange.e.r; r++) {
      const waId = getCellStr(srcWs, r, srcHeaders[STATE_FIELDS.waId]).trim();
      if (!waId) continue;
      // Solo migrar si no existe ya en el archivo de estado
      if (findStateRowByWaId(dstWs, dstHeaders, waId) !== -1) continue;

      const srcState = rowToState(srcWs, srcHeaders, r);
      if (!srcState) continue;

      const dstRow = appendSheetRow(dstWs);
      const next = { ...srcState, waId };
      next.status = next.stage === 'escalated' ? 'escalated' : 'pending';

      setCellValue(dstWs, dstRow, dstHeaders[STATE_FIELDS.waId],   next.waId);
      setCellValue(dstWs, dstRow, dstHeaders[STATE_FIELDS.status],  String(next.status  || 'pending'));
      setCellValue(dstWs, dstRow, dstHeaders[STATE_FIELDS.stage],   String(next.stage   || 'consent'));
      for (const f of [STATE_FIELDS.attempts, STATE_FIELDS.inactivityAttempts,
        STATE_FIELDS.nextReminderAt, STATE_FIELDS.lastUserMessageAt,
        STATE_FIELDS.lastReminderAt, STATE_FIELDS.lastMessageAt]) {
        const v = next[f];
        if (v === null || v === undefined || v === '') setCellValue(dstWs, dstRow, dstHeaders[f], '');
        else setCellNumber(dstWs, dstRow, dstHeaders[f], Number(v));
      }
      setCellValue(dstWs, dstRow, dstHeaders[STATE_FIELDS.mensajes], JSON.stringify(Array.isArray(next.mensajes) ? next.mensajes : []));
      migrated++;
    }

    if (migrated > 0) saveStateWorkbook(stateWb);

    // Eliminar la hoja del Excel de negocio
    delete wb.Sheets[STATE_SHEET_NAME];
    wb.SheetNames = wb.SheetNames.filter(n => n !== STATE_SHEET_NAME);
    saveWorkbook(wb);

    console.log(`🔀 Migración __bot_state → bot_state.xlsx completada (${migrated} conversaciones migradas)`);
  } catch (err) {
    console.error('❌ Error migrando __bot_state a archivo separado:', err.message);
  }
}

function getRawHeaders(ws) {
  const range = XLSX.utils.decode_range(ws['!ref']);
  const headers = {};
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: range.s.r, c })];
    if (cell?.v) headers[String(cell.v).trim()] = c;
  }
  return headers;
}

function getHeaders(ws) {
  const headers = getRawHeaders(ws);
  // Compatibilidad con variantes históricas del encabezado de AT. Perito.
  if (headers['AT. Perito'] === undefined) {
    if (headers['ATT. Perito'] !== undefined) headers['AT. Perito'] = headers['ATT. Perito'];
    else if (headers['Att. Perito'] !== undefined) headers['AT. Perito'] = headers['Att. Perito'];
  }
  if (headers['Relación'] === undefined && headers['Relacion'] !== undefined) {
    headers['Relación'] = headers['Relacion'];
  }
  return headers;
}

function ensureColumn(ws, headers, colName) {
  if (headers[colName] !== undefined) return headers;
  const range = XLSX.utils.decode_range(ws['!ref']);
  const col   = range.e.c + 1;
  ws[XLSX.utils.encode_cell({ r: range.s.r, c: col })] = { v: colName, t: 's' };
  range.e.c = col;
  ws['!ref'] = XLSX.utils.encode_range(range);
  headers[colName] = col;
  return headers;
}

function ensureAllColumns(ws, headers) {
  for (const [field, colName] of Object.entries(FIELD_TO_COL)) {
    headers = ensureColumn(ws, headers, colName);
  }
  return headers;
}

function findRowByNexp(ws, headers, nexp) {
  const range = XLSX.utils.decode_range(ws['!ref']);
  const col   = headers['Encargo'];
  if (col === undefined) return -1;
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c: col })];
    if (cell && String(cell.v).trim() === String(nexp).trim()) return r;
  }
  return -1;
}

function findRowByPhone(ws, headers, waId) {
  const range = XLSX.utils.decode_range(ws['!ref']);
  const col   = headers['Telefono'] ?? headers['Teléfono'];
  if (col === undefined) return -1;
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c: col })];
    if (!cell) continue;
    const normalized = normalizePhone(String(cell.v));
    if (normalized && normalized === String(waId)) return r;
  }
  return -1;
}

function getCellStr(ws, r, c) {
  if (c === undefined) return '';
  const cell = ws[XLSX.utils.encode_cell({ r, c })];
  return cell ? String(cell.v) : '';
}

function setCellValue(ws, r, c, value) {
  ws[XLSX.utils.encode_cell({ r, c })] = { v: value, t: 's' };
  const range = XLSX.utils.decode_range(ws['!ref']);
  if (c > range.e.c) { range.e.c = c; ws['!ref'] = XLSX.utils.encode_range(range); }
}

function setCellNumber(ws, r, c, value) {
  ws[XLSX.utils.encode_cell({ r, c })] = { v: value, t: 'n' };
  const range = XLSX.utils.decode_range(ws['!ref']);
  if (c > range.e.c) { range.e.c = c; ws['!ref'] = XLSX.utils.encode_range(range); }
}

function deleteSheetColumn(ws, colNum) {
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let c = colNum; c < range.e.c; c++) {
    for (let r = range.s.r; r <= range.e.r; r++) {
      const next = ws[XLSX.utils.encode_cell({ r, c: c + 1 })];
      const curr = XLSX.utils.encode_cell({ r, c });
      if (next) ws[curr] = next; else delete ws[curr];
    }
  }
  for (let r = range.s.r; r <= range.e.r; r++) {
    delete ws[XLSX.utils.encode_cell({ r, c: range.e.c })];
  }
  range.e.c--;
  ws['!ref'] = XLSX.utils.encode_range(range);
}

function deleteSheetRow(ws, rowNum) {
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let r = rowNum; r < range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const next = ws[XLSX.utils.encode_cell({ r: r + 1, c })];
      const curr = XLSX.utils.encode_cell({ r, c });
      if (next) ws[curr] = next; else delete ws[curr];
    }
  }
  for (let c = range.s.c; c <= range.e.c; c++) {
    delete ws[XLSX.utils.encode_cell({ r: range.e.r, c })];
  }
  range.e.r--;
  ws['!ref'] = XLSX.utils.encode_range(range);
}

function getOrCreateStateSheet(wb) {
  if (!wb.Sheets[STATE_SHEET_NAME]) {
    const ws = XLSX.utils.aoa_to_sheet([Object.values(STATE_FIELDS)]);
    wb.Sheets[STATE_SHEET_NAME] = ws;
    if (!wb.SheetNames.includes(STATE_SHEET_NAME)) wb.SheetNames.push(STATE_SHEET_NAME);
  }
  return wb.Sheets[STATE_SHEET_NAME];
}

function getStateHeaders(ws) {
  return getRawHeaders(ws);
}

function ensureStateColumns(ws, headers) {
  for (const colName of Object.values(STATE_FIELDS)) {
    headers = ensureColumn(ws, headers, colName);
  }
  return headers;
}

function findStateRowByWaId(ws, headers, waId) {
  const range = XLSX.utils.decode_range(ws['!ref']);
  const col = headers[STATE_FIELDS.waId];
  if (col === undefined) return -1;
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const v = getCellStr(ws, r, col).trim();
    if (v && v === String(waId)) return r;
  }
  return -1;
}

function appendSheetRow(ws) {
  const range = XLSX.utils.decode_range(ws['!ref']);
  const row = range.e.r + 1;
  range.e.r = row;
  ws['!ref'] = XLSX.utils.encode_range(range);
  return row;
}

function rowToState(ws, headers, r) {
  const waId = getCellStr(ws, r, headers[STATE_FIELDS.waId]).trim();
  if (!waId) return null;

  const mensajesStr = getCellStr(ws, r, headers[STATE_FIELDS.mensajes]).trim();
  let mensajes = [];
  if (mensajesStr) {
    try { mensajes = JSON.parse(mensajesStr); } catch { /* ignorar */ }
  }

  const stage = getCellStr(ws, r, headers[STATE_FIELDS.stage]).trim();
  const status = getCellStr(ws, r, headers[STATE_FIELDS.status]).trim();

  return {
    waId,
    status: status || (stage === 'escalated' ? 'escalated' : 'pending'),
    stage: stage || 'consent',
    attempts: getCellNum(ws, r, headers[STATE_FIELDS.attempts]) || 0,
    inactivityAttempts: getCellNum(ws, r, headers[STATE_FIELDS.inactivityAttempts]) || 0,
    nextReminderAt: getCellNum(ws, r, headers[STATE_FIELDS.nextReminderAt]),
    lastUserMessageAt: getCellNum(ws, r, headers[STATE_FIELDS.lastUserMessageAt]),
    lastReminderAt: getCellNum(ws, r, headers[STATE_FIELDS.lastReminderAt]),
    lastMessageAt: getCellNum(ws, r, headers[STATE_FIELDS.lastMessageAt]),
    mensajes,
  };
}

// ── Conversión fila Excel → objeto conversación ───────────────────────────────

function rowToConv(ws, headers, r) {
  const phoneCellCol = headers['Telefono'] ?? headers['Teléfono'];
  const phoneRaw     = getCellStr(ws, r, phoneCellCol);
  const waId         = normalizePhone(phoneRaw);
  const nexp         = getCellStr(ws, r, headers['Encargo']);
  if (!waId) return null;

  return {
    waId,
    nexp,
    userData: {
      nexp,
      nombre:        getCellStr(ws, r, headers['Asegurado']),
      aseguradora:   getCellStr(ws, r, headers['Aseguradora']),
      causa:         getCellStr(ws, r, headers['Causa']),
      observaciones: getCellStr(ws, r, headers['Observaciones']),
      direccion:     getCellStr(ws, r, headers['Dirección']),
      cp:            getCellStr(ws, r, headers['CP']),
      municipio:     getCellStr(ws, r, headers['Municipio']),
    },
    contacto:  getCellStr(ws, r, headers['Contacto']),
    relacion:  getCellStr(ws, r, headers['Relación']),
    attPerito: getCellStr(ws, r, headers['AT. Perito']),
    danos:     getCellStr(ws, r, headers['Daños']),
    digital:   getCellStr(ws, r, headers['Digital']),
    horario:   getCellStr(ws, r, headers['Horario']),
  };
}

function getCellNum(ws, r, c) {
  if (c === undefined) return null;
  const cell = ws[XLSX.utils.encode_cell({ r, c })];
  if (!cell || cell.v === '' || cell.v === null || cell.v === undefined) return null;
  const v = Number(cell.v);
  return isNaN(v) ? null : v;
}

// ── API de conversaciones ─────────────────────────────────────────────────────

function readConversationByWaId(waId) {
  try {
    const wb      = readWorkbook();
    const ws      = wb.Sheets[wb.SheetNames[0]];
    const headers = getHeaders(ws);
    const row     = findRowByPhone(ws, headers, waId);
    if (row === -1) return null;
    return rowToConv(ws, headers, row);
  } catch (err) {
    console.error('❌ Error leyendo conversación por waId:', err.message);
    return null;
  }
}

function readConversationByNexp(nexp) {
  try {
    const wb      = readWorkbook();
    const ws      = wb.Sheets[wb.SheetNames[0]];
    const headers = getHeaders(ws);
    const row     = findRowByNexp(ws, headers, nexp);
    if (row === -1) return null;
    return rowToConv(ws, headers, row);
  } catch (err) {
    console.error('❌ Error leyendo conversación por nexp:', err.message);
    return null;
  }
}

function readAllConversations() {
  try {
    const wb      = readWorkbook();
    const ws      = wb.Sheets[wb.SheetNames[0]];
    const headers = getHeaders(ws);
    const range   = XLSX.utils.decode_range(ws['!ref']);
    const convs   = [];
    for (let r = range.s.r + 1; r <= range.e.r; r++) {
      const conv = rowToConv(ws, headers, r);
      if (conv && conv.waId) convs.push(conv);
    }
    return convs;
  } catch (err) {
    console.error('❌ Error leyendo todas las conversaciones:', err.message);
    return [];
  }
}

/**
 * Actualiza los campos de la fila correspondiente al waId en el Excel.
 * Acepta los mismos campos lógicos definidos en FIELD_TO_COL.
 */
function updateConversationExcel(waId, fields) {
  try {
    const wb      = readWorkbook();
    const ws      = wb.Sheets[wb.SheetNames[0]];
    let headers   = getHeaders(ws);
    headers       = ensureAllColumns(ws, headers);

    const row = findRowByPhone(ws, headers, waId);
    if (row === -1) {
      console.warn(`⚠️  Excel: waId=${waId} no encontrado para actualizar`);
      return null;
    }

    for (const [field, colName] of Object.entries(FIELD_TO_COL)) {
      if (!(field in fields)) continue;
      const c     = headers[colName];
      if (c === undefined) continue;
      const value = fields[field];

      if (value === null) {
        setCellValue(ws, row, c, '');
      } else if (typeof value === 'number') {
        setCellNumber(ws, row, c, value);
      } else {
        setCellValue(ws, row, c, String(value));
      }
    }

    saveWorkbook(wb);
    return rowToConv(ws, headers, row);
  } catch (err) {
    console.error('❌ Error actualizando conversación en Excel:', err.message);
    return null;
  }
}

function readStateByWaId(waId) {
  try {
    const wb = readStateWorkbook();
    const ws = wb.Sheets[STATE_SHEET_NAME];
    if (!ws) return null;
    const headers = getStateHeaders(ws);
    const row = findStateRowByWaId(ws, headers, waId);
    if (row === -1) return null;
    return rowToState(ws, headers, row);
  } catch (err) {
    console.error('❌ Error leyendo estado técnico por waId:', err.message);
    return null;
  }
}

function readAllStatesFromExcel() {
  try {
    const wb = readStateWorkbook();
    const ws = wb.Sheets[STATE_SHEET_NAME];
    if (!ws) return [];
    const headers = getStateHeaders(ws);
    const range = XLSX.utils.decode_range(ws['!ref']);
    const out = [];
    for (let r = range.s.r + 1; r <= range.e.r; r++) {
      const state = rowToState(ws, headers, r);
      if (state) out.push(state);
    }
    return out;
  } catch (err) {
    console.error('❌ Error leyendo estados técnicos del Excel:', err.message);
    return [];
  }
}

function upsertStateInExcel(waId, patch = {}) {
  try {
    const wb = readStateWorkbook();
    const ws = getOrCreateStateSheet(wb);
    let headers = getStateHeaders(ws);
    headers = ensureStateColumns(ws, headers);

    let row = findStateRowByWaId(ws, headers, waId);
    if (row === -1) row = appendSheetRow(ws);

    const prev = rowToState(ws, headers, row) || { waId: String(waId) };
    const next = {
      ...prev,
      ...patch,
      waId: String(waId),
    };

    next.status = next.stage === 'escalated' ? 'escalated' : 'pending';

    setCellValue(ws, row, headers[STATE_FIELDS.waId], next.waId);
    setCellValue(ws, row, headers[STATE_FIELDS.status], String(next.status || 'pending'));
    setCellValue(ws, row, headers[STATE_FIELDS.stage], String(next.stage || 'consent'));

    const numericFields = [
      STATE_FIELDS.attempts,
      STATE_FIELDS.inactivityAttempts,
      STATE_FIELDS.nextReminderAt,
      STATE_FIELDS.lastUserMessageAt,
      STATE_FIELDS.lastReminderAt,
      STATE_FIELDS.lastMessageAt,
    ];
    for (const fieldName of numericFields) {
      const value = next[fieldName];
      const c = headers[fieldName];
      if (value === null || typeof value === 'undefined' || value === '') setCellValue(ws, row, c, '');
      else setCellNumber(ws, row, c, Number(value));
    }

    const mensajes = Array.isArray(next.mensajes) ? next.mensajes : [];
    setCellValue(ws, row, headers[STATE_FIELDS.mensajes], JSON.stringify(mensajes));

    saveStateWorkbook(wb);
    return next;
  } catch (err) {
    console.error('❌ Error actualizando estado técnico en Excel:', err.message);
    return null;
  }
}

/**
 * Extrae estado técnico legado desde columnas "_..." para migrarlo a la hoja de estado.
 * No modifica el Excel.
 */
function extractTechnicalStateFromExcel() {
  try {
    const wb      = readWorkbook();
    const ws      = wb.Sheets[wb.SheetNames[0]];
    const headers = getRawHeaders(ws);

    const requiredAny = ['_stage', '_attempts', '_inact', '_nextRem', '_lastUser', '_lastRem', '_lastMsg', '_hist'];
    if (!requiredAny.some(name => headers[name] !== undefined)) return {};

    const phoneCol = headers['Telefono'] ?? headers['Teléfono'];
    if (phoneCol === undefined) return {};

    const range = XLSX.utils.decode_range(ws['!ref']);
    const out = {};

    for (let r = range.s.r + 1; r <= range.e.r; r++) {
      const phoneRaw = getCellStr(ws, r, phoneCol);
      const waId = normalizePhone(phoneRaw);
      if (!waId) continue;

      const stage = getCellStr(ws, r, headers['_stage']).trim();
      const attempts = getCellNum(ws, r, headers['_attempts']);
      const inactivityAttempts = getCellNum(ws, r, headers['_inact']);
      const nextReminderAt = getCellNum(ws, r, headers['_nextRem']);
      const lastUserMessageAt = getCellNum(ws, r, headers['_lastUser']);
      const lastReminderAt = getCellNum(ws, r, headers['_lastRem']);
      const lastMessageAt = getCellNum(ws, r, headers['_lastMsg']);
      const mensajesStr = getCellStr(ws, r, headers['_hist']).trim();

      let mensajes = [];
      if (mensajesStr) {
        try { mensajes = JSON.parse(mensajesStr); } catch { /* ignorar JSON inválido */ }
      }

      const hasData = stage || attempts !== null || inactivityAttempts !== null || nextReminderAt !== null
        || lastUserMessageAt !== null || lastReminderAt !== null || lastMessageAt !== null || mensajes.length;
      if (!hasData) continue;

      out[waId] = {
        waId,
        ...(stage ? { stage } : {}),
        ...(attempts !== null ? { attempts } : {}),
        ...(inactivityAttempts !== null ? { inactivityAttempts } : {}),
        ...(nextReminderAt !== null ? { nextReminderAt } : {}),
        ...(lastUserMessageAt !== null ? { lastUserMessageAt } : {}),
        ...(lastReminderAt !== null ? { lastReminderAt } : {}),
        ...(lastMessageAt !== null ? { lastMessageAt } : {}),
        ...(mensajes.length ? { mensajes } : {}),
        status: stage === 'escalated' ? 'escalated' : 'pending',
      };
    }

    return out;
  } catch (err) {
    console.error('❌ Error extrayendo estado técnico legado del Excel:', err.message);
    return {};
  }
}

/**
 * Elimina del Excel cualquier columna técnica cuyo encabezado empiece por "_".
 * Devuelve la lista de columnas eliminadas.
 */
function removeTechnicalColumns() {
  try {
    const wb      = readWorkbook();
    const ws      = wb.Sheets[wb.SheetNames[0]];
    let headers   = getRawHeaders(ws);

    const colsToRemove = Object.entries(headers)
      .filter(([name]) => String(name).startsWith(TECHNICAL_COL_PREFIX))
      .map(([name, col]) => ({ name, col }))
      .sort((a, b) => b.col - a.col); // de derecha a izquierda

    for (const { col } of colsToRemove) {
      deleteSheetColumn(ws, col);
    }

    // Normaliza cabeceras históricas "ATT. Perito"/"Att. Perito" -> "AT. Perito".
    headers = getRawHeaders(ws);
    const row0 = XLSX.utils.decode_range(ws['!ref']).s.r;
    const colAT = headers['AT. Perito'];
    const colATT = headers['ATT. Perito'];
    const colAtt = headers['Att. Perito'];
    let didNormalizeAt = false;

    if (colAT === undefined && colATT !== undefined) {
      setCellValue(ws, row0, colATT, 'AT. Perito');
      didNormalizeAt = true;
    } else if (colAT === undefined && colAtt !== undefined) {
      setCellValue(ws, row0, colAtt, 'AT. Perito');
      didNormalizeAt = true;
    }

    headers = getRawHeaders(ws);
    const mainCol = headers['AT. Perito'];
    const legacyCols = [headers['ATT. Perito'], headers['Att. Perito']]
      .filter((c) => c !== undefined && c !== mainCol)
      .sort((a, b) => b - a);

    for (const legacyCol of legacyCols) {
      const range = XLSX.utils.decode_range(ws['!ref']);
      for (let r = range.s.r + 1; r <= range.e.r; r++) {
        const oldVal = getCellStr(ws, r, legacyCol).trim();
        const newVal = getCellStr(ws, r, mainCol).trim();
        if (!newVal && oldVal) setCellValue(ws, r, mainCol, oldVal);
      }
      deleteSheetColumn(ws, legacyCol);
      didNormalizeAt = true;
    }

    const removed = colsToRemove.map(c => c.name);
    if (removed.length || didNormalizeAt) {
      saveWorkbook(wb);
    }
    return removed;
  } catch (err) {
    console.error('❌ Error eliminando columnas técnicas del Excel:', err.message);
    return [];
  }
}

// ── Limpieza de filas antiguas ────────────────────────────────────────────────

/**
 * Elimina filas cuya "Fecha Encargo" sea más antigua que SINIESTRO_CLEANUP_DAYS.
 * Devuelve los nexp eliminados.
 */
function cleanOldRows() {
  try {
    const wb        = readWorkbook();
    const ws        = wb.Sheets[wb.SheetNames[0]];
    const headers   = getHeaders(ws);
    const fechaCol  = headers['Fecha Encargo'];
    const encargoCol = headers['Encargo'];
    if (fechaCol === undefined) return [];

    const range  = XLSX.utils.decode_range(ws['!ref']);
    const cutoff = Date.now() - CLEANUP_DAYS * 86400000;
    const nexps  = [];

    // Iterar de abajo a arriba para que el shift de filas no altere los índices
    for (let r = range.e.r; r >= range.s.r + 1; r--) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: fechaCol })];
      if (!cell) continue;

      let date = null;
      if (typeof cell.v === 'number') {
        const info = XLSX.SSF.parse_date_code(cell.v);
        if (info) date = new Date(info.y, info.m - 1, info.d);
      } else {
        date = new Date(cell.v);
      }
      if (!date || isNaN(date.getTime())) continue;

      if (date.getTime() < cutoff) {
        if (encargoCol !== undefined) {
          const nexpCell = ws[XLSX.utils.encode_cell({ r, c: encargoCol })];
          if (nexpCell) nexps.push(String(nexpCell.v).trim());
        }
        deleteSheetRow(ws, r);
      }
    }

    if (nexps.length) {
      saveWorkbook(wb);
      console.log(`🗑️  Excel: ${nexps.length} fila(s) antiguas eliminadas (>${CLEANUP_DAYS} días):`, nexps);
    }
    return nexps;
  } catch (err) {
    console.error('❌ Error limpiando filas antiguas del Excel:', err.message);
    return [];
  }
}

/**
 * Aplica techPatch (hoja __bot_state) y excelPatch (hoja principal) en un único
 * ciclo lectura→modificación→guardado protegido por lockfile.
 * Usar siempre este método en lugar de llamar a upsertStateInExcel +
 * updateConversationExcel por separado para evitar escrituras concurrentes.
 */
function applyPatches(waId, techPatch = {}, excelPatch = {}) {
  acquireLock();
  try {
    // ── Patch archivo de estado (bot_state.xlsx) ──────────────────────────────
    const stateWb      = readStateWorkbook();
    const stateWs      = getOrCreateStateSheet(stateWb);
    let   stateHeaders = getStateHeaders(stateWs);
    stateHeaders       = ensureStateColumns(stateWs, stateHeaders);

    let stateRow = findStateRowByWaId(stateWs, stateHeaders, waId);
    if (stateRow === -1) stateRow = appendSheetRow(stateWs);

    const prev = rowToState(stateWs, stateHeaders, stateRow) || { waId: String(waId) };
    const next = { ...prev, ...techPatch, waId: String(waId) };
    next.status = next.stage === 'escalated' ? 'escalated' : 'pending';

    setCellValue(stateWs, stateRow, stateHeaders[STATE_FIELDS.waId],   next.waId);
    setCellValue(stateWs, stateRow, stateHeaders[STATE_FIELDS.status],  String(next.status  || 'pending'));
    setCellValue(stateWs, stateRow, stateHeaders[STATE_FIELDS.stage],   String(next.stage   || 'consent'));

    const numericStateFields = [
      STATE_FIELDS.attempts,
      STATE_FIELDS.inactivityAttempts,
      STATE_FIELDS.nextReminderAt,
      STATE_FIELDS.lastUserMessageAt,
      STATE_FIELDS.lastReminderAt,
      STATE_FIELDS.lastMessageAt,
    ];
    for (const fieldName of numericStateFields) {
      const value = next[fieldName];
      const c     = stateHeaders[fieldName];
      if (value === null || value === undefined || value === '') setCellValue(stateWs, stateRow, c, '');
      else setCellNumber(stateWs, stateRow, c, Number(value));
    }

    const mensajes = Array.isArray(next.mensajes) ? next.mensajes : [];
    setCellValue(stateWs, stateRow, stateHeaders[STATE_FIELDS.mensajes], JSON.stringify(mensajes));

    saveStateWorkbook(stateWb);

    // ── Patch hoja principal del Excel de negocio ─────────────────────────────
    if (Object.keys(excelPatch).length) {
      const wb          = readWorkbook();
      const mainWs      = wb.Sheets[wb.SheetNames[0]];
      let   mainHeaders = getHeaders(mainWs);
      mainHeaders       = ensureAllColumns(mainWs, mainHeaders);

      const mainRow = findRowByPhone(mainWs, mainHeaders, waId);
      if (mainRow === -1) {
        console.warn(`⚠️  Excel: waId=${waId} no encontrado para actualizar`);
      } else {
        for (const [field, colName] of Object.entries(FIELD_TO_COL)) {
          if (!(field in excelPatch)) continue;
          const c     = mainHeaders[colName];
          if (c === undefined) continue;
          const value = excelPatch[field];
          if (value === null)              setCellValue(mainWs, mainRow, c, '');
          else if (typeof value === 'number') setCellNumber(mainWs, mainRow, c, value);
          else                               setCellValue(mainWs, mainRow, c, String(value));
        }
        saveWorkbook(wb);
      }
    }
  } finally {
    releaseLock();
  }
}

module.exports = {
  isBusinessHours,
  normalizePhone,
  cleanOldRows,
  extractTechnicalStateFromExcel,
  removeTechnicalColumns,
  migrateStateSheetToFile,
  readStateByWaId,
  readAllStatesFromExcel,
  upsertStateInExcel,
  readConversationByWaId,
  readConversationByNexp,
  readAllConversations,
  updateConversationExcel,
  applyPatches,
};

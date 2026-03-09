// src/bot/conversationManager.js
// Estado técnico y datos de negocio persistidos en Excel.

const {
  normalizePhone,
  readConversationByWaId,
  extractTechnicalStateFromExcel,
  removeTechnicalColumns,
  readStateByWaId,
  readAllStatesFromExcel,
  upsertStateInExcel,
  updateConversationExcel,
} = require('../utils/excelManager');

const INACTIVITY_MS = Number(
  process.env.INACTIVITY_INTERVAL_MINUTES ||
  (process.env.INACTIVITY_INTERVAL_HOURS || 2) * 60
) * 60000;

// normalizeWaId es la misma lógica que normalizePhone
const normalizeWaId = normalizePhone;
const TECH_FIELDS = new Set([
  'status',
  'stage',
  'attempts',
  'inactivityAttempts',
  'nextReminderAt',
  'lastUserMessageAt',
  'lastReminderAt',
  'lastMessageAt',
  'mensajes',
]);
const EXCEL_FIELDS = new Set([
  'contacto',
  'relacion',
  'attPerito',
  'danos',
  'digital',
  'horario',
]);

function migrateLegacyTechnicalState() {
  const legacy = extractTechnicalStateFromExcel();
  for (const [waId, state] of Object.entries(legacy)) {
    upsertStateInExcel(waId, state);
  }

  const removed = removeTechnicalColumns();
  if (Object.keys(legacy).length || removed.length) {
    console.log(`🧹 Migración de estado técnico completada | convs: ${Object.keys(legacy).length} | columnas eliminadas: ${removed.join(', ') || 'ninguna'}`);
  }
}

migrateLegacyTechnicalState();

function mergeConversation(baseExcel, state) {
  if (!baseExcel) return null;
  const safeState = state || {};

  return {
    ...baseExcel,
    status: safeState.status || (safeState.stage === 'escalated' ? 'escalated' : 'pending'),
    stage: safeState.stage || 'consent',
    attempts: Number(safeState.attempts || 0),
    inactivityAttempts: Number(safeState.inactivityAttempts || 0),
    nextReminderAt: safeState.nextReminderAt ?? null,
    lastUserMessageAt: safeState.lastUserMessageAt ?? null,
    lastReminderAt: safeState.lastReminderAt ?? null,
    lastMessageAt: safeState.lastMessageAt ?? null,
    mensajes: Array.isArray(safeState.mensajes) ? safeState.mensajes : [],
  };
}

function getConversation(waId) {
  const key = normalizeWaId(waId) || String(waId);
  const baseExcel = readConversationByWaId(key);
  if (!baseExcel) return null;
  return mergeConversation(baseExcel, readStateByWaId(key));
}

function getAllConversations() {
  const states = readAllStatesFromExcel();
  const out = [];
  for (const state of states) {
    const key = normalizeWaId(state.waId) || String(state.waId || '');
    if (!key) continue;
    const baseExcel = readConversationByWaId(key);
    if (!baseExcel) continue;
    out.push(mergeConversation(baseExcel, state));
  }
  return out;
}

function createOrUpdateConversation(waId, data = {}) {
  const key = normalizeWaId(waId) || String(waId);
  const techPatch = {};
  const excelPatch = {};

  for (const [k, v] of Object.entries(data || {})) {
    if (TECH_FIELDS.has(k)) techPatch[k] = v;
    if (EXCEL_FIELDS.has(k)) excelPatch[k] = v;
  }

  if (Object.keys(techPatch).length) {
    upsertStateInExcel(key, techPatch);
  } else {
    // Garantiza existencia de estado básico al inicializar conversación.
    upsertStateInExcel(key, {});
  }

  if (Object.keys(excelPatch).length) {
    updateConversationExcel(key, excelPatch);
  }

  return getConversation(key);
}

function recordUserMessage(waId) {
  return createOrUpdateConversation(waId, {
    lastMessageAt:      Date.now(),
    lastUserMessageAt:  Date.now(),
    inactivityAttempts: 0,
    nextReminderAt:     Date.now() + INACTIVITY_MS,
  });
}

function getMensajes(waId) {
  const conv = getConversation(waId);
  return conv?.mensajes || [];
}

function saveMensajes(waId, mensajes) {
  return createOrUpdateConversation(waId, { mensajes });
}

function recordResponse(waId) {
  return createOrUpdateConversation(waId, { lastMessageAt: Date.now() });
}

function markAsEscalated(waId) {
  return createOrUpdateConversation(waId, { stage: 'escalated' });
}

function getNexpByWaId(waId) {
  const conv = getConversation(waId);
  return conv?.nexp || null;
}

module.exports = {
  normalizeWaId,
  getConversation,
  getAllConversations,
  createOrUpdateConversation,
  recordUserMessage,
  recordResponse,
  getMensajes,
  saveMensajes,
  markAsEscalated,
  getNexpByWaId,
  // Alias compatibilidad
  getNexpByChatId: getNexpByWaId,
};

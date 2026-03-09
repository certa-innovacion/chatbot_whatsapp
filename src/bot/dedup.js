// src/bot/dedup.js — Deduplicación de mensajes entrantes
//
// Telegram puede reintentar el webhook si no recibe 200 a tiempo.
// WhatsApp también reintenta con el mismo wamid.
// Este módulo garantiza que cada mensaje se procesa exactamente una vez.

const TTL_MS = 10 * 60 * 1000; // 10 minutos: cubre cualquier reintento razonable

// Map<key, timestamp>  (in-memory; se reinicia con el proceso, suficiente para dedup)
const _seen = new Map();

function _purge() {
  const cutoff = Date.now() - TTL_MS;
  for (const [key, ts] of _seen) {
    if (ts < cutoff) _seen.delete(key);
  }
}

/**
 * Comprueba si este mensaje ya fue procesado.
 * Si no, lo registra como "visto" y devuelve false.
 *
 * @param {string}        channel   - 'telegram' | 'whatsapp' | …
 * @param {string}        userId    - chatId / wa_id
 * @param {number|string} messageId - ID único del mensaje en el canal
 * @returns {boolean} true si es duplicado (no debe procesarse)
 */
function isDuplicate(channel, userId, messageId) {
  if (messageId == null) return false; // sin ID no podemos deduplicar; dejamos pasar
  _purge();
  const key = `${channel}:${userId}:${messageId}`;
  if (_seen.has(key)) return true;
  _seen.set(key, Date.now());
  return false;
}

module.exports = { isDuplicate };

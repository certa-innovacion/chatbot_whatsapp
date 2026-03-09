// src/utils/logger.js — Logging seguro sin PII
//
// Características:
//   · Enmascara automáticamente teléfonos (≥10 dígitos) en strings y objetos
//   · Enmascara nombres en campos conocidos de objetos
//   · Trunca texto libre (mensajes del usuario/IA, bodies HTTP)
//   · log.debug() solo emite en desarrollo (NODE_ENV=development o LOG_LEVEL=debug)
//   · Nunca imprime errores de Axios/HTTP con el body completo en producción
//
// Uso:
//   const log = require('../utils/logger');
//   log.info('Procesando expediente', { nexp, stage });
//   log.info(`Teléfono vinculado: ${log.maskPhone(phone)}`);
//   log.debug('Payload completo:', body);   // solo en dev
//   log.error('Fallo HTTP:', error);

// ── Config ────────────────────────────────────────────────────────────────

const IS_DEBUG = process.env.NODE_ENV === 'development' || process.env.LOG_LEVEL === 'debug';

// ── Regex & conjuntos de campos PII ───────────────────────────────────────

// Cualquier secuencia de ≥10 dígitos consecutivos → probable teléfono
const PHONE_RE = /\b(\d{4})\d{4,}(\d{2})\b/g;

// Claves (normalizadas a minúsculas sin no-alfa) cuyo valor es un teléfono
const PHONE_KEYS = new Set(['phone', 'telefono', 'to', 'phonenumber', 'msisdn', 'mobile']);

// Claves cuyo valor es un nombre propio
const NAME_KEYS = new Set([
  'nombre', 'firstname', 'lastname', 'first_name', 'last_name',
  'username', 'asegurado', 'name', 'fullname', 'displayname',
]);

// Claves cuyo valor es texto libre (truncar, nunca volcar completo)
const TEXT_KEYS = new Set([
  'text', 'caption', 'body', 'payload', 'data', 'content',
  'mensaje', 'mensajeparausuario', 'message', 'description',
]);

const MAX_TEXT = 80; // caracteres máximos para texto libre en logs

// ── Primitivas de enmascarado ─────────────────────────────────────────────

/** Enmascara secuencias de ≥10 dígitos en una cadena. */
function maskPhone(s) {
  if (s == null) return s;
  return String(s).replace(PHONE_RE, (_, head, tail) => `${head}***${tail}`);
}

/** Enmascara un nombre propio: conserva iniciales, oculta el resto. */
function maskName(s) {
  if (s == null) return s;
  return String(s).trim().split(/\s+/).map(w =>
    w.length <= 1 ? w : w[0] + '*'.repeat(w.length - 1)
  ).join(' ');
}

/** Trunca texto libre a MAX_TEXT caracteres. */
function _truncate(s) {
  const str = String(s ?? '');
  return str.length > MAX_TEXT ? `${str.slice(0, MAX_TEXT)}[…]` : str;
}

/** Normaliza una clave para comparar con los conjuntos de campos PII. */
function _normKey(k) {
  return String(k).toLowerCase().replace(/[^a-z]/g, '');
}

// ── Sanitización recursiva de objetos ─────────────────────────────────────

/**
 * Devuelve una copia profunda del valor con PII enmascarada.
 * Arrays se limitan a 10 elementos para evitar logs masivos.
 */
function sanitize(val, depth = 0) {
  if (depth > 4) return '[…]';
  if (val == null) return val;
  if (typeof val === 'string') return maskPhone(val);
  if (typeof val === 'number' || typeof val === 'boolean') return val;

  if (val instanceof Error) {
    // En producción solo el mensaje; en dev el stack completo
    return IS_DEBUG ? { message: val.message, stack: val.stack } : val.message;
  }

  if (Array.isArray(val)) {
    const preview = val.slice(0, 10).map(v => sanitize(v, depth + 1));
    return val.length > 10 ? [...preview, `… +${val.length - 10} más`] : preview;
  }

  if (typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      const nk = _normKey(k);
      if (PHONE_KEYS.has(nk))  out[k] = maskPhone(String(v ?? ''));
      else if (NAME_KEYS.has(nk))  out[k] = maskName(v);
      else if (TEXT_KEYS.has(nk))  out[k] = _truncate(v);
      else                          out[k] = sanitize(v, depth + 1);
    }
    return out;
  }

  return val;
}

// ── Formateo de argumentos ─────────────────────────────────────────────────

function _fmt(args) {
  return args.map(a => {
    if (typeof a === 'string') return maskPhone(a);
    if (a instanceof Error)    return IS_DEBUG ? a.stack : a.message;
    if (typeof a === 'object' && a !== null) return JSON.stringify(sanitize(a));
    return String(a);
  }).join(' ');
}

// ── API pública ───────────────────────────────────────────────────────────

const log = {
  info:  (...args) => console.log(_fmt(args)),
  warn:  (...args) => console.warn(_fmt(args)),
  error: (...args) => console.error(_fmt(args)),

  /** Solo emite si NODE_ENV=development o LOG_LEVEL=debug */
  debug: (...args) => { if (IS_DEBUG) console.log('[DEBUG]', _fmt(args)); },

  // Helpers explícitos para interpolaciones en strings de log
  maskPhone,
  maskName,
  sanitize,
};

// Alias solicitado
log.safeLog = log.info;

module.exports = log;

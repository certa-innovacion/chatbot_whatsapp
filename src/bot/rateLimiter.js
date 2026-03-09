// src/bot/rateLimiter.js — Control de tasa de mensajes
//
// Dos capas de protección:
//   · Por usuario : evita que un único usuario o un bucle en un chat
//                   genere llamadas excesivas a la IA.
//   · Global      : corta cualquier tormenta que un bug pudiera causar
//                   (p.ej. scheduler disparándose en bucle).
//
// Configurable vía .env:
//   RATE_USER_MAX      (default 10)   mensajes por ventana por usuario
//   RATE_USER_WIN_MS   (default 60000) tamaño de la ventana en ms
//   RATE_GLOBAL_MAX    (default 60)   mensajes por ventana global
//   RATE_GLOBAL_WIN_MS (default 60000)

const USER_MAX      = Number(process.env.RATE_USER_MAX      || 10);
const USER_WIN_MS   = Number(process.env.RATE_USER_WIN_MS   || 60_000);
const GLOBAL_MAX    = Number(process.env.RATE_GLOBAL_MAX    || 60);
const GLOBAL_WIN_MS = Number(process.env.RATE_GLOBAL_WIN_MS || 60_000);

// Ventana deslizante: array de timestamps recientes
const _users = new Map(); // userId → number[]
let _global = [];          // number[]

function _slide(arr, windowMs) {
  const cutoff = Date.now() - windowMs;
  return arr.filter(ts => ts > cutoff);
}

/**
 * Comprueba si el mensaje de este usuario puede procesarse.
 * Registra el intento si está permitido.
 *
 * @param {string} userId
 * @returns {{ allowed: boolean, reason?: 'user'|'global' }}
 */
function checkLimit(userId) {
  const now = Date.now();

  // ── Límite global ─────────────────────────────────────────────────────────
  _global = _slide(_global, GLOBAL_WIN_MS);
  if (_global.length >= GLOBAL_MAX) {
    return { allowed: false, reason: 'global' };
  }

  // ── Límite por usuario ────────────────────────────────────────────────────
  const userTs = _slide(_users.get(userId) || [], USER_WIN_MS);
  if (userTs.length >= USER_MAX) {
    return { allowed: false, reason: 'user' };
  }

  // ── Registrar ─────────────────────────────────────────────────────────────
  _global.push(now);
  userTs.push(now);
  _users.set(userId, userTs);

  return { allowed: true };
}

module.exports = { checkLimit };

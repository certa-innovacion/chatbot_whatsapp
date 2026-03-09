// src/bot/stateMachine.js — Máquina de estados de la conversación
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │  STAGES (etapa del proceso pericial)                                  │
// │                                                                        │
// │  consent ──► identification ──► valoracion ──► agendando ──► finalizado│
// │      └──────────────────────────────────────────┘                      │
// │      (cualquier stage puede escalar)        escalated (terminal)       │
// └──────────────────────────────────────────────────────────────────────┘
//
// STATUSES (estado operativo de la conversación):
//   pending               → activa, esperando respuesta del usuario
//   awaiting_continuation → inactividad detectada; esperando confirmación
//   escalated             → derivada a atención humana (terminal)

// ── Definición de stages ──────────────────────────────────────────────────

const STAGES = [
  'consent',          // Usuario confirma continuar por este medio
  'identification',   // Verificamos datos personales y del siniestro
  'valoracion',       // Recogemos datos del daño (tipo visita, urgencia, estimación)
  'agendando',        // Coordinamos fecha/hora de la visita pericial
  'finalizado',       // Proceso completado — responde una vez más si el usuario escribe
  'cerrado',          // Silencio total — TERMINAL definitivo
  'escalated',        // Derivado a humano — TERMINAL
];

const TERMINAL_STAGES = new Set(['finalizado', 'cerrado', 'escalated']);

// ── Transiciones válidas ──────────────────────────────────────────────────

const TRANSITIONS = {
  consent:        ['identification', 'escalated'],
  identification: ['valoracion', 'escalated'],
  valoracion:     ['agendando', 'finalizado', 'escalated'],
  agendando:      ['finalizado', 'escalated'],
  finalizado:     ['cerrado'],
  cerrado:        [],
  escalated:      [],
};

// ── Respuestas seguras para estados terminales ────────────────────────────

const TERMINAL_RESPONSES = {
  finalizado: 'El expediente ya está en gestión con el perito. Se pondrá en contacto con usted. Finalizamos la comunicación por este medio.',
  cerrado:    null, // silencio total
  escalated:  'Su caso está siendo atendido por nuestro equipo. Le contactaremos en breve. Gracias por su paciencia.',
};

// ── API pública ───────────────────────────────────────────────────────────

/**
 * Determina si se puede procesar un mensaje entrante para esta conversación.
 *
 * @param {{ stage?: string, status?: string } | null} conversation
 * @returns {{ ok: boolean, reason?: string, response?: string }}
 *   ok       = true si el mensaje puede procesarse
 *   reason   = por qué fue bloqueado (para logging)
 *   response = mensaje de respuesta seguro a enviar al usuario (si aplica)
 */
function canProcess(conversation) {
  if (!conversation) {
    return { ok: false, reason: 'no_conversation' };
  }

  if (conversation.status === 'escalated') {
    return {
      ok: false,
      reason: 'terminal_status',
      response: TERMINAL_RESPONSES.escalated,
    };
  }

  if (TERMINAL_STAGES.has(conversation.stage)) {
    return {
      ok: false,
      reason: 'terminal_stage',
      response: TERMINAL_RESPONSES[conversation.stage],
    };
  }

  return { ok: true };
}

/**
 * Comprueba si una transición de stage es válida.
 * Útil para validar antes de llamar a conversationManager.createOrUpdateConversation.
 *
 * @param {string} from - stage actual
 * @param {string} to   - stage deseado
 * @returns {boolean}
 */
function isValidTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

module.exports = {
  STAGES,
  TRANSITIONS,
  TERMINAL_STAGES,
  TERMINAL_RESPONSES,
  canProcess,
  isValidTransition,
};

// src/channels/whatsappAdapter.js
// Implementa la interfaz de canal para WhatsApp (Meta Cloud API).
//
// Interfaz universal:
//   sendText(to, text, opts)                        — texto plano
//   sendTemplate(to, templateName, params)          — plantilla WhatsApp
//   normalizeIncoming(body) → NormalizedMessage     — normaliza el payload entrante
//   markAsRead(messageId)                           — marca mensaje como leído

const { sendTextMessage, sendTemplateMessage, markAsRead: _markAsRead } = require('../bot/sendMessage');

const CHANNEL = 'whatsapp';

// ---------------------------------------------------------------------------
// normalizeIncoming
// ---------------------------------------------------------------------------

/**
 * Normaliza el payload de un webhook de WhatsApp en un objeto uniforme.
 *
 * @param {object} body - req.body recibido en POST /webhook
 * @returns {{
 *   channel: string,
 *   userId: string,       — wa_id (número sin +, ej. "34674742564")
 *   text: string,
 *   timestamp: number,
 *   messageId: string,    — wamid
 *   type: string,         — 'text' | 'audio' | 'image' | etc.
 *   from: { phone: string }
 * } | null}
 */
function normalizeIncoming(body) {
  try {
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (!value) return null;

    // Ignorar eventos que no sean mensajes (ej. status updates)
    const messages = value.messages;
    if (!messages || !messages.length) return null;

    const message = messages[0];
    const contact = value.contacts?.[0];

    // Solo procesamos mensajes de texto por ahora
    // (audio/imagen: devolvemos el objeto igualmente para que el handler decida)
    const text = message.text?.body || '';

    return {
      channel: CHANNEL,
      userId: message.from,                    // wa_id sin +
      text: text.trim(),
      timestamp: Number(message.timestamp) * 1000,
      messageId: message.id,                   // wamid
      type: message.type,                      // 'text' | 'audio' | 'image' ...
      from: {
        phone: message.from,
        name: contact?.profile?.name || null,
      },
    };
  } catch (err) {
    console.error('❌ Error normalizando mensaje WhatsApp:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// sendText
// ---------------------------------------------------------------------------

/**
 * Envía texto plano a un número de WhatsApp.
 *
 * @param {string} to   - wa_id (ej. "34674742564")
 * @param {string} text
 * @param {object} opts - opciones opcionales (no usado actualmente, reservado)
 * @returns {Promise<{ messageId: string|null }>}
 */
async function sendText(to, text, opts = {}) {
  return sendTextMessage(to, text);
}

// ---------------------------------------------------------------------------
// sendTemplate
// ---------------------------------------------------------------------------

/**
 * Envía una plantilla de WhatsApp.
 *
 * @param {string} to             - wa_id
 * @param {string} templateName   - nombre de la plantilla en Meta
 * @param {object} params         - { language, components }
 *   components: [
 *     { type: 'header', parameters: [{ type: 'text', parameter_name: 'saludo', text: 'Buenos días' }] },
 *     { type: 'body', parameters: [...] }
 *   ]
 * @returns {Promise<{ messageId: string|null }>}
 */
async function sendTemplate(to, templateName, params = {}) {
  const language = params.language || 'es';
  const components = params.components || [];
  return sendTemplateMessage(to, templateName, language, components);
}

// ---------------------------------------------------------------------------
// markAsRead
// ---------------------------------------------------------------------------

async function markAsRead(messageId) {
  return _markAsRead(messageId);
}

// ---------------------------------------------------------------------------
module.exports = {
  channel: CHANNEL,
  normalizeIncoming,
  sendText,
  sendTemplate,
  markAsRead,
};
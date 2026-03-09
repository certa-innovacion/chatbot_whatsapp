// src/bot/sendMessage.js — Meta WhatsApp Cloud API
const axios = require('axios');
const log = require('../utils/logger');

const BASE_URL = 'https://graph.facebook.com';
const VERSION = process.env.VERSION || 'v25.0';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.USER_ACCESS_TOKEN;

function apiUrl() {
  return `${BASE_URL}/${VERSION}/${PHONE_NUMBER_ID}/messages`;
}

function headers() {
  return {
    Authorization: `Bearer ${ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Normaliza el texto saliente para WhatsApp:
 * - convierte listas HTML (<ul><li>) a viñetas de texto plano
 * - elimina etiquetas HTML residuales
 * - compacta saltos de línea
 */
function normalizeOutgoingText(value) {
  let text = String(value ?? '');

  // Listas HTML -> bullets
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '\n• ');
  text = text.replace(/<\/li>/gi, '');
  text = text.replace(/<\/?(ul|ol|p)[^>]*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');

  // Entidades HTML frecuentes
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Sanea texto para parámetros de templates de WhatsApp:
 * - sin saltos de línea ni tabuladores
 * - máximo 4 espacios consecutivos
 */
function sanitizeTemplateText(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\u00A0/g, ' ')
    .replace(/[^\S\r\n]{5,}/g, '    ')
    .trim();
}

function sanitizeTemplateComponents(components = []) {
  if (!Array.isArray(components)) return [];

  return components.map((component) => {
    if (!component || !Array.isArray(component.parameters)) return component;

    return {
      ...component,
      parameters: component.parameters.map((param) => {
        if (!param || param.type !== 'text' || typeof param.text === 'undefined') {
          return param;
        }
        return { ...param, text: sanitizeTemplateText(param.text) };
      }),
    };
  });
}

/**
 * Envía un mensaje de texto libre a un número de WhatsApp.
 * @param {string} to  - número en formato internacional sin + (ej. "34674742564")
 * @param {string} text
 */
async function sendTextMessage(to, text) {
  if (!to) throw new Error(`Número de destino inválido: ${to}`);
  const cleanText = normalizeOutgoingText(text);

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(to),
    type: 'text',
    text: { body: cleanText },
  };

  try {
    const res = await axios.post(apiUrl(), payload, { headers: headers() });
    const msgId = res.data?.messages?.[0]?.id ?? null;
    log.info(`✅ Texto enviado a ${log.maskPhone(to)} | msgId: ${msgId}`);
    return { messageId: msgId, raw: res.data };
  } catch (err) {
    log.error('❌ Error enviando texto WhatsApp:', err.response?.data || err.message);
    throw err;
  }
}

/**
 * Envía una plantilla de WhatsApp con variables nombradas.
 * @param {string} to
 * @param {string} templateName
 * @param {string} languageCode  - ej. 'es'
 * @param {Array}  components    - array de componentes con parámetros
 */
async function sendTemplateMessage(to, templateName, languageCode = 'es', components = []) {
  if (!to) throw new Error(`Número de destino inválido: ${to}`);
  const safeComponents = sanitizeTemplateComponents(components);

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(to),
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components: safeComponents,
    },
  };

  try {
    const res = await axios.post(apiUrl(), payload, { headers: headers() });
    const msgId = res.data?.messages?.[0]?.id ?? null;
    log.info(`✅ Template "${templateName}" enviado a ${log.maskPhone(to)} | msgId: ${msgId}`);
    return { messageId: msgId, raw: res.data };
  } catch (err) {
    log.error('❌ Error enviando template WhatsApp:', err.response?.data || err.message);
    throw err;
  }
}

/**
 * Marca un mensaje como leído.
 * @param {string} messageId - wamid del mensaje recibido
 */
async function markAsRead(messageId) {
  if (!messageId) return;
  const payload = {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
  };
  try {
    await axios.post(apiUrl(), payload, { headers: headers() });
  } catch (err) {
    // No crítico — no interrumpir el flujo si falla
    log.warn('⚠️ No se pudo marcar como leído:', err.response?.data?.error?.message || err.message);
  }
}

module.exports = { sendTextMessage, sendTemplateMessage, markAsRead };

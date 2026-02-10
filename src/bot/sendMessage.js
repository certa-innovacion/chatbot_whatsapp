// src/bot/sendMessage.js - META WHATSAPP API
require('dotenv').config({ override: true });
const axios = require('axios');

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const META_API_VERSION = process.env.META_API_VERSION || process.env.GRAPH_API_VERSION || 'v21.0';

if (!META_ACCESS_TOKEN) throw new Error('❌ Falta META_ACCESS_TOKEN en .env');
if (!META_PHONE_NUMBER_ID) throw new Error('❌ Falta META_PHONE_NUMBER_ID en .env');

const WHATSAPP_API_URL = `https://graph.facebook.com/${META_API_VERSION}/${META_PHONE_NUMBER_ID}/messages`;

function normalizePhoneNumber(phoneNumber) {
  if (!phoneNumber) return null;
  let normalized = phoneNumber.toString().trim();
  normalized = normalized.replace(/^whatsapp:/i, '');
  normalized = normalized.replace(/[\s\-\(\)]/g, '');
  normalized = normalized.replace(/^\+/, '');
  return normalized;
}

async function sendTextMessage(toNumber, messageText) {
  const to = normalizePhoneNumber(toNumber);
  if (!to) throw new Error(`Número de teléfono inválido: ${toNumber}`);

  console.log('📤 Enviando mensaje de texto...');
  console.log('   To:', to);

  try {
    const response = await axios.post(
      WHATSAPP_API_URL,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body: messageText }
      },
      {
        headers: {
          Authorization: `Bearer ${META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('✅ Mensaje enviado correctamente');
    return response.data;
  } catch (error) {
    console.error('❌ Error enviando mensaje:', error.response?.data || error.message);
    throw error;
  }
}

async function sendTemplateMessage(toNumber, templateName, languageCode = 'es', components = []) {
  const to = normalizePhoneNumber(toNumber);
  if (!to) throw new Error(`Número de teléfono inválido: ${toNumber}`);

  console.log('📤 Enviando template...');
  console.log('   To:', to);
  console.log('   Template:', templateName);
  console.log('   Language:', languageCode);

  try {
    const response = await axios.post(
      WHATSAPP_API_URL,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components
        }
      },
      {
        headers: {
          Authorization: `Bearer ${META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('✅ Template enviado correctamente');
    return response.data;
  } catch (error) {
    console.error('❌ Error enviando template:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Envío POSICIONAL (la Cloud API no admite "name" dentro de parameters).
 * Sirve tanto para templates POSITIONAL como "NAMED" en catálogo, porque el envío es por ORDEN.
 *
 * componentsSpec ejemplo:
 * {
 *   header: ["Buenos días"],
 *   body: ["Allianz", "6585...", "Robo / ..."]
 * }
 */
async function sendTemplatePositional(toNumber, templateName, componentsSpec = {}, languageCode = 'es') {
  const components = [];

  if (Array.isArray(componentsSpec.header) && componentsSpec.header.length > 0) {
    components.push({
      type: 'header',
      parameters: componentsSpec.header.map(v => ({ type: 'text', text: String(v ?? '') }))
    });
  }

  if (Array.isArray(componentsSpec.body) && componentsSpec.body.length > 0) {
    components.push({
      type: 'body',
      parameters: componentsSpec.body.map(v => ({ type: 'text', text: String(v ?? '') }))
    });
  }

  return sendTemplateMessage(toNumber, templateName, languageCode, components);
}

/**
 * Helper específico para tu template "saludo":
 * HEADER: {{saludo}}
 * BODY: {{aseguradora}}, {{nexp}}, {{causa}}
 */
async function sendSaludoTemplate(toNumber, { saludo, aseguradora, nexp, causa }, languageCode = 'es') {
  return sendTemplatePositional(
    toNumber,
    'saludo',
    {
      header: [saludo],
      body: [aseguradora, nexp, causa]
    },
    languageCode
  );
}

/**
 * Marca un mensaje como leído en WhatsApp
 * @param {string} messageId - ID del mensaje a marcar
 */
async function markMessageAsRead(messageId) {
  if (!messageId) return;

  try {
    await axios.post(
      WHATSAPP_API_URL,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId
      },
      {
        headers: {
          Authorization: `Bearer ${META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (error) {
    // No lanzar error para no bloquear el flujo principal
    console.warn('⚠️ No se pudo marcar como leído:', error.response?.data?.error?.message || error.message);
  }
}

/**
 * Envía un template con variables en orden posicional
 * Alias de sendTemplatePositional para compatibilidad
 */
async function sendTemplateWithVariables(toNumber, templateName, variables = [], languageCode = 'es') {
  return sendTemplatePositional(
    toNumber,
    templateName,
    { body: variables },
    languageCode
  );
}

module.exports = {
  sendTextMessage,
  sendTemplateMessage,
  sendTemplatePositional,
  sendSaludoTemplate,
  sendTemplateWithVariables,
  markMessageAsRead,
  normalizePhoneNumber
};

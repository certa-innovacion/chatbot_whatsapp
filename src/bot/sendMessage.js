// src/bot/sendMessage.js - META WHATSAPP API
require('dotenv').config({ override: true });
const axios = require('axios');
const siniestroStore = require('./siniestroStore');

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

async function sendTextMessage(toNumber, messageText, opts = {}) {
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

    const wamid = response?.data?.messages?.[0]?.id || null;

    // Persistencia (opcional)
    if (opts?.nexp) {
      siniestroStore.addMensaje(opts.nexp, {
        direction: 'out',
        type: 'text',
        to,
        text: messageText,
        meta: {
          wamid,
          status: 'accepted_by_meta',
          kind: 'text'
        }
      });
    }

    console.log('✅ Mensaje enviado correctamente');
    return response.data;
  } catch (error) {
    console.error('❌ Error enviando mensaje:', error.response?.data || error.message);
    throw error;
  }
}

async function sendTemplateMessage(toNumber, templateName, languageCode = 'es', components = [], opts = {}) {
  const to = normalizePhoneNumber(toNumber);
  if (!to) throw new Error(`Número de teléfono inválido: ${toNumber}`);

  console.log('📤 Enviando template...');
  console.log('   To:', to);
  console.log('   Template:', templateName);
  console.log('   Language:', languageCode);

  const requestBody = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components
    }
  };

  // Debug opcional
  if (process.env.META_DEBUG_PAYLOAD === '1') {
    console.log('🧾 Payload template:', JSON.stringify(requestBody, null, 2));
  }

  try {
    const response = await axios.post(
      WHATSAPP_API_URL,
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const wamid = response?.data?.messages?.[0]?.id || null;

    // Persistencia (opcional)
    if (opts?.nexp) {
      siniestroStore.addMensaje(opts.nexp, {
        direction: 'out',
        type: 'template',
        to,
        text: `[TEMPLATE:${templateName}]`,
        meta: {
          wamid,
          status: 'accepted_by_meta',
          templateName,
          languageCode,
          components
        }
      });
    }

    console.log('✅ Template enviado correctamente');
    return response.data;
  } catch (error) {
    console.error('❌ Error enviando template:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Envío POSICIONAL
 */
async function sendTemplatePositional(toNumber, templateName, componentsSpec = {}, languageCode = 'es', opts = {}) {
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

  return sendTemplateMessage(toNumber, templateName, languageCode, components, opts);
}

/**
 * Helper específico para "saludo":
 * HEADER: {{saludo}}
 * BODY: {{aseguradora}}, {{nexp}}, {{causa}}
 */
async function sendSaludoTemplate(toNumber, { saludo, aseguradora, nexp, causa }, languageCode = 'es', opts = {}) {
  return sendTemplatePositional(
    toNumber,
    'saludo',
    { header: [saludo], body: [aseguradora, nexp, causa] },
    languageCode,
    opts
  );
}

/**
 * Marca un mensaje como leído
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
    console.warn('⚠️ No se pudo marcar como leído:', error.response?.data?.error?.message || error.message);
  }
}

module.exports = {
  sendTextMessage,
  sendTemplateMessage,
  sendTemplatePositional,
  sendSaludoTemplate,
  markMessageAsRead,
  normalizePhoneNumber
};

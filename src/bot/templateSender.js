// src/bot/templateSender.js — WhatsApp Cloud API
// Envía la plantilla "inicio" con las variables nombradas del siniestro.

const adapter = require('../channels/whatsappAdapter');

/**
 * Saludo por hora:
 * - antes de las 12:00 => Buenos días
 * - resto => Buenas tardes
 */
function buildSaludoByHour(date = new Date()) {
  return date.getHours() < 12 ? 'Buenos días' : 'Buenas tardes';
}

/**
 * Envía la plantilla inicial de WhatsApp al número del siniestro.
 *
 * La plantilla "inicio" tiene:
 *   Header: {{saludo}}
 *   Body:   {{aseguradora}}, {{nexp}}, {{causa}}
 *
 * @param {string} waId        - número WhatsApp sin + (ej. "34674742564")
 * @param {string} templateName - nombre de la plantilla (default: 'inicio')
 * @param {object} userData    - datos del siniestro
 */
async function sendInitialTemplate(waId, templateName = 'inicio', userData = {}) {
  const saludo      = buildSaludoByHour();
  const aseguradora = String(userData.aseguradora ?? userData.Aseguradora ?? '').trim();
  const nexp        = String(userData.nexp ?? userData.Encargo ?? userData.expediente ?? '').trim();
  const causaRaw    = userData.causa ?? userData.Causa ?? userData.observaciones ?? userData.Observaciones ?? '';
  const causa       = String(causaRaw).trim().slice(0, 60);

  if (!aseguradora || !nexp || !causa) {
    throw new Error(
      `Faltan variables del mensaje inicial. ` +
      `aseguradora="${aseguradora}", nexp="${nexp}", causa="${causa}"`
    );
  }

  console.log('🧩 Enviando plantilla inicial WhatsApp...');
  console.log('   Número:', waId);
  console.log('   Template:', templateName);
  console.log('   Vars:', { saludo, aseguradora, nexp, causa });

  return adapter.sendTemplate(waId, templateName, {
    language: 'es',
    components: [
      {
        type: 'header',
        parameters: [
          { type: 'text', parameter_name: 'saludo', text: saludo },
        ],
      },
      {
        type: 'body',
        parameters: [
          { type: 'text', parameter_name: 'aseguradora', text: aseguradora },
          { type: 'text', parameter_name: 'nexp',        text: nexp },
          { type: 'text', parameter_name: 'causa',       text: causa },
        ],
      },
    ],
  });
}

module.exports = { sendInitialTemplate, buildSaludoByHour };

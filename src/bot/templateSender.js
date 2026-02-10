// src/bot/templateSender.js
const { sendTemplateMessage } = require('./sendMessage');
const { normalizeWhatsAppNumber } = require('./utils/phone');

const TEMPLATE_NAME = process.env.WA_TPL_SALUDO;

/**
 * Saludo por hora:
 * - antes de las 12:00 => Buenos días
 * - resto => Buenas tardes
 */
function buildSaludoByHour(date = new Date()) {
  const h = date.getHours();
  return h < 12 ? 'Buenos días' : 'Buenas tardes';
}

/**
 * Envía template inicial "saludo" con variables:
 * Orden (según tu plantilla):
 * 1) {{saludo}}
 * 2) {{aseguradora}}
 * 3) {{nexp}}
 * 4) {{causa}}
 *
 * userData (por fila excel) debe traer: aseguradora, nexp, causa
 */
async function sendInitialTemplate(toNumber, templateName, userData = {}) {
  const template = templateName || TEMPLATE_NAME;

  if (!template) {
    throw new Error('Falta nombre del template (WA_TPL_SALUDO en .env)');
  }

  // Mantengo tu normalización "whatsapp:+..." para compatibilidad con el resto del repo,
  // pero sendMessage.js lo normaliza a formato Meta.
  const to = normalizeWhatsAppNumber(toNumber) || toNumber;

  const saludo = buildSaludoByHour();

  // Soporta nombres alternativos por si el excel trae cabeceras con mayúsculas
  const aseguradora = String(userData.aseguradora ?? userData.Aseguradora ?? '').trim();
  const nexp = String(userData.nexp ?? userData.Encargo ?? userData.expediente ?? '').trim();
  const causa = String(userData.causa ?? userData.Causa ?? '').trim();

  if (!aseguradora || !nexp || !causa) {
    throw new Error(
      `Faltan variables del template. ` +
      `aseguradora="${aseguradora}", nexp="${nexp}", causa="${causa}"`
    );
  }

  console.log('🧩 Enviando template inicial...');
  console.log('   Template:', template);
  console.log('   To:', to);
  console.log('   Vars:', { saludo, aseguradora, nexp, causa });

  const components = [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: saludo },
        { type: 'text', text: aseguradora },
        { type: 'text', text: nexp },
        { type: 'text', text: causa }
      ]
    }
  ];

  console.log('   Components:', JSON.stringify(components, null, 2));

  return sendTemplateMessage(to, template, 'es', components);
}

module.exports = {
  sendInitialTemplate,
};

// src/bot/templateSender.js — v4
const { sendTemplateWithVariables, normalizePhoneNumber } = require('./sendMessage');

const LANG = process.env.WA_TEMPLATE_LANG || 'es';
const TZ = process.env.WA_TIMEZONE || 'Europe/Madrid';

function getSaludoMadrid(date = new Date()) {
  const hourStr = new Intl.DateTimeFormat('es-ES', {
    hour: 'numeric',
    hour12: false,
    timeZone: TZ,
  }).format(date);

  const h = Number(hourStr);
  return h < 14 ? 'Buenos días' : 'Buenas tardes';
}

function safe(v, fallback = '—') {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim();
  return s.length ? s : fallback;
}

/**
 * Template de primer contacto con datos del siniestro
 * Placeholders esperados (en este orden):
 * {{1}} = saludo
 * {{2}} = nombre
 * {{3}} = aseguradora
 * {{4}} = nexp (encargo)
 * {{5}} = fecha siniestro
 * {{6}} = causa
 * {{7}} = teléfono
 *
 * Botones del template (configurados en Meta):
 * - "Sí, son correctos"
 * - "No, hay un error"
 * - "No soy el asegurado"
 */
async function sendConsentTemplate(toNumber, data = {}) {
  const templateName = process.env.WA_TPL_CONSENT || process.env.WA_TPL_SALUDO;
  if (!templateName) throw new Error('Falta WA_TPL_CONSENT o WA_TPL_SALUDO en .env');

  const to = normalizePhoneNumber(toNumber);
  const saludo = getSaludoMadrid();

  const variables = [
    saludo,
    safe(data.nombre),
    safe(data.aseguradora, 'Allianz'),
    safe(data.nexp),
    safe(data.fecha),
    safe(data.causa),
    safe(data.telefono),
  ];

  return sendTemplateWithVariables(to, templateName, variables, LANG);
}

module.exports = {
  sendConsentTemplate,
  getSaludoMadrid,
};
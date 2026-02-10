// src/bot/utils/phone.js

/**
 * Normaliza un número de teléfono a formato "whatsapp:+E164"
 * - Acepta: "+34...", "0034...", "34...", "612345678", etc.
 * - Para números nacionales españoles (9 dígitos, empieza 6-9) añade 34.
 * - Para números extranjeros: deben venir con prefijo internacional (o con 00).
 *
 * Devuelve: "whatsapp:+<digits>" o null si es inválido/ambiguo.
 */
function normalizeWhatsAppNumber(input, defaultCountryCode = '34') {
  if (input === null || input === undefined) return null;

  let s = String(input).trim();

  // Quitar "whatsapp:"
  s = s.replace(/^whatsapp:/i, '').trim();

  // Dejar solo dígitos y '+'
  s = s.replace(/[^\d+]/g, '');

  // 00xxxx -> +xxxx
  if (s.startsWith('00')) s = '+' + s.slice(2);

  // Si NO hay +, puede ser:
  // - nacional ES (9 dígitos) => le ponemos +34
  // - ya internacional sin + (muy habitual que venga "34..." o "49...") => si tiene >=10 dígitos lo aceptamos como internacional
  if (!s.startsWith('+')) {
    if (/^\d{9}$/.test(s) && /^[6-9]/.test(s)) {
      s = '+' + defaultCountryCode + s;
    } else if (/^\d{10,15}$/.test(s)) {
      s = '+' + s; // asumimos que ya viene con country code
    } else {
      return null; // ambiguo / demasiado corto
    }
  }

  // Validar E.164 básico: + seguido de 8..15 dígitos
  const digits = s.replace(/^\+/, '');
  if (!/^\d{8,15}$/.test(digits)) return null;

  return `whatsapp:+${digits}`;
}

/**
 * Valida que un número tenga el formato correcto para "whatsapp:+E164"
 */
function isValidTwilioWhatsAppTo(number) {
  if (!number) return false;

  if (!number.startsWith('whatsapp:+')) return false;

  const digits = number.replace('whatsapp:+', '');

  if (digits.length < 8 || digits.length > 15) return false;

  if (!/^\d+$/.test(digits)) return false;

  return true;
}

module.exports = {
  normalizeWhatsAppNumber,
  isValidTwilioWhatsAppTo
};

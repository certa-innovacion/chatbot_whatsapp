// src/sendInitialMessage.js
// Lee el Excel de Allianz, envía la plantilla inicial de WhatsApp a cada
// número y registra la conversación en conversationManager.

require('dotenv').config({ override: true });
const path = require('path');
const XLSX = require('xlsx');

const { sendInitialTemplate, buildSaludoByHour } = require('./bot/templateSender');
const conversationManager = require('./bot/conversationManager');
const log = require('./utils/logger');

// ── Configuración ─────────────────────────────────────────────────────────

const EXCEL_PATH = process.env.EXCEL_PATH
  || path.join(__dirname, '..', 'data', 'allianz_latest.xlsx');

// Estado que indica que el registro debe enviarse (ajustar según el Excel)
const ESTADO_PENDIENTE = (process.env.EXCEL_ESTADO_PENDIENTE || 'OK').toUpperCase();

// Retardo entre envíos para no saturar la API (ms)
const SEND_DELAY_MS = Number(process.env.SEND_DELAY_MS || 1500);

// ── Utilidades ────────────────────────────────────────────────────────────

/**
 * Convierte un número de teléfono del Excel a wa_id (dígitos puros, sin +).
 * Ej: 674742564 → "34674742564"
 */
function normalizePhone(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/[^\d+]/g, '');
  if (s.startsWith('+'))  s = s.slice(1);
  if (s.startsWith('00')) s = s.slice(2);
  // Número móvil español sin prefijo (9 dígitos, empieza por 6-9)
  if (/^\d{9}$/.test(s) && /^[6-9]/.test(s)) s = `34${s}`;
  return /^\d{8,15}$/.test(s) ? s : null;
}

/**
 * Convierte el número de serie de fecha de Excel a string DD/MM/YYYY.
 */
function excelDateToString(serial) {
  if (!serial || isNaN(serial)) return String(serial || '');
  const date = XLSX.SSF.parse_date_code(serial);
  if (!date) return String(serial);
  return `${String(date.d).padStart(2,'0')}/${String(date.m).padStart(2,'0')}/${date.y}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Lectura del Excel ─────────────────────────────────────────────────────

/**
 * Lee el Excel y devuelve un array de objetos normalizados.
 * Cada objeto tiene exactamente los campos que usa el bot.
 */
function readExcel(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  return rows.map((row, idx) => ({
    rowIndex:    idx + 2, // 1=cabecera, empieza en 2
    nexp:          String(row['Encargo']        || '').trim(),
    fechaSin:      excelDateToString(row['Fecha Sin.']),
    causa:         String(row['Causa']          || '').trim(),
    observaciones: String(row['Observaciones']  || '').trim(),
    aseguradora:   String(row['Aseguradora']    || '').trim(),
    nombre:        String(row['Asegurado']      || '').trim(),
    direccion:     String(row['Dirección']      || '').trim(),
    cp:            String(row['CP']             || '').trim(),
    municipio:     String(row['Municipio']      || '').trim(),
    telefonoRaw:   row['Telefono'] || row['Teléfono'] || '',
    telefono:      normalizePhone(row['Telefono'] || row['Teléfono']),
    estado:        String(row['Estado']         || '').trim().toUpperCase(),
  }));
}

// ── Envío masivo ──────────────────────────────────────────────────────────

/**
 * Procesa todas las filas del Excel:
 *   1. Filtra las que tienen estado PENDIENTE y teléfono válido
 *   2. Inicializa el estado de la conversación en el Excel
 *   3. Envía la plantilla inicial de WhatsApp
 *
 * @param {object} opts
 *   dryRun      {boolean} — si true, solo muestra lo que haría sin enviar
 *   soloNexp    {string}  — si se indica, solo procesa ese nexp
 *   soloTelefono {string} — si se indica, solo procesa ese número
 */
async function sendInitialMessages(opts = {}) {
  const { dryRun = false, soloNexp = null, soloTelefono = null } = opts;

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║     📤 ENVÍO MASIVO DE MENSAJES INICIALES — WhatsApp      ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  if (dryRun) console.log('⚠️  MODO DRY-RUN: no se enviarán mensajes reales\n');

  let filas;
  try {
    filas = readExcel(EXCEL_PATH);
    console.log(`📊 Total filas leídas del Excel: ${filas.length}`);
  } catch (err) {
    console.error('❌ No se pudo leer el Excel:', err.message);
    console.error('   Ruta buscada:', EXCEL_PATH);
    process.exit(1);
  }

  // Aplicar filtros de alcance (nexp o teléfono concreto)
  let filasFiltradas = [...filas];
  if (soloNexp)     filasFiltradas = filasFiltradas.filter(f => f.nexp === soloNexp);
  if (soloTelefono) filasFiltradas = filasFiltradas.filter(f => f.telefono === normalizePhone(soloTelefono));

  console.log(`📊 Filas a evaluar: ${filasFiltradas.length}`);
  console.log('');

  const resultados = { ok: 0, error: 0, omitidos: 0 };

  for (const fila of filasFiltradas) {
    const { nexp, telefono, nombre, aseguradora, causa, observaciones } = fila;
    // Si la causa está vacía, usar las observaciones como fallback (truncadas a 60 car.)
    const causaTemplate = (causa || observaciones)
      .replace(/[\r\n\t]+/g, ' ')   // sin saltos de línea ni tabuladores
      .replace(/ {5,}/g, '    ')    // máximo 4 espacios consecutivos
      .trim()
      .slice(0, 60);
    const waId = telefono;

    // Saltar filas cuyo estado no sea el esperado
    if (fila.estado !== ESTADO_PENDIENTE) {
      console.log(`⏭️  Fila ${fila.rowIndex} omitida — estado="${fila.estado || '(vacío)'}" | nexp=${nexp}`);
      resultados.omitidos++;
      continue;
    }

    // Saltar filas sin teléfono válido
    if (!telefono) {
      console.log(`⏭️  Fila ${fila.rowIndex} omitida — sin teléfono válido "${fila.telefonoRaw}" | nexp=${nexp}`);
      resultados.omitidos++;
      continue;
    }

    console.log(`─────────────────────────────────────────`);
    console.log(`📋 Expediente: ${nexp}`);
    console.log(`📱 Número:     ${log.maskPhone(waId)}`);
    console.log(`👤 Asegurado:  ${nombre}`);
    console.log(`🏢 Aseguradora: ${aseguradora}`);
    console.log(`🔥 Causa:      ${causa}`);

    // 1. Registrar conversación vinculando waId → nexp (estado inicial en Excel)
    const INITIAL_RETRY_MS = Number(
      process.env.INITIAL_RETRY_INTERVAL_MINUTES ||
      (process.env.INITIAL_RETRY_INTERVAL_HOURS || 6) * 60
    ) * 60000;
    if (!dryRun) {
      conversationManager.createOrUpdateConversation(waId, {
        stage:              'consent',
        attempts:           0,
        inactivityAttempts: 0,
        mensajes:           [],
        contacto:           'En curso',
        lastMessageAt:      Date.now(),
        lastUserMessageAt:  null,   // resetear para que el scheduler detecte scenario A
        lastReminderAt:     null,
        nextReminderAt:     Date.now() + INITIAL_RETRY_MS,
      });
    }

    // 3. Enviar plantilla inicial
    if (dryRun) {
      console.log(`🔵 [DRY-RUN] Enviaría plantilla "inicio" a ${waId}`);
      resultados.ok++;
    } else {
      try {
        await sendInitialTemplate(waId, 'inicio', { aseguradora, nexp, causa: causaTemplate });
        console.log(`✅ Plantilla enviada correctamente`);
        resultados.ok++;
        await sleep(SEND_DELAY_MS);
      } catch (err) {
        console.error(`❌ Error enviando a ${log.maskPhone(waId)}:`, err.response?.data?.error?.message || err.message);
        resultados.error++;
      }
    }
    console.log('');
  }

  // ── Resumen ──────────────────────────────────────────────────────────────
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║                    RESUMEN FINAL                          ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`✅ Enviados correctamente: ${resultados.ok}`);
  console.log(`❌ Errores:                ${resultados.error}`);
  console.log(`⏭️  Omitidos:               ${resultados.omitidos}`);
  console.log('');

  return resultados;
}

// ── Utilidad para buildVerificationText (compatibilidad con código existente) ──

function getSaludo() {
  return buildSaludoByHour();
}

async function buildVerificationText(siniestro, saludo) {
  const { aseguradora, nexp, causa, direccion, cp, municipio } = siniestro;
  return (
    `${saludo}, le contactamos desde el Gabinete Pericial Jumar en relación a su siniestro.\n\n` +
    `• Aseguradora: ${aseguradora}\n` +
    `• Expediente:  ${nexp}\n` +
    `• Causa:       ${causa}\n` +
    `• Dirección:   ${direccion}, ${cp} ${municipio}\n\n` +
    `¿Desea continuar la gestión por este medio?`
  );
}

// ── Ejecución directa ─────────────────────────────────────────────────────
// node src/sendInitialMessage.js
// node src/sendInitialMessage.js --dry-run
// node src/sendInitialMessage.js --nexp 880337292
// node src/sendInitialMessage.js --tel 674742564

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const nexpIdx = args.indexOf('--nexp');
  const telIdx  = args.indexOf('--tel');

  sendInitialMessages({
    dryRun,
    soloNexp:     nexpIdx  !== -1 ? args[nexpIdx  + 1] : null,
    soloTelefono: telIdx   !== -1 ? args[telIdx   + 1] : null,
  }).catch(err => {
    console.error('❌ Error fatal:', err);
    process.exit(1);
  });
}

module.exports = { sendInitialMessages, readExcel, normalizePhone, getSaludo, buildVerificationText };
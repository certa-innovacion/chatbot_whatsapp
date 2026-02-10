// src/sendInitialMessage.js — v8 (patched)
require('dotenv').config({ override: true });

const XLSX = require('xlsx');
const path = require('path');

const conversationManager = require('./bot/conversationManager');
const siniestroStore = require('./bot/siniestroStore');
const { sendSaludoTemplate, sendTextMessage, normalizePhoneNumber } = require('./bot/sendMessage');
const { generateResponse } = require('./ai/aiModel');

const EXCEL_PATH = process.env.EXCEL_PATH || path.join(__dirname, '..', 'data', 'allianz_latest.xlsx');
const TEMPLATE_LANG = process.env.WA_TEMPLATE_LANG || 'es';
const TZ = process.env.WA_TIMEZONE || 'Europe/Madrid';

function excelSerialToDate(serial) {
  const n = Number(serial);
  if (Number.isNaN(n)) return null;
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDate(value) {
  if (!value) return '—';

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const dd = String(value.getDate()).padStart(2, '0');
    const mm = String(value.getMonth() + 1).padStart(2, '0');
    const yy = value.getFullYear();
    return `${dd}/${mm}/${yy}`;
  }

  if (typeof value === 'number' || (typeof value === 'string' && /^[0-9]+(\.[0-9]+)?$/.test(value.trim()))) {
    const n = Number(value);
    if (!Number.isNaN(n) && n > 20000 && n < 90000) {
      const d = excelSerialToDate(n);
      if (d) return formatDate(d);
    }
  }

  if (typeof value === 'string') {
    const s = value.trim();
    if (s.includes('T') && s.includes('-')) {
      const parts = s.split('T')[0].split('-');
      if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
    return s;
  }

  return String(value);
}

function capitalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function maskPhone(p) {
  if (!p) return p;
  const head = p.slice(0, Math.min(4, p.length));
  const tail = p.slice(-2);
  return `${head}***${tail}`;
}

/**
 * Normalización para Excel:
 * - usa la misma lógica que el sender (normalizePhoneNumber),
 * - y devuelve string vacío si es inválido (para que validation lo marque).
 */
function normalizePhoneAny(raw) {
  const norm = normalizePhoneNumber(raw);
  return norm || '';
}

function getSaludo() {
  const hourStr = new Intl.DateTimeFormat('es-ES', {
    hour: 'numeric',
    hour12: false,
    timeZone: TZ
  }).format(new Date());

  // tu regla actual:
  return Number(hourStr) < 14 ? 'Buenos días' : 'Buenas tardes';
}

function validateExcelRow(s) {
  const errors = [];
  if (!s.nexp) errors.push('Falta Encargo (nexp)');
  if (!s.nombre) errors.push('Falta Asegurado (nombre)');
  if (!s.telefono) errors.push('Falta Teléfono');
  if (!s.aseguradora) errors.push('Falta Aseguradora');
  if (!s.causa) errors.push('Falta Causa');
  if (!s.fecha || s.fecha === '—') errors.push('Falta Fecha Sin.');

  // teléfono: si existe pero es demasiado corto, probablemente está mal/ambiguo
  if (s.telefono && s.telefono.length < 10) errors.push('Teléfono parece incompleto/ambiguo');

  return { ok: errors.length === 0, errors };
}

function readExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  console.log(`📊 Excel leído: ${rows.length} filas de "${sheetName}"`);

  return rows.map(row => {
    // ✅ nombre viene de "Asegurado"
    const asegurado = row['Asegurado'] || row['ASEGURADO'] || row['Asegurado/a'] || row['Nombre'] || '';

    return {
      nexp: String(row['Encargo'] || '').trim(),
      fecha: formatDate(row['Fecha Sin.']),
      causa: String(row['Causa'] || '').trim(),
      aseguradora: String(row['Aseguradora'] || '').trim(),
      telefono: normalizePhoneAny(row['Teléfono']),
      nombre: capitalizeName(asegurado),
      estado: String(row['Estado'] || '').trim(),
      _raw: row
    };
  });
}

async function buildVerificationTextWithAI(siniestro) {
  const prompt = `
Eres un asistente de un gabinete pericial. Redacta UN único mensaje en español (tono profesional y cercano)
para verificar con el asegurado los datos del siniestro.

Incluye estos datos exactamente:
- Encargo/expediente: ${siniestro.nexp || '—'}
- Fecha siniestro: ${siniestro.fecha || '—'}
- Causa: ${siniestro.causa || '—'}
- Aseguradora: ${siniestro.aseguradora || '—'}
- Nombre: ${siniestro.nombre || '—'}
- Teléfono: ${siniestro.telefono || '—'}

Pide que responda escribiendo:
- "Sí" si todo es correcto, o
- que indique qué dato/s corregir (por ejemplo: "La fecha es...", "Mi nombre es...", etc.)

Añade también (en una sola frase) que si prefiere hablar con un perito, que lo indique y se le contactará.
No uses JSON, no pongas encabezados, no uses listas largas.
`;
  const text = await generateResponse(prompt);
  return String(text || '').trim();
}

async function sendInitial(siniestro) {
  const saludo = getSaludo();

  console.log(`\n📤 Enviando a ${siniestro.nombre} (${maskPhone(siniestro.telefono)})...`);
  console.log(`   Encargo: ${siniestro.nexp} | Causa: ${siniestro.causa} | Fecha: ${siniestro.fecha}`);

  const validation = validateExcelRow(siniestro);

  siniestroStore.update(siniestro.nexp, {
    nexp: siniestro.nexp,
    fecha_siniestro: siniestro.fecha,
    causa: siniestro.causa,
    aseguradora: siniestro.aseguradora,
    telefono: siniestro.telefono,
    nombre: siniestro.nombre,

    datos_verificados: false,
    datos_excel_ok: validation.ok,
    errores_excel: validation.errors,

    tipo_visita: null,
    motivo_tipo_visita: null,
    estimacion_danos: null,
    urgencia: null,

    estado: 'en_curso',
    creado_at: new Date().toISOString(),
    template_enviado: 'saludo',
    message_id: null,

    historial_respuestas: [],
    datos_corregidos: null
  });

  // (opcional) log de validación
  if (!validation.ok) {
    console.warn(`⚠️ Validación Excel KO [${siniestro.nexp}]:`, validation.errors.join(' | '));
  }

  // 1) Template saludo (BODY con 4 params en orden)
  const result = await sendSaludoTemplate(
    siniestro.telefono,
    {
      saludo,
      aseguradora: siniestro.aseguradora || '—',
      nexp: siniestro.nexp || '—',
      causa: siniestro.causa || '—'
    },
    TEMPLATE_LANG
  );

  console.log(`✅ Template enviado — Message ID: ${result?.messages?.[0]?.id || '—'}`);

  siniestroStore.update(siniestro.nexp, {
    message_id: result?.messages?.[0]?.id || null
  });

  conversationManager.createOrUpdateConversation(siniestro.telefono, {
    status: 'pending',
    stage: 'consent',
    attempts: 0,
    misunderstandCount: 0,
    lastMessageAt: Date.now(),
    lastUserMessageAt: null,
    createdAt: Date.now(),
    userData: {
      nexp: siniestro.nexp,
      fecha: siniestro.fecha,
      causa: siniestro.causa,
      aseguradora: siniestro.aseguradora,
      telefono: siniestro.telefono,
      nombre: siniestro.nombre
    },
    history: []
  });

  // 2) Texto IA para verificación
  const verificationText = await buildVerificationTextWithAI(siniestro);
  if (verificationText) {
    await sendTextMessage(siniestro.telefono, verificationText);
    console.log('✅ Mensaje de verificación (IA) enviado');
  } else {
    console.warn('⚠️ No se generó texto IA de verificación (vacío)');
  }

  console.log(`✅ Siniestro ${siniestro.nexp}.json actualizado + conversación registrada`);
  return result;
}

async function main() {
  const arg = process.argv[2];

  if (!arg) {
    console.error('❌ Uso:');
    console.error('   node src/sendInitialMessage.js <nexp>       → Enviar un siniestro');
    console.error('   node src/sendInitialMessage.js --all        → Enviar todos (estado OK)');
    console.error('   node src/sendInitialMessage.js --list       → Listar siniestros');
    process.exit(1);
  }

  let siniestros;
  try {
    siniestros = readExcel(EXCEL_PATH);
  } catch (error) {
    console.error(`❌ Error leyendo Excel (${EXCEL_PATH}):`, error.message);
    console.log('💡 Instala xlsx: npm install xlsx');
    process.exit(1);
  }

  if (siniestros.length === 0) {
    console.log('⚠️  El Excel está vacío');
    process.exit(0);
  }

  if (arg === '--list') {
    console.log('\n📋 Siniestros:\n');
    siniestros.forEach((s, i) => {
      console.log(`  ${i + 1}. [${s.nexp}] ${s.nombre} — ${s.causa} — Tel: ${maskPhone(s.telefono)} — ${s.estado}`);
    });
    process.exit(0);
  }

  if (arg === '--all') {
    const pendientes = siniestros.filter(s => String(s.estado || '').toUpperCase() === 'OK');
    console.log(`\n📤 Enviando a ${pendientes.length} siniestros...\n`);

    let ok = 0, fail = 0;

    for (const s of pendientes) {
      try {
        await sendInitial(s);
        ok++;
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        fail++;

        // ✅ LOG DETALLADO (por siniestro)
        const metaError = e?.response?.data?.error;
        const metaMsg = metaError?.message || '';
        const metaDetails = metaError?.error_data?.details || '';
        console.error(`\n❌ ERROR en [${s.nexp}] Tel:${maskPhone(s.telefono)} Nombre:"${s.nombre}"`);
        console.error(`   Meta msg: ${metaMsg}`);
        if (metaDetails) console.error(`   Meta details: ${metaDetails}`);
        console.error('   Raw:', e?.response?.data || e.message);
        console.error('');
      }
    }

    console.log(`\n📊 Resultado: ${ok} enviados, ${fail} errores`);
    process.exit(fail > 0 ? 1 : 0);
  }

  const siniestro = siniestros.find(s => s.nexp === arg);
  if (!siniestro) {
    console.error(`❌ No se encontró encargo "${arg}"`);
    console.log('💡 Disponibles:', siniestros.map(s => s.nexp).join(', '));
    process.exit(1);
  }

  await sendInitial(siniestro);
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('💥', error?.response?.data || error.message);
    process.exit(1);
  });

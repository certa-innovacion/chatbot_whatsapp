// src/utils/pdfGenerator.js
// Genera un PDF de transcripción de conversación por expediente.
// Salida: docs/conversations/conversation_[nexp].pdf

const path = require('path');
const fs   = require('fs');
const PDFDocument = require('pdfkit');

const OUTPUT_DIR = path.resolve(__dirname, '../../docs/conversations');

// Colores
const COLOR_HEADER_BG = '#1a3a5c';
const COLOR_BOT_BG    = '#e8f0fe';
const COLOR_USER_BG   = '#f0f4f8';
const COLOR_LABEL_BOT = '#1a73e8';
const COLOR_LABEL_USR = '#34495e';
const COLOR_BORDER    = '#d0d7de';
const COLOR_TEXT      = '#1c1c1c';
const COLOR_META      = '#555555';

function formatTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return String(ts);
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Genera el PDF de la conversación.
 *
 * @param {string} nexp          - Número de expediente
 * @param {object} userData      - Datos del siniestro (nombre, aseguradora, etc.)
 * @param {Array}  mensajes      - Array de { direction: 'in'|'out', text, timestamp }
 * @param {object} [extra]       - Campos extra: stage, contacto, digital, horario, attPerito, danos
 * @returns {string}             - Ruta del PDF generado
 */
function generateConversationPdf(nexp, userData = {}, mensajes = [], extra = {}) {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const filename = `conversation_${nexp}.pdf`;
  const filepath = path.join(OUTPUT_DIR, filename);

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  const stream = fs.createWriteStream(filepath);
  doc.pipe(stream);

  const PAGE_W = doc.page.width - 80; // ancho útil (márgenes 40 cada lado)

  // ── Cabecera ──────────────────────────────────────────────────────────────
  doc.rect(40, 40, PAGE_W, 50).fill(COLOR_HEADER_BG);
  doc.fillColor('white')
    .font('Helvetica-Bold').fontSize(14)
    .text('Gabinete Pericial Jumar — Registro de Conversación', 50, 53, { width: PAGE_W - 20 });
  doc.moveDown(0.2);

  // ── Ficha del expediente ──────────────────────────────────────────────────
  doc.y = 110;
  doc.fillColor(COLOR_TEXT).font('Helvetica-Bold').fontSize(10)
    .text(`Expediente: `, { continued: true })
    .font('Helvetica').text(String(nexp || '—'));

  const meta = [
    ['Asegurado',   userData.nombre      || '—'],
    ['Aseguradora', userData.aseguradora  || '—'],
    ['Dirección',   [userData.direccion, userData.cp, userData.municipio].filter(Boolean).join(', ') || '—'],
    ['Causa',       userData.causa        || userData.observaciones || '—'],
  ];
  for (const [label, value] of meta) {
    doc.font('Helvetica-Bold').text(`${label}: `, { continued: true })
      .font('Helvetica').text(value);
  }

  // Datos recogidos durante la conversación
  if (extra.attPerito || extra.danos || extra.digital || extra.horario) {
    doc.moveDown(0.3)
      .font('Helvetica-Bold').fontSize(9).fillColor(COLOR_META)
      .text('Datos recogidos:');
    if (extra.attPerito)  doc.font('Helvetica').text(`  • AT. Perito: ${extra.attPerito}`);
    if (extra.danos)      doc.font('Helvetica').text(`  • Daños estimados: ${extra.danos}`);
    if (extra.digital)    doc.font('Helvetica').text(`  • Videoperitación: ${extra.digital}`);
    if (extra.horario)    doc.font('Helvetica').text(`  • Horario preferido: ${extra.horario}`);
  }

  const resumenLine = [
    extra.stage   && `Estado: ${extra.stage}`,
    extra.contacto && `Contacto: ${extra.contacto}`,
  ].filter(Boolean).join('   |   ');
  if (resumenLine) {
    doc.moveDown(0.3)
      .font('Helvetica-Oblique').fontSize(9).fillColor(COLOR_META)
      .text(resumenLine);
  }

  doc.moveDown(0.5);
  doc.moveTo(40, doc.y).lineTo(40 + PAGE_W, doc.y).strokeColor(COLOR_BORDER).stroke();
  doc.moveDown(0.5);

  // ── Mensajes ──────────────────────────────────────────────────────────────
  doc.fillColor(COLOR_TEXT).font('Helvetica-Bold').fontSize(10)
    .text('Transcripción de la conversación');
  doc.moveDown(0.5);

  if (!mensajes.length) {
    doc.font('Helvetica-Oblique').fillColor(COLOR_META).fontSize(9)
      .text('(Sin mensajes registrados)');
  }

  for (const msg of mensajes) {
    const isBot  = msg.direction === 'out';
    const label  = isBot ? 'Bot' : 'Asegurado';
    const bgCol  = isBot ? COLOR_BOT_BG  : COLOR_USER_BG;
    const lblCol = isBot ? COLOR_LABEL_BOT : COLOR_LABEL_USR;
    const ts     = formatTs(msg.timestamp);
    const text   = String(msg.text || '');

    // Estimar altura del bloque
    const textHeight = doc.heightOfString(text, { width: PAGE_W - 16, fontSize: 9 });
    const blockH = textHeight + 26;

    // Nueva página si no cabe
    if (doc.y + blockH > doc.page.height - 60) {
      doc.addPage();
    }

    const blockY = doc.y;
    doc.rect(40, blockY, PAGE_W, blockH).fill(bgCol).stroke(COLOR_BORDER);

    // Etiqueta + timestamp
    doc.fillColor(lblCol).font('Helvetica-Bold').fontSize(8)
      .text(label, 48, blockY + 6, { continued: true });
    if (ts) {
      doc.fillColor(COLOR_META).font('Helvetica').fontSize(7)
        .text(`  ${ts}`);
    } else {
      doc.text('');
    }

    // Texto del mensaje
    doc.fillColor(COLOR_TEXT).font('Helvetica').fontSize(9)
      .text(text, 48, blockY + 16, { width: PAGE_W - 16 });

    doc.y = blockY + blockH + 4;
  }

  // ── Pie de página ─────────────────────────────────────────────────────────
  const genDate = new Date().toLocaleString('es-ES');
  doc.moveDown(1);
  doc.moveTo(40, doc.y).lineTo(40 + PAGE_W, doc.y).strokeColor(COLOR_BORDER).stroke();
  doc.moveDown(0.3);
  doc.font('Helvetica-Oblique').fontSize(7).fillColor(COLOR_META)
    .text(`Documento generado automáticamente el ${genDate}`, { align: 'center' });

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', () => {
      console.log(`📄 PDF generado: ${filepath}`);
      resolve(filepath);
    });
    stream.on('error', reject);
  });
}

/**
 * Elimina los PDFs de conversación cuya fecha de modificación tenga
 * PDF_CLEANUP_DAYS días o más de antigüedad.
 */
function cleanOldPdfs() {
  const days = Number(process.env.PDF_CLEANUP_DAYS || 30);
  const cutoffMs = Date.now() - days * 86400000;
  if (!fs.existsSync(OUTPUT_DIR)) return;

  const files = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.pdf'));
  for (const file of files) {
    const filepath = path.join(OUTPUT_DIR, file);
    const { mtimeMs } = fs.statSync(filepath);
    if (mtimeMs <= cutoffMs) {
      fs.unlinkSync(filepath);
      console.log(`🗑️  PDF eliminado por antigüedad (${days}d): ${file}`);
    }
  }
}

module.exports = { generateConversationPdf, cleanOldPdfs };

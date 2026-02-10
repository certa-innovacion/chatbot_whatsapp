// src/ai/aiModel.js — v4 (simplificado)
// La lógica del flujo está en messageHandler.js
// Este módulo se encarga de:
// 1. Analizar urgencia con Gemini (Paso 3 silencioso)
// 2. Cargar base de conocimiento desde docs/
const { GoogleGenerativeAI } = require('@google/generative-ai');
const mammoth = require('mammoth');
const fs = require('fs').promises;
const path = require('path');

// ─── Lazy init ───────────────────────────────────────────────────────────
let genAI = null;
let model = null;

function getModel() {
  if (!model) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('❌ Falta GEMINI_API_KEY en .env');

    genAI = new GoogleGenerativeAI(apiKey);
    model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      generationConfig: {
        temperature: Number(process.env.GEMINI_TEMPERATURE) || 0.3,
        maxOutputTokens: 200,
      },
    });
  }
  return model;
}

// ─── Base de conocimiento ────────────────────────────────────────────────
let KNOWLEDGE_BASE = '';
let IS_INITIALIZED = false;

async function loadKnowledgeBase() {
  if (IS_INITIALIZED) return KNOWLEDGE_BASE;

  const documentsPath = path.join(__dirname, '..', '..', 'docs');

  try {
    await fs.access(documentsPath);
    const files = await fs.readdir(documentsPath);
    const docxFiles = files.filter(f => f.endsWith('.docx'));

    if (docxFiles.length === 0) {
      console.warn('⚠️  No hay .docx en docs/');
      IS_INITIALIZED = true;
      return KNOWLEDGE_BASE;
    }

    let kb = '';
    for (const file of docxFiles) {
      try {
        const result = await mammoth.extractRawText({ path: path.join(documentsPath, file) });
        kb += `\n--- ${file} ---\n${result.value}\n`;
      } catch (e) {
        console.error(`❌ Error leyendo ${file}:`, e.message);
      }
    }

    KNOWLEDGE_BASE = kb;
    IS_INITIALIZED = true;
    console.log(`✅ Base de conocimiento cargada: ${docxFiles.length} docs, ${kb.length} chars`);
  } catch {
    console.warn('⚠️  Carpeta docs/ no encontrada');
    IS_INITIALIZED = true;
  }

  return KNOWLEDGE_BASE;
}

// ═══════════════════════════════════════════════════════════════════════════
// ANÁLISIS DE URGENCIA (Paso 3 — silencioso, el usuario no lo ve)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Usa Gemini para decidir si el siniestro es urgente.
 * @param {object} userData - Datos del siniestro
 * @returns {{ urgente: boolean, motivo: string }}
 */
async function analyzeUrgency(userData) {
  try {
    const prompt = `Eres un perito de seguros. Analiza los datos de este siniestro y decide si es URGENTE o no.

DATOS DEL SINIESTRO:
- Causa: ${userData.causa || 'No especificada'}
- Nombre: ${userData.nombre || 'No especificado'}
- Fecha siniestro: ${userData.fecha || 'No especificada'}
- Aseguradora: ${userData.aseguradora || 'No especificada'}
- Estimación daños: ${userData.estimacion_danos ? userData.estimacion_danos + '€' : 'No estimada'}

CRITERIOS DE URGENCIA:
- Daños por agua activos (fugas, goteras que continúan)
- Siniestro que impide habitabilidad (sin calefacción, sin agua caliente, sin luz)
- Daños estructurales
- Riesgo para la seguridad de personas
- Estimación de daños superior a 10.000€
- Robo reciente (menos de 48h)

Responde SOLO con un JSON válido, sin texto adicional:
{
  "urgente": true/false,
  "motivo": "explicación breve"
}`;

    const result = await getModel().generateContent(prompt);
    const text = result.response.text().trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log(`🚨 Urgencia: ${parsed.urgente ? 'SÍ' : 'NO'} — ${parsed.motivo}`);
      return {
        urgente: !!parsed.urgente,
        motivo: parsed.motivo || '',
      };
    }

    throw new Error('No se pudo extraer JSON');
  } catch (error) {
    console.error('❌ Error analizando urgencia:', error.message);
    // Fallback conservador: no marcar como urgente si hay error
    return {
      urgente: false,
      motivo: 'Error en análisis de urgencia - revisión manual recomendada',
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GENERAR RESPUESTA LIBRE CON IA (para recordatorios y casos especiales)
// ═══════════════════════════════════════════════════════════════════════════

async function generateResponse(promptText, context = {}) {
  try {
    await loadKnowledgeBase();

    const fullPrompt = `Eres un asistente del Gabinete Pericial de Jumar Ingeniería, que trabaja con la aseguradora Allianz.

REGLAS:
- Tono profesional pero cercano
- Tratamiento de "usted"
- Máximo 3 líneas
- Sin markdown, sin asteriscos, sin negritas
- Usa "le escribimos" en vez de "le llamamos"
- SOLO devuelve el mensaje final, sin explicaciones

${KNOWLEDGE_BASE ? 'BASE DE CONOCIMIENTO:\n' + KNOWLEDGE_BASE.substring(0, 2000) : ''}

CONTEXTO:
${JSON.stringify(context, null, 2)}

INSTRUCCIÓN:
${promptText}

RESPUESTA:`;

    const result = await getModel().generateContent(fullPrompt);
    let text = result.response.text().trim();

    // Limpiar markdown
    text = text.replace(/\*\*/g, '').replace(/\*/g, '').replace(/#{1,6}\s/g, '').replace(/`/g, '');
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    if (!text) return 'Disculpe, ¿podría reformular su mensaje?';
    return text;

  } catch (error) {
    console.error('❌ Error generando respuesta:', error.message);
    return 'Disculpe, estoy teniendo un problema técnico momentáneo. ¿Podría intentarlo de nuevo?';
  }
}

// ─── Inicialización ──────────────────────────────────────────────────────
loadKnowledgeBase().then(() => {
  console.log('✅ aiModel inicializado');
}).catch(err => {
  console.error('❌ Error init aiModel:', err.message);
});

module.exports = {
  generateResponse,
  analyzeUrgency,
  loadKnowledgeBase,
};
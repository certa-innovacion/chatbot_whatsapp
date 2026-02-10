// src/bot/siniestroStore.js
// Persiste un archivo JSON por siniestro en data/siniestros/{nexp}.json
// Cada actualización hace merge con el contenido existente.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const SINIESTROS_DIR = path.join(DATA_DIR, 'siniestros');

function ensureDir() {
  if (!fs.existsSync(SINIESTROS_DIR)) {
    fs.mkdirSync(SINIESTROS_DIR, { recursive: true });
  }
}

function filePath(nexp) {
  ensureDir();
  return path.join(SINIESTROS_DIR, `${nexp}.json`);
}

/**
 * Lee el JSON de un siniestro. Devuelve {} si no existe.
 */
function read(nexp) {
  if (!nexp) return {};
  const fp = filePath(nexp);
  try {
    if (fs.existsSync(fp)) {
      return JSON.parse(fs.readFileSync(fp, 'utf8'));
    }
  } catch (e) {
    console.error(`❌ Error leyendo ${fp}:`, e.message);
  }
  return {};
}

/**
 * Escribe (merge) datos en el JSON del siniestro.
 * Nunca borra campos existentes; solo añade o sobreescribe.
 */
function update(nexp, data = {}) {
  if (!nexp) {
    console.warn('⚠️  siniestroStore.update sin nexp, ignorando');
    return {};
  }
  const existing = read(nexp);
  const merged = deepMerge(existing, data);
  merged.ultima_actualizacion = new Date().toISOString();

  const fp = filePath(nexp);
  fs.writeFileSync(fp, JSON.stringify(merged, null, 2), 'utf8');
  console.log(`💾 Siniestro ${nexp} guardado → ${fp}`);
  return merged;
}

/**
 * Añade una entrada al historial de respuestas del usuario.
 */
function addRespuesta(nexp, stage, pregunta, respuesta) {
  if (!nexp) return;
  const existing = read(nexp);
  if (!existing.historial_respuestas) existing.historial_respuestas = [];

  existing.historial_respuestas.push({
    timestamp: new Date().toISOString(),
    stage,
    pregunta,
    respuesta,
  });

  update(nexp, { historial_respuestas: existing.historial_respuestas });
}

/**
 * Lista todos los siniestros guardados.
 */
function listAll() {
  ensureDir();
  const files = fs.readdirSync(SINIESTROS_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SINIESTROS_DIR, f), 'utf8'));
      return data;
    } catch {
      return { nexp: f.replace('.json', ''), error: 'No se pudo leer' };
    }
  });
}

// ── Deep merge helper ────────────────────────────────────────────────────
function deepMerge(target, source) {
  const output = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      output[key] = deepMerge(target[key], source[key]);
    } else {
      output[key] = source[key];
    }
  }
  return output;
}

module.exports = {
  read,
  update,
  addRespuesta,
  listAll,
  SINIESTROS_DIR,
};
// src/utils/atomicWrite.js — Escritura atómica de JSON con permisos seguros
//
// Por qué atómica:
//   writeFileSync sobreescribe el fichero en el lugar → si el proceso muere
//   a mitad obtenemos un JSON corrupto e irrecuperable.
//   Escribir a .tmp y luego rename() es una operación atómica a nivel del kernel
//   (en el mismo filesystem): el fichero destino pasa de la versión antigua a la
//   nueva sin estado intermedio visible.
//
// Permisos (Linux/WSL):
//   Ficheros: 600 (rw-------)  → solo el proceso propietario puede leer/escribir
//   Directorios: 700 (rwx------)  → solo el proceso propietario puede entrar
//
// Nota: rename() sobre el destino ya existente es atómico en Linux/macOS.
//       En Windows falla si el destino existe; si algún día se ejecuta en
//       Windows se usa writeFile directo como fallback.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const IS_POSIX   = os.platform() !== 'win32';
const FILE_MODE  = 0o600;  // rw-------
const DIR_MODE   = 0o700;  // rwx------

// ── Directorio seguro ─────────────────────────────────────────────────────

/**
 * Garantiza que el directorio existe y, en POSIX, aplica permisos 700.
 *
 * @param {string} dirPath
 */
function ensureSecureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  if (IS_POSIX) {
    try { fs.chmodSync(dirPath, DIR_MODE); } catch { /* ya existe con permisos adecuados */ }
  }
}

// ── Escritura atómica ─────────────────────────────────────────────────────

/**
 * Serializa `data` como JSON y lo escribe en `filePath` de forma atómica.
 *
 * Pasos:
 *   1. Crea el directorio padre con permisos seguros si no existe.
 *   2. Escribe a `filePath.<pid>.tmp` con permisos 600.
 *   3. Hace rename() al destino final (atómico en POSIX).
 *   4. En POSIX aplica chmod 600 al destino (por si rename hereda permisos del destino antiguo).
 *   5. En caso de error, elimina el .tmp y relanza la excepción.
 *
 * @param {string} filePath - Ruta destino final
 * @param {any}    data     - Dato a serializar (debe ser JSON-serializable)
 */
function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  ensureSecureDir(dir);

  const tmp = `${filePath}.${process.pid}.tmp`;
  const json = JSON.stringify(data, null, 2);

  try {
    fs.writeFileSync(tmp, json, { encoding: 'utf8', mode: FILE_MODE });

    if (IS_POSIX) {
      fs.renameSync(tmp, filePath);
      // renameSync hereda los permisos del destino existente en algunos FS;
      // aplicamos chmod explícito para garantizar 600.
      try { fs.chmodSync(filePath, FILE_MODE); } catch { /* no crítico */ }
    } else {
      // Windows: rename falla si el destino existe; usamos writeFile directo
      fs.writeFileSync(filePath, json, { encoding: 'utf8' });
      try { fs.unlinkSync(tmp); } catch { /* ya escrito */ }
    }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignora error de limpieza */ }
    throw err;
  }
}

module.exports = { writeJsonAtomic, ensureSecureDir };

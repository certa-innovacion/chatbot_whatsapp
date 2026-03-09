#!/usr/bin/env node
// Sincroniza estado de contacto al sistema PeritoLine leyendo el Excel.
// Reglas:
// - Contacto "En curso"  -> se omite
// - Contacto "Sí" / "Si" -> marca contacto y acepta
// - Contacto "No"        -> marca "Contacto fallido" y acepta
// - Además añade resumen IA en "OBSERVACIONES ESPECIALES DEL SINIESTRO"

require('dotenv').config({ override: true });
const path = require('path');
const fs   = require('fs');
const XLSX = require('xlsx');

const PDF_DIR = path.resolve(__dirname, '..', 'docs', 'conversations');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (err) {
  console.error('❌ Falta Playwright. Ejecuta: npm install');
  process.exit(1);
}

const EXCEL_PATH = process.env.EXCEL_PATH || path.join(__dirname, '..', 'data', 'allianz_latest.xlsx');
const LOGIN_URL = String(process.env.LOGIN_URL || '').trim();
const USERNAME = String(process.env.USERNAME || '').trim();
const PASSWORD = String(process.env.PASSWORD || '').trim();

const HEADLESS = /^(1|true|yes)$/i.test(String(process.env.PLAYWRIGHT_HEADLESS || 'false'));
const SLOW_MO = Number(process.env.PLAYWRIGHT_SLOW_MO || 80);
const TIMEOUT_MS = Number(process.env.PLAYWRIGHT_TIMEOUT_MS || 25000);
const DRY_RUN = /^(1|true|yes)$/i.test(String(process.env.PERITOLINE_DRY_RUN || 'false'));
const LAUNCH_ARGS = (process.env.PLAYWRIGHT_LAUNCH_ARGS
  || '--no-sandbox,--disable-setuid-sandbox,--disable-dev-shm-usage,--disable-breakpad,--disable-crash-reporter')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function parseArgs(argv) {
  const out = { encargo: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--encargo' && argv[i + 1]) {
      out.encargo = String(argv[i + 1]).trim();
      i++;
    }
  }
  return out;
}

const CLI = parseArgs(process.argv.slice(2));

function normalizeContacto(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (s === 'en curso') return 'en_curso';
  if (s === 'si' || s === 'sí') return 'si';
  if (s === 'no') return 'no';
  return 'unknown';
}

function v(row, ...keys) {
  for (const key of keys) {
    const val = String(row[key] ?? '').trim();
    if (val) return val;
  }
  const val = String(row[keys[0]] ?? '').trim();
  return val || '-';
}

function buildObservacionesEspecialesText(row) {
  const lines = [
    '[CONTACTO CON IA] Resumen completo de la conversación con el asegurado:',
    '',
    `• Dirección: ${v(row, 'Dirección')}`,
    `• CP: ${v(row, 'CP')}`,
    `• Municipio: ${v(row, 'Municipio')}`,
    `• Teléfono: ${v(row, 'Teléfono')}`,
    `• Relación: ${v(row, 'Relación', 'Relacion')}`,
    `• Daños: ${v(row, 'Daños')}`,
    `• Digital: ${v(row, 'Digital')}`,
    `• Horario: ${v(row, 'Horario')}`,
    `• AT. Perito: ${v(row, 'AT. Perito', 'ATT. Perito', 'Att. Perito')}`,
  ];
  return lines.join('\n');
}

function readTasksFromExcel(filePath, opts = {}) {
  const targetEncargo = String(opts.encargo || '').trim();
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  const tasks = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const encargo = String(row['Encargo'] || '').trim();
    const contactoRaw = row['Contacto'];
    const contacto = normalizeContacto(contactoRaw);
    if (!encargo) continue;
    if (targetEncargo && encargo !== targetEncargo) continue;
    if (contacto === 'en_curso' || contacto === 'unknown') continue;

    tasks.push({
      rowIndex: i + 2,
      encargo,
      contacto,
      observacionesEspeciales: buildObservacionesEspecialesText(row),
    });
  }
  return tasks;
}

async function clickFirstExisting(locators) {
  for (const loc of locators) {
    const total = await loc.count();
    const limit = Math.min(total, 8);
    for (let i = 0; i < limit; i++) {
      const el = loc.nth(i);
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click({ force: true }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function waitAnyVisible(locators, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const loc of locators) {
      const total = await loc.count();
      const limit = Math.min(total, 8);
      for (let i = 0; i < limit; i++) {
        const el = loc.nth(i);
        if (await el.isVisible().catch(() => false)) return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function login(page) {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });

  const userInput = page.locator(
    '#input-username, input[placeholder*="usuario" i], input[name*="user" i], input[type="text"]'
  ).first();
  const passInput = page.locator('#input-password, input[type="password"]').first();

  await userInput.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await userInput.click({ force: true });
  await userInput.evaluate((el) => {
    el.removeAttribute('readonly');
    el.readOnly = false;
  });
  await userInput.fill(USERNAME);

  await passInput.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await passInput.click({ force: true });
  await passInput.evaluate((el) => {
    el.removeAttribute('readonly');
    el.readOnly = false;
  });
  await passInput.fill(PASSWORD);

  const clicked = await clickFirstExisting([
    page.getByRole('button', { name: /iniciar sesi[oó]n/i }),
    page.locator('button:has-text("Iniciar sesión")'),
    page.locator('input[type="submit"][value*="Iniciar" i]'),
  ]);
  if (!clicked) throw new Error('No se encontró el botón de login');

  await page.locator('input[placeholder*="Buscar en siniestros" i]').first().waitFor({
    state: 'visible',
    timeout: TIMEOUT_MS,
  });
}

async function openByEncargo(page, encargo) {
  // Cerrar cualquier popup/modal que pudiera estar abierto
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);

  const searchInput = page.locator('input[placeholder*="Buscar en siniestros" i]').first();
  await searchInput.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await searchInput.click({ force: true });
  await searchInput.fill('');
  await page.waitForTimeout(200);
  await searchInput.fill(encargo);
  await page.waitForTimeout(300);

  // Intentar disparar la búsqueda: primero botón, luego Enter como fallback
  const searchBtnClicked = await clickFirstExisting([
    page.locator('button:has(i.fa-search), a:has(i.fa-search)'),
    page.locator('button:has-text("Buscar"), a:has-text("Buscar")'),
    page.locator('button[type="submit"], input[type="submit"]'),
  ]);
  if (!searchBtnClicked) {
    await searchInput.press('Enter');
  }

  const row = page.locator(`tr:has-text("${encargo}")`).first();
  await row.waitFor({ state: 'visible', timeout: TIMEOUT_MS });

  const opened = await clickFirstExisting([
    row.locator('a.btn.btn-primary, button.btn.btn-primary'),
    row.locator('a:has(i.fa-folder-open), button:has(i.fa-folder-open)'),
    row.locator('a:has(i[class*="folder"]), button:has(i[class*="folder"])'),
  ]);
  if (!opened) throw new Error(`No se encontró botón carpeta para encargo ${encargo}`);

  await page.locator('text=/OBSERVACIONES DEL ENCARGO 01/i').first().waitFor({
    state: 'visible',
    timeout: TIMEOUT_MS,
  });
}

async function fillEditorElement(el, text) {
  await el.evaluate((node, value) => {
    const escapeHtml = (s) => String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    const textToHtml = (s) => {
      const lines = String(s).split('\n');
      return lines.map((line) => line
        ? `<div>${escapeHtml(line)}</div>`
        : '<div><br></div>').join('');
    };

    const tag = (node.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') {
      node.value = value;
    } else if (node.isContentEditable) {
      // Rich text editor: usamos bloques HTML para respetar saltos de línea.
      node.innerHTML = textToHtml(value);
    } else {
      node.textContent = value;
    }
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }, text);
}

async function addObservacionesEspeciales(page, text) {
  const saveLocators = [
    page.locator('button:has-text("Guardar"), a:has-text("Guardar"), input[type="submit"][value*="Guardar" i]'),
    page.getByRole('button', { name: /guardar/i }),
  ];
  const addLocators = [
    page.locator('xpath=//*[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZÁÉÍÓÚÑ", "abcdefghijklmnopqrstuvwxyzáéíóúñ"), "observaciones especiales del siniestro")]/following::*[self::a or self::button][contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZÁÉÍÓÚÑ", "abcdefghijklmnopqrstuvwxyzáéíóúñ"), "anadir") or contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZÁÉÍÓÚÑ", "abcdefghijklmnopqrstuvwxyzáéíóúñ"), "añadir") or contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZÁÉÍÓÚÑ", "abcdefghijklmnopqrstuvwxyzáéíóúñ"), "editar")][1]'),
    page.locator('a:has-text("Añadir"), button:has-text("Añadir"), a:has-text("Anadir"), button:has-text("Anadir")'),
    page.locator('a:has-text("Editar"), button:has-text("Editar")'),
    page.getByText(/^\+?\s*a[nñ]adir$/i),
    page.getByRole('button', { name: /a[nñ]adir/i }),
    page.getByRole('button', { name: /editar/i }),
  ];

  // Si el editor ya estaba abierto, no hace falta pulsar "Añadir".
  let editorOpen = await waitAnyVisible(saveLocators, 1200);
  if (!editorOpen) {
    const title = page.getByText(/OBSERVACIONES ESPECIALES DEL SINIESTRO/i).first();
    if (await title.count()) await title.scrollIntoViewIfNeeded().catch(() => {});

    const addReady = await waitAnyVisible(addLocators, 8000);
    if (addReady) {
      const addClicked = await clickFirstExisting(addLocators);
      if (!addClicked) {
        editorOpen = await waitAnyVisible(saveLocators, 1500);
        if (!editorOpen) throw new Error('No se pudo pulsar "Añadir" en Observaciones especiales');
      }
    } else {
      editorOpen = await waitAnyVisible(saveLocators, 1500);
        if (!editorOpen) throw new Error('No se encontró botón "Añadir" en Observaciones especiales');
    }
  }

  // Esperar controles de edición (Guardar/Cancelar) del editor.
  const saveReady = await waitAnyVisible(saveLocators, TIMEOUT_MS);
  if (!saveReady) throw new Error('No aparecieron los controles de edición de Observaciones especiales');

  // Intentar edición en rich text (jQuery TE / contenteditable / textarea / iframe).
  const editorCandidates = [
    page.locator('.jqte_editor[contenteditable="true"]:visible').last(),
    page.locator('.note-editable[contenteditable="true"]:visible').last(),
    page.locator('[role="textbox"][contenteditable="true"]:visible').last(),
    page.locator('[contenteditable="true"]:visible').last(),
    page.locator('textarea:visible').last(),
  ];

  let written = false;
  for (const candidate of editorCandidates) {
    if (!(await candidate.count())) continue;
    await candidate.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
    if (!(await candidate.isVisible().catch(() => false))) continue;
    await candidate.click({ force: true }).catch(() => {});
    await fillEditorElement(candidate, text);
    written = true;
    break;
  }

  if (!written) {
    const iframe = page.locator('iframe:visible').last();
    if (await iframe.count()) {
      const handle = await iframe.elementHandle();
      const frame = await handle?.contentFrame();
      if (frame) {
        const body = frame.locator('body[contenteditable="true"], body').first();
        if (await body.count()) {
          await body.click({ force: true }).catch(() => {});
          await body.fill(text).catch(async () => {
            await body.evaluate((node, value) => { node.textContent = value; }, text);
          });
          written = true;
        }
      }
    }
  }

  if (!written) throw new Error('No se pudo localizar el editor de Observaciones especiales');

  const saved = await clickFirstExisting([
    ...saveLocators,
  ]);
  if (!saved) throw new Error('No se encontró botón "Guardar" en Observaciones especiales');
}

async function isContactoAlreadyMarked(page) {
  const markedCandidates = [
    // Clase específica del botón CO en PeritoLine
    page.locator('button.btn-sin-co.btn-success'),
    page.locator('button.btn-sin-co[disabled]'),
    // Fallbacks genéricos
    page.locator('xpath=//*[normalize-space()="CO"]/following::*[self::a or self::button][contains(@class,"btn-success")][1]'),
    page.locator('a.btn-success:has-text("C"), button.btn-success:has-text("C")'),
  ];
  for (const loc of markedCandidates) {
    if ((await loc.count()) && (await loc.first().isVisible().catch(() => false))) {
      return true;
    }
  }
  return false;
}

async function openContactoModal(page, opts = {}) {
  const allowMissing = Boolean(opts.allowMissing);
  const modal = page.locator(
    '.modal-dialog:has-text("Contacto Inicial"), div[role="dialog"]:has-text("Contacto Inicial"), .ui-dialog:has-text("Contacto Inicial"), .modal-dialog:has-text("Contacto inicial"), div[role="dialog"]:has-text("Contacto inicial"), .ui-dialog:has-text("Contacto inicial")'
  ).first();

  // Comprobar antes de intentar clicar: si ya está marcado, no hace falta abrir el modal
  if (allowMissing && await isContactoAlreadyMarked(page)) {
    console.log('ℹ️  Contacto ya marcado previamente en PeritoLine; se omite reapertura del modal.');
    return null;
  }

  // Probamos varios candidatos de botón CO/C y validamos apertura real del modal.
  // 1) Botón btn-sin-co (clase específica de PeritoLine) — el más fiable.
  // 2) Fallbacks genéricos por onclick/título/texto.
  const candidates = [
    page.locator('button.btn-sin-co:not([disabled]), a.btn-sin-co:not([disabled])'),
    page.locator('xpath=//*[normalize-space()="CO"]/following::*[self::a or self::button][contains(@class,"btn") and not(@disabled)][1]'),
    page.locator('[onclick*="contacto" i], [title*="contacto" i]'),
    page.locator('a.btn:has-text("C"), button.btn:has-text("C")'),
    page.locator('a:has-text("C"), button:has-text("C")'),
    page.getByRole('button', { name: /^C$/ }),
  ];

  for (const group of candidates) {
    const total = await group.count();
    const limit = Math.min(total, 8);
    for (let i = 0; i < limit; i++) {
      const btn = group.nth(i);
      if (!(await btn.isVisible().catch(() => false))) continue;
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ force: true }).catch(() => {});
      try {
        await modal.waitFor({ state: 'visible', timeout: 5000 });
        return modal;
      } catch {
        // intentar siguiente candidato
      }
    }
  }

  // Último intento: usar cualquier "Aceptar" dentro de un diálogo visible para
  // aceptar el contacto aunque el título del modal sea distinto.
  const genericDialog = page.locator('.modal-dialog:visible, div[role="dialog"]:visible, .ui-dialog:visible').first();
  const genericAccept = genericDialog.getByRole('button', { name: /aceptar/i }).first();
  if (await genericAccept.count()) {
    return genericDialog;
  }

  if (allowMissing && await isContactoAlreadyMarked(page)) {
    console.log('ℹ️  Contacto ya marcado previamente en PeritoLine; se omite reapertura del modal.');
    return null;
  }

  throw new Error('No se pudo abrir el modal "Contacto Inicial" (botón CO/C no encontrado o no operativo)');
}

async function setContactoFallido(modal, shouldBeFail) {
  const toggle = modal.locator(
    'xpath=.//*[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZÁÉÍÓÚ", "abcdefghijklmnopqrstuvwxyzáéíóú"), "contacto fallido")]/following::*[normalize-space()="No" or normalize-space()="Sí" or normalize-space()="Si"][1]'
  ).first();

  if (!(await toggle.count())) {
    // Fallback: input checkbox asociado a "Contacto fallido"
    const checkbox = modal.locator('input[type="checkbox"]').first();
    if (await checkbox.count()) {
      const checked = await checkbox.isChecked();
      if (checked !== shouldBeFail) await checkbox.click({ force: true });
    }
    return;
  }

  const label = String(await toggle.innerText()).trim().toLowerCase();
  const isYes = label === 'sí' || label === 'si';
  if (shouldBeFail && !isYes) await toggle.click({ force: true });
  if (!shouldBeFail && isYes) await toggle.click({ force: true });
}

async function acceptModal(modal) {
  const clicked = await clickFirstExisting([
    modal.getByRole('button', { name: /aceptar/i }),
    modal.locator('button:has-text("Aceptar"), a:has-text("Aceptar")'),
  ]);
  if (!clicked) throw new Error('No se encontró botón "Aceptar" en modal de contacto');
  await modal.waitFor({ state: 'hidden', timeout: TIMEOUT_MS }).catch(() => {});
}

async function uploadPdfToEncargo(page, encargo) {
  const shouldUpload = /^(1|true|yes)$/i.test(String(process.env.UPLOAD_CONVERSATIONS_TO_PL ?? 'true'));
  if (!shouldUpload) {
    console.log('ℹ️  UPLOAD_CONVERSATIONS_TO_PL=false — se omite subida de PDF.');
    return;
  }

  const pdfPath = path.join(PDF_DIR, `conversation_${encargo}.pdf`);
  if (!fs.existsSync(pdfPath)) {
    console.log(`⚠️  Sin PDF para encargo ${encargo}, se omite subida.`);
    return;
  }

  // Ir a la pestaña Docs (el badge numérico forma parte del texto, por eso no anclamos al inicio)
  const docsClicked = await clickFirstExisting([
    page.locator('a[href*="doc" i]').filter({ hasText: /docs/i }),
    page.locator('a').filter({ hasText: /docs/i }),
    page.getByRole('link', { name: /docs/i }),
  ]);
  if (!docsClicked) throw new Error('No se encontró la pestaña "Docs" en PeritoLine');
  await page.waitForTimeout(800);

  // Click en "Subir documentos"
  const uploadBtn = page.locator('button, a').filter({ hasText: /subir documentos/i }).first();
  await uploadBtn.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await uploadBtn.click({ force: true });

  // Esperar el modal
  const modal = page.locator('.modal-dialog, div[role="dialog"]')
    .filter({ hasText: /subir documentos/i }).first();
  await modal.waitFor({ state: 'visible', timeout: TIMEOUT_MS });

  // Seleccionar el archivo (funciona aunque el input sea invisible)
  const fileInput = modal.locator('input[type="file"]').first();
  await fileInput.setInputFiles(pdfPath);
  await page.waitForTimeout(600);

  // Si el modal sigue abierto (la subida no fue automática), pulsar "Subir documentos"
  const stillOpen = await modal.isVisible().catch(() => false);
  if (stillOpen) {
    const confirmBtn = modal.locator('button, a').filter({ hasText: /subir documentos/i }).first();
    const hasConfirm = await confirmBtn.count();
    if (hasConfirm) {
      await confirmBtn.click({ force: true });
    }
  }

  // Esperar cierre del modal
  await modal.waitFor({ state: 'hidden', timeout: TIMEOUT_MS }).catch(() => {});
  console.log(`📤 PDF subido: conversation_${encargo}.pdf`);
}

async function processTask(page, task) {
  const shouldFail = task.contacto === 'no';
  await openByEncargo(page, task.encargo);
  await addObservacionesEspeciales(page, task.observacionesEspeciales);
  // PeritoLine puede redirigir al dashboard al guardar — reabrimos el encargo
  await openByEncargo(page, task.encargo);
  const modal = await openContactoModal(page, { allowMissing: !shouldFail });
  if (modal) {
    await setContactoFallido(modal, shouldFail);
    await acceptModal(modal);
  }
  // Subir PDF de conversación (si existe)
  await uploadPdfToEncargo(page, task.encargo);
}

async function main() {
  if (!LOGIN_URL || !USERNAME || !PASSWORD) {
    throw new Error('Faltan LOGIN_URL / USERNAME / PASSWORD en .env');
  }

  const tasks = readTasksFromExcel(EXCEL_PATH, { encargo: CLI.encargo });
  if (!tasks.length) {
    console.log('ℹ️ No hay siniestros para procesar (solo se procesan Contacto = Sí/No).');
    return;
  }

  console.log(`📄 Tareas encontradas: ${tasks.length}`);
  if (DRY_RUN) {
    for (const t of tasks) {
      console.log(`- Fila ${t.rowIndex} | Encargo ${t.encargo} | Contacto=${t.contacto}`);
    }
    console.log('🔵 DRY_RUN activo: sin acciones en PeritoLine.');
    return;
  }

  const browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: SLOW_MO,
    args: LAUNCH_ARGS,
    chromiumSandbox: false,
  });
  const context = await browser.newContext({ viewport: { width: 1700, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);

  let ok = 0;
  let error = 0;

  try {
    await login(page);

    for (const task of tasks) {
      try {
        console.log(`\n▶ Procesando fila ${task.rowIndex} | Encargo ${task.encargo} | Contacto=${task.contacto}`);
        await processTask(page, task);
        ok++;
        console.log('✅ Procesado');
      } catch (err) {
        error++;
        console.error(`❌ Error en encargo ${task.encargo}: ${err.message}`);
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  console.log('\n══════════════════════════════');
  console.log(`✅ Correctos: ${ok}`);
  console.log(`❌ Errores:   ${error}`);
  console.log('══════════════════════════════');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Fallo fatal Playwright:', err.message);
    process.exit(1);
  });
}

module.exports = { main };

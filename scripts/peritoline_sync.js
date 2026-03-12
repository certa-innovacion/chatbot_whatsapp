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
const VIRTUAL_PERITO_NAME = String(process.env.PERITOLINE_VIRTUAL_PERITO_NAME || 'PERITOVIRTUALDESARRO').trim().toUpperCase();
const LAUNCH_ARGS = (process.env.PLAYWRIGHT_LAUNCH_ARGS
  || '--no-sandbox,--disable-setuid-sandbox,--disable-dev-shm-usage,--disable-breakpad,--disable-crash-reporter')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function parseArgs(argv) {
  const out = { encargo: null, anotacion: '', assignOnly: false, finalSync: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--encargo' && argv[i + 1]) {
      out.encargo = String(argv[i + 1]).trim();
      i++;
    }
    if (arg === '--anotacion' && argv[i + 1]) {
      out.anotacion = String(argv[i + 1]).trim();
      i++;
    }
    if (arg === '--assign-only') out.assignOnly = true;
    if (arg === '--final-sync')  out.finalSync  = true;
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
  if (s === 'no encontrado') return 'no_encontrado';
  if (s === 'error') return 'error';
  return 'unknown';
}

const ANOTACION_BY_CONTACTO = {
  no_encontrado: '[IA] Teléfono no encontrado',
  error:         '[IA] Contacto erróneo',
};

function v(row, ...keys) {
  for (const key of keys) {
    const val = String(row[key] ?? '').trim();
    if (val) return val;
  }
  const val = String(row[keys[0]] ?? '').trim();
  return val || '-';
}

function buildObservacionesEspecialesText(row) {
  const digital = v(row, 'Digital');
  const horario = v(row, 'Horario');
  const isDigital = /^s[ií]$/i.test(digital.trim());
  const digitalLine = isDigital && horario && horario !== '-'
    ? `• Digital: Sí (${horario})`
    : `• Digital: ${digital}`;

  const lines = [
    '[CONTACTO CON IA] Resumen completo de la conversación con el asegurado:',
    '',
    `• Dirección: ${v(row, 'Dirección')}`,
    `• CP: ${v(row, 'CP')}`,
    `• Municipio: ${v(row, 'Municipio')}`,
    `• Teléfono: ${v(row, 'Teléfono')}`,
    `• Relación: ${v(row, 'Relación', 'Relacion')}`,
    `• Daños: ${v(row, 'Daños')}`,
    digitalLine,
    `• AT. Perito: ${v(row, 'AT. Perito', 'ATT. Perito', 'Att. Perito')}`,
  ];
  return lines.join('\n');
}

function readTasksFromExcel(filePath, opts = {}) {
  const targetEncargo = String(opts.encargo || '').trim();
  const anotacion = String(opts.anotacion || '').trim();
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
      anotacion: anotacion || ANOTACION_BY_CONTACTO[contacto] || '',
      finalSync: opts.finalSync || false,
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

  await page.waitForTimeout(800);

  // Si el encargo se abrió en otra pestaña (p.ej. Docs), volver a la pestaña principal.
  const obsLabel = page.locator('text=/OBSERVACIONES DEL ENCARGO 01/i').first();
  const obsVisible = await obsLabel.isVisible().catch(() => false);
  if (!obsVisible) {
    await clickFirstExisting([
      page.locator('ul.nav.nav-tabs li').first().locator('a'),
      page.locator('.nav-tabs li:first-child a'),
      page.locator('.nav-tabs a').first(),
    ]).catch(() => {});
    await page.waitForTimeout(400);
  }

  await obsLabel.waitFor({
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
  // Hacer scroll hasta la sección y pulsar siempre Añadir o Editar (no usar pre-check
  // de saveLocators porque da falsos positivos con otros botones Guardar de la página).
  const sectionTitle = page.getByText(/OBSERVACIONES ESPECIALES DEL SINIESTRO/i).first();
  if (await sectionTitle.count()) await sectionTitle.scrollIntoViewIfNeeded().catch(() => {});

  const addEditLocators = [
    page.locator('xpath=//*[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZÁÉÍÓÚÑ", "abcdefghijklmnopqrstuvwxyzáéíóúñ"), "observaciones especiales del siniestro")]/following::*[self::a or self::button][contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZÁÉÍÓÚÑ", "abcdefghijklmnopqrstuvwxyzáéíóúñ"), "anadir") or contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZÁÉÍÓÚÑ", "abcdefghijklmnopqrstuvwxyzáéíóúñ"), "añadir") or contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZÁÉÍÓÚÑ", "abcdefghijklmnopqrstuvwxyzáéíóúñ"), "editar")][1]'),
    page.getByRole('button', { name: /editar/i }),
    page.getByRole('button', { name: /a[nñ]adir/i }),
    page.locator('a:has-text("Editar"), button:has-text("Editar")'),
    page.locator('a:has-text("Añadir"), button:has-text("Añadir"), a:has-text("Anadir"), button:has-text("Anadir")'),
  ];

  const btnReady = await waitAnyVisible(addEditLocators, 8000);
  if (!btnReady) throw new Error('No se encontró botón "Editar/Añadir" en Observaciones especiales del siniestro');
  const btnClicked = await clickFirstExisting(addEditLocators);
  if (!btnClicked) throw new Error('No se pudo pulsar "Editar/Añadir" en Observaciones especiales del siniestro');

  // Esperar que aparezca el botón Guardar (indica que el editor está abierto).
  const saveLocators = [
    page.locator('button:has-text("Guardar"), a:has-text("Guardar"), input[type="submit"][value*="Guardar" i]'),
    page.getByRole('button', { name: /guardar/i }),
  ];
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

  const saved = await clickFirstExisting(saveLocators);
  if (!saved) throw new Error('No se encontró botón "Guardar" en Observaciones especiales');
  console.log('📝 Observaciones especiales escritas/actualizadas');
}

async function isContactoAlreadyMarked(page) {
  // Solo consideramos "ya marcado" si el botón CO está deshabilitado (estado definitivo).
  // Los selectores de btn-success dan falsos positivos en algunos estados del encargo.
  const loc = page.locator('button.btn-sin-co[disabled], a.btn-sin-co[disabled]');
  return (await loc.count()) > 0 && (await loc.first().isVisible().catch(() => false));
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

async function saveDebugSnapshot(page, label) {
  try {
    const logsDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const base = path.join(logsDir, `debug_${label}_${Date.now()}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    fs.writeFileSync(`${base}.html`, await page.content());
    console.log(`🔍 Debug snapshot guardado: ${base}.png`);
  } catch (e) {
    console.warn('No se pudo guardar snapshot de debug:', e.message);
  }
}

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeComparable(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

async function getVisiblePeritoSectionText(page) {
  const sectionCandidates = [
    page.locator('xpath=//*[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ/ÁÉÍÓÚÑ", "abcdefghijklmnopqrstuvwxyz/áéíóúñ"), "perito/s")]/ancestor::*[self::div or self::td or self::section or self::fieldset][1]'),
    page.locator('xpath=//*[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZÁÉÍÓÚÑ", "abcdefghijklmnopqrstuvwxyzáéíóúñ"), "supervisan")]/ancestor::*[self::div or self::td or self::section or self::fieldset][1]'),
  ];

  for (const loc of sectionCandidates) {
    const total = await loc.count();
    const limit = Math.min(total, 8);
    for (let i = 0; i < limit; i++) {
      const el = loc.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const text = String(await el.innerText().catch(() => '')).trim();
      if (!text) continue;
      const n = normalizeComparable(text);
      if (n.includes('perito') || n.includes('supervisan')) return text;
    }
  }

  return '';
}

async function isPeritoAssigned(page, peritoName) {
  const normName = normalizeComparable(peritoName);
  const sectionText = normalizeComparable(await getVisiblePeritoSectionText(page));
  if (sectionText) {
    if (sectionText.includes('sin perito asignado')) return false;
    if (sectionText.includes(normName) || sectionText.includes('peritovirtual')) return true;
  }

  // Fallback: marcador exacto de estado sin perito (evita falsos positivos como
  // "LISTA DE ENCARGOS SIN PERITO ASIGNADO").
  const explicitUnassigned = page.locator('text=/^\\s*sin\\s+perito\\s+asignado\\s*$/i');
  {
    const total = await explicitUnassigned.count();
    const limit = Math.min(total, 6);
    for (let i = 0; i < limit; i++) {
      if (await explicitUnassigned.nth(i).isVisible().catch(() => false)) return false;
    }
  }

  // Fallback: evitar los contadores globales de peritos del dashboard.
  const nonCountersPeritoField = page.locator(
    `xpath=//*[not(ancestor::*[@id="contadores-peritos"])][self::input][@readonly and contains(translate(@value, "ABCDEFGHIJKLMNOPQRSTUVWXYZÁÉÍÓÚÑ", "abcdefghijklmnopqrstuvwxyzáéíóúñ"), "${normName}")]`
  );
  if (await nonCountersPeritoField.count()) return true;

  // Fallback conservador: si no hay evidencia clara de "sin perito", tratamos como asignado.
  const nameRe = new RegExp(escapeRegExp(peritoName), 'i');
  const directInputs = page.locator('input[readonly], input.perito, span, div, strong').filter({ hasText: nameRe });
  if (await directInputs.count()) return true;

  return true;
}

async function confirmDeletePeritoModal(page) {
  const modalCandidates = [
    page.locator('.modal-dialog:has-text("ELIMINAR PERITO"), div[role="dialog"]:has-text("ELIMINAR PERITO"), .ui-dialog:has-text("ELIMINAR PERITO"), .modal-dialog:has-text("Eliminar perito"), div[role="dialog"]:has-text("Eliminar perito"), .ui-dialog:has-text("Eliminar perito")'),
    page.locator('.modal-dialog:visible, div[role="dialog"]:visible, .ui-dialog:visible').filter({ hasText: /eliminar.*perito|perito/i }),
  ];
  const modalReady = await waitAnyVisible(modalCandidates, 6000);
  if (!modalReady) return false;

  let modal = null;
  for (const loc of modalCandidates) {
    if ((await loc.count()) && (await loc.first().isVisible().catch(() => false))) {
      modal = loc.first();
      break;
    }
  }
  if (!modal) return false;

  const accepted = await clickFirstExisting([
    modal.getByRole('button', { name: /aceptar|confirmar|s[ií]/i }),
    modal.locator('button:has-text("Aceptar"), button:has-text("Sí"), button:has-text("Si"), a:has-text("Aceptar"), a:has-text("Sí"), a:has-text("Si")'),
  ]);
  if (!accepted) return false;
  await modal.waitFor({ state: 'hidden', timeout: TIMEOUT_MS }).catch(() => {});
  return true;
}

async function asignarPerito(page, peritoName) {
  // Si ya hay perito asignado, no hacer nada
  const sinPerito = page.locator('button, a, span').filter({ hasText: /sin perito asignado/i }).first();
  if (!(await sinPerito.isVisible().catch(() => false))) {
    console.log('ℹ️  Perito ya asignado; se omite reasignación.');
    return;
  }

  // Click en el botón "→ Asignar" del bloque PERITO/S.
  // IMPORTANTE: excluir los enlaces de navegación "Asignar Encargos" del menú superior.
  const asignarClicked = await clickFirstExisting([
    // Botón/enlace cuyo texto es exactamente "Asignar" (o "→ Asignar") — sin "Encargos"
    page.locator('a, button').filter({ hasText: /asignar/i }).filter({ hasNotText: /encargos|autos|diversos/i }),
    // Elementos con onclick que mencionen asignar (los del menú no tienen onclick)
    page.locator('[onclick*="asignar" i]'),
  ]);
  if (!asignarClicked) throw new Error('No se encontró el botón "Asignar" en sección PERITO/S');

  // Dar tiempo a que abra el modal
  await page.waitForTimeout(2000);

  // Detectar el modal con selectores amplios
  const modalCandidates = [
    page.locator('.modal-dialog').filter({ hasText: /asignar perito/i }),
    page.locator('div[role="dialog"]').filter({ hasText: /asignar perito/i }),
    page.locator('.ui-dialog').filter({ hasText: /asignar perito/i }),
    page.locator('.modal-dialog:visible'),
    page.locator('div[role="dialog"]:visible'),
    page.locator('.ui-dialog:visible'),
    page.locator('.modal:visible'),
    page.locator('[class*="modal"]:visible'),
    page.locator('[class*="dialog"]:visible'),
    page.locator('[class*="popup"]:visible'),
    page.locator('[class*="overlay"]:visible'),
  ];

  const modalVisible = await waitAnyVisible(modalCandidates, TIMEOUT_MS);
  if (!modalVisible) {
    await saveDebugSnapshot(page, 'asignar_perito');
    throw new Error('No apareció modal de asignación de perito. Revisa el snapshot en logs/');
  }

  // Tomar el primer modal visible como referencia
  let modal = null;
  for (const loc of modalCandidates) {
    if ((await loc.count()) && (await loc.first().isVisible().catch(() => false))) {
      modal = loc.first();
      break;
    }
  }

  // Localizar la fila del perito y seleccionar su radio
  const peritoRow = modal.locator('tr').filter({ hasText: peritoName }).first();
  await peritoRow.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  const radio = peritoRow.locator('input[type="radio"]').first();
  await radio.click({ force: true });
  await page.waitForTimeout(300);

  // Aceptar
  const aceptarClicked = await clickFirstExisting([
    modal.getByRole('button', { name: /aceptar/i }),
    modal.locator('button:has-text("Aceptar"), a:has-text("Aceptar")'),
    page.getByRole('button', { name: /aceptar/i }),
  ]);
  if (!aceptarClicked) throw new Error('No se encontró "Aceptar" en modal de asignación de perito');
  await modal.waitFor({ state: 'hidden', timeout: TIMEOUT_MS }).catch(() => {});
  console.log(`👷 Perito "${peritoName}" asignado correctamente`);
}

async function addAnotacionEncargo(page, text) {
  if (!text) return;
  const truncated = text.slice(0, 128);

  const candidates = [
    page.locator('xpath=//*[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00c1\u00c9\u00cd\u00d3\u00da\u00d1", "abcdefghijklmnopqrstuvwxyz\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1"), "anotaci") and contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00c1\u00c9\u00cd\u00d3\u00da\u00d1", "abcdefghijklmnopqrstuvwxyz\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1"), "encargo")]/following::*[(self::input or self::textarea) and not(@type="hidden")][1]'),
    page.locator('input[name*="anotacion" i], input[id*="anotacion" i], textarea[name*="anotacion" i], textarea[id*="anotacion" i]'),
  ];

  for (const candidate of candidates) {
    if (!(await candidate.count())) continue;
    const el = candidate.first();
    if (!(await el.isVisible().catch(() => false))) continue;

    const isObservacionesSiniestro = await el.evaluate((node) => {
      const container = node.closest('tr, td, .row, .form-group, .control-group, div') || node.parentElement;
      const textAround = String(container?.innerText || '').toLowerCase();
      return textAround.includes('observaciones del siniestro') && !textAround.includes('anotaci');
    }).catch(() => false);
    if (isObservacionesSiniestro) continue;

    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click({ force: true });
    await fillEditorElement(el, truncated);
    await el.evaluate((node) => {
      node.dispatchEvent(new Event('blur', { bubbles: true }));
    }).catch(() => {});
    await page.waitForTimeout(300);
    console.log(`📝 Anotación encargo escrita: "${truncated}"`);
    return;
  }

  console.warn('⚠️  No se encontró el campo "Anotación Encargo 01" — se omite anotación');
}

async function desasignarPerito(page, peritoName) {
  // Verificar que el perito esté asignado
  if (!(await isPeritoAssigned(page, peritoName))) {
    console.log('ℹ️  Ya sin perito asignado; se omite desasignación.');
    return;
  }

  // Paso 1-2: ir a PERITO/S y hacer hover sobre el nombre para que aparezca la X.
  const peritoLower = String(peritoName || '').trim().toLowerCase();
  const cssEscaped = String(peritoName || '').replace(/["\\]/g, '\\$&');
  const hoverTargets = [
    page.locator(`input[readonly][value*="${cssEscaped}" i], input.perito[value*="${cssEscaped}" i]`),
    page.locator('input[readonly][value*="peritovirtual" i], input.perito[value*="peritovirtual" i]'),
    page.locator(`xpath=//*[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZÁÉÍÓÚÑ", "abcdefghijklmnopqrstuvwxyzáéíóúñ"), "${peritoLower}")]`),
    page.locator('xpath=//*[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZÁÉÍÓÚÑ", "abcdefghijklmnopqrstuvwxyzáéíóúñ"), "peritovirtual")]'),
  ];
  for (const target of hoverTargets) {
    const total = await target.count();
    const limit = Math.min(total, 6);
    for (let i = 0; i < limit; i++) {
      const el = target.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.hover({ force: true }).catch(() => {});
      // Algunas vistas muestran la opción de borrar en menú contextual.
      await el.click({ button: 'right', force: true }).catch(() => {});
      await page.waitForTimeout(200);
      break;
    }
  }

  // Paso 3: clicar la X de desasignar (menú flotante/popover) o fallback clásico.
  const peritoSection = page.locator(
    'xpath=//*[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ/ÁÉÍÓÚÑ", "abcdefghijklmnopqrstuvwxyz/áéíóúñ"), "perito/s")]/ancestor::*[self::td or self::div][1]'
  ).first();
  const removeCandidates = [
    page.locator('ul.context-menu-list:visible li.context-menu-item:has(i.fa-times), ul.context-menu-list:visible li:has(i.fa-times)'),
    page.locator('ul.context-menu-list:visible li.context-menu-item').filter({ hasText: new RegExp(`${escapeRegExp(peritoName)}|peritovirtual`, 'i') }),
    page.locator('.popover:visible a:has-text("×"), .popover:visible button:has-text("×"), .tooltip:visible a:has-text("×"), .tooltip:visible button:has-text("×"), .ui-tooltip:visible a:has-text("×"), .ui-tooltip:visible button:has-text("×")'),
    page.locator('.popover:visible a:has(i.fa-times), .popover:visible button:has(i.fa-times), .tooltip:visible a:has(i.fa-times), .tooltip:visible button:has(i.fa-times)'),
    peritoSection.locator('a:has-text("×"), button:has-text("×"), a:has(i.fa-times), button:has(i.fa-times), .btn-danger, .btn-warning'),
    page.locator('[onclick*="encargo_perito" i], [onclick*="borrar_perito" i], [onclick*="eliminar_perito" i]'),
    page.locator(`tr:has-text("${peritoName}")`).locator('button, a').filter({ hasText: /quitar|eliminar|borrar|remove/i }),
    page.locator(`tr:has-text("${peritoName}")`).locator('[onclick*="quitar" i], [onclick*="eliminar" i], [onclick*="remove" i]'),
    page.locator(`tr:has-text("${peritoName}")`).locator('button:has(i.fa-minus), button:has(i.fa-times), button:has(i.fa-trash)'),
    page.locator(`tr:has-text("${peritoName}")`).locator('a:has(i.fa-minus), a:has(i.fa-times), a:has(i.fa-trash)'),
    page.locator(`tr:has-text("${peritoName}")`).locator('.btn-danger, .btn-warning'),
    page.locator('[onclick*="quitar_perito" i], [onclick*="eliminar_perito" i], [onclick*="remove_perito" i]'),
    page.locator('button:has-text("Quitar"), a:has-text("Quitar"), button:has-text("Eliminar"), a:has-text("Eliminar")'),
  ];

  let clicked = await clickFirstExisting(removeCandidates);

  // Fallback A: ejecutar JS inline de borrado aunque el elemento esté oculto.
  if (!clicked) {
    clicked = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('[onclick]'));
      const target = all.find((el) => {
        const s = String(el.getAttribute('onclick') || '').toLowerCase();
        return (s.includes('encargo_perito') && s.includes('delete')) || s.includes('borrar_perito') || s.includes('eliminar_perito');
      });
      if (!target) return false;
      const js = String(target.getAttribute('onclick') || '');
      if (js) {
        try {
          // Ejecutar el código inline evita depender de hover/visibility.
          // eslint-disable-next-line no-new-func
          new Function(js).call(target);
          return true;
        } catch (_) {}
      }
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    }).catch(() => false);
  }

  // Fallback B: click JS sobre item del context-menu (si quedó abierto).
  if (!clicked) {
    clicked = await page.evaluate((name) => {
      const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
      const targetName = norm(name);
      const items = Array.from(document.querySelectorAll('ul.context-menu-list li.context-menu-item'));
      const visibleItems = items.filter((it) => {
        const style = window.getComputedStyle(it);
        return style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      });
      const best = visibleItems.find((it) => {
        const txt = norm(it.textContent || '');
        return txt.includes(targetName) || txt.includes('peritovirtual') || txt.includes('eliminar') || txt.includes('quitar');
      }) || visibleItems.find((it) => {
        const icon = it.querySelector('i.fa-times, i.far.fa-trash, i.fa-trash');
        return Boolean(icon);
      });
      if (!best) return false;
      best.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      best.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      best.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    }).catch(() => false);
  }

  // Fallback C: invocar función nativa de PeritoLine para borrar perito.
  if (!clicked) {
    clicked = await page.evaluate((name) => {
      const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
      const targetName = norm(name);
      const asNum = (v) => {
        const n = Number(String(v || '').replace(/[^\d]/g, ''));
        return Number.isFinite(n) && n > 0 ? n : 0;
      };

      if (typeof window.encargo_perito !== 'function') return false;

      // 1) Reutilizar onclick ya construido por la propia vista, si existe.
      const withOnclick = Array.from(document.querySelectorAll('[onclick]')).find((el) => {
        const s = String(el.getAttribute('onclick') || '').toLowerCase();
        return s.includes('encargo_perito') && s.includes('delete');
      });
      if (withOnclick) {
        try {
          // eslint-disable-next-line no-new-func
          new Function(String(withOnclick.getAttribute('onclick') || '')).call(withOnclick);
          return true;
        } catch (_) {}
      }

      // 2) Construcción manual de parámetros mínimos.
      let idEncargo = 0;
      const idEncCandidates = [
        ...Array.from(document.querySelectorAll('[name*="id_encargo" i], [id*="id_encargo" i], [data-idenc], [id^="td-idenc-"]')).map((el) => {
          const raw = el.getAttribute('data-idenc')
            || el.getAttribute('data-id-encargo')
            || el.getAttribute('value')
            || el.getAttribute('id')
            || el.textContent
            || '';
          return asNum(raw);
        }),
      ].filter(Boolean);
      if (idEncCandidates.length) idEncargo = idEncCandidates[0];

      let idPerito = '';
      const peritoInput = Array.from(document.querySelectorAll('input[readonly], input.perito')).find((el) => {
        const t = norm(el.value || el.textContent || '');
        return t.includes(targetName) || t.includes('peritovirtual');
      });
      if (peritoInput) idPerito = String(peritoInput.getAttribute('data-value') || '').trim();
      if (!idPerito) {
        const selectOpt = Array.from(document.querySelectorAll('select option:checked, select option[selected]')).find((opt) => {
          const t = norm(opt.textContent || '');
          return t.includes(targetName) || t.includes('peritovirtual');
        });
        if (selectOpt) idPerito = String(selectOpt.getAttribute('value') || '').trim();
      }

      let numEncargo = 1;
      try {
        const u = new URL(window.location.href);
        const tabE = u.searchParams.get('tab_e') || '';
        const m = tabE.match(/e(\d+)/i);
        if (m) numEncargo = Number(m[1]) || 1;
      } catch (_) {}

      const refFromDom = (() => {
        const txt = document.body?.innerText || '';
        const m = txt.match(/ref[:\s]+([a-z0-9\-_/]+)/i);
        return m ? m[1] : '';
      })();

      if (!idEncargo || !idPerito) return false;

      try {
        window.encargo_perito('delete', idEncargo, refFromDom || '', numEncargo || 1, 1, idPerito, 'siniestro');
        return true;
      } catch (_) {}
      try {
        window.encargo_perito('delete', idEncargo, refFromDom || '', numEncargo || 1, 1, idPerito, '');
        return true;
      } catch (_) {}
      return false;
    }, peritoName).catch(() => false);
  }

  if (clicked) {
    await page.waitForTimeout(500);
    await confirmDeletePeritoModal(page);
  }

  // Fallback B: si sigue asignado, forzar cambio a "*** Sin perito" en selects con onchange.
  if (await isPeritoAssigned(page, peritoName)) {
    const clearedBySelect = await page.evaluate((name) => {
      const normalize = (s) => String(s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
      const target = normalize(name);
      const selects = Array.from(document.querySelectorAll('select'));
      for (const sel of selects) {
        const marker = `${sel.id || ''} ${sel.name || ''} ${sel.className || ''}`.toLowerCase();
        if (!/perito|prs_/.test(marker)) continue;

        const selected = sel.options[sel.selectedIndex];
        const selectedText = normalize(selected?.textContent || '');
        const selectedValue = normalize(sel.value);
        const selectedMatches = selectedText.includes(target)
          || selectedText.includes('peritovirtual')
          || selectedValue.includes('peritvirtual')
          || selectedValue.includes('peritovirtual');
        if (!selectedMatches) continue;

        const emptyOpt = Array.from(sel.options).find((opt) => {
          const txt = normalize(opt.textContent || '');
          return !String(opt.value || '').trim() || txt.includes('sin perito');
        });
        if (!emptyOpt) continue;

        sel.value = emptyOpt.value;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        sel.dispatchEvent(new Event('blur', { bubbles: true }));
        return { ok: true, id: sel.id || '', name: sel.name || '' };
      }
      return { ok: false };
    }, peritoName).catch(() => ({ ok: false }));

    if (clearedBySelect.ok) {
      await page.waitForTimeout(700);
      await confirmDeletePeritoModal(page);
    }
  }

  if (await isPeritoAssigned(page, peritoName)) {
    await saveDebugSnapshot(page, 'desasignar_perito');
    throw new Error(`No se pudo desasignar el perito "${peritoName}"`);
  }

  console.log(`🗑️  Perito "${peritoName}" desasignado`);
}

async function processTask(page, task) {
  const shouldFail = task.contacto === 'no' || task.contacto === 'no_encontrado' || task.contacto === 'error';
  const doPerito = task.contacto === 'si' && VIRTUAL_PERITO_NAME;

  // 1. Abrir el encargo
  await openByEncargo(page, task.encargo);

  // 2. Asignar perito virtual — PRIMER paso tras abrir el encargo
  if (doPerito) {
    await asignarPerito(page, VIRTUAL_PERITO_NAME);
    await openByEncargo(page, task.encargo);
  }

  // 3. Marcar contacto (siempre: tanto en primera respuesta como al cierre)
  try {
    const modal = await openContactoModal(page, { allowMissing: !shouldFail });
    if (modal) {
      await setContactoFallido(modal, shouldFail);
      await acceptModal(modal);
    }
  } catch (err) {
    console.warn(`⚠️  Modal contacto omitido (probablemente ya marcado): ${err.message}`);
  }

  // 4. Observaciones especiales: siempre actualizar con el estado más reciente del Excel.
  await openByEncargo(page, task.encargo);
  await addObservacionesEspeciales(page, task.observacionesEspeciales);

  // 5-7. Solo al cierre de conversación (datos ya completos)
  if (task.finalSync) {
    try {
      // PeritoLine puede redirigir al dashboard al guardar — reabrimos el encargo
      await openByEncargo(page, task.encargo);
      // Anotación del encargo (tipo de cita o motivo de cierre)
      await addAnotacionEncargo(page, task.anotacion);
      // Subir PDF de transcripción
      await uploadPdfToEncargo(page, task.encargo);
    } finally {
      // Desasignar perito virtual — dejar el encargo sin asignación
      if (VIRTUAL_PERITO_NAME) {
        await openByEncargo(page, task.encargo);
        await desasignarPerito(page, VIRTUAL_PERITO_NAME);
      }
    }
  }
}

async function main() {
  if (!LOGIN_URL || !USERNAME || !PASSWORD) {
    throw new Error('Faltan LOGIN_URL / USERNAME / PASSWORD en .env');
  }

  // ── Modo assign-only: solo asignar perito virtual, sin leer Contacto del Excel ──
  if (CLI.assignOnly) {
    if (!CLI.encargo) throw new Error('--assign-only requiere --encargo');
    if (!VIRTUAL_PERITO_NAME) {
      console.log('ℹ️  PERITOLINE_VIRTUAL_PERITO_NAME no configurado — se omite asignación.');
      return;
    }
    if (DRY_RUN) {
      console.log(`🔵 DRY_RUN: asignaría "${VIRTUAL_PERITO_NAME}" en encargo ${CLI.encargo}`);
      return;
    }
    const browser = await chromium.launch({ headless: HEADLESS, slowMo: SLOW_MO, args: LAUNCH_ARGS, chromiumSandbox: false });
    const context = await browser.newContext({ viewport: { width: 1700, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);
    try {
      await login(page);
      await openByEncargo(page, CLI.encargo);
      await asignarPerito(page, VIRTUAL_PERITO_NAME);
      console.log(`✅ Perito asignado en encargo ${CLI.encargo}`);
    } finally {
      await context.close();
      await browser.close();
    }
    return;
  }

  // ── Flujo normal: leer Excel, procesar tareas ─────────────────────────────────
  const tasks = readTasksFromExcel(EXCEL_PATH, { encargo: CLI.encargo, anotacion: CLI.anotacion, finalSync: CLI.finalSync });
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

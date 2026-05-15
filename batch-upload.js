const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { parse } = require('csv-parse/sync');

const PROFILE_DIR = path.join(__dirname, 'browser-profile');
const LOG_PATH = path.join(__dirname, 'upload.log');
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const RESULTS_PATH = path.join(__dirname, 'results.csv');
const MAX_RETRIES = 2;

const PLATFORM = {
  maxFileSize: 20 * 1024 * 1024 * 1024,
  maxDuration: 8 * 3600,
  minDuration: 5,
  allowedCodec: 'h264',
  maxBitrate: 10 * 1000 * 1000,
  allowedFormats: ['.mp4'],
  titleMinLen: 6,
};

// ── Logger ──
function ts() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}
const logger = {
  _write(level, msg) {
    const line = `[${ts()}] [${level}] ${msg}`;
    console.log(line);
    try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
  },
  info(msg) { this._write('INFO', msg); },
  warn(msg) { this._write('WARN', msg); },
  error(msg) { this._write('ERROR', msg); },
};

// ── Desktop notification ──
function notifyUser(title, message) {
  try {
    const s = message.replace(/'/g, "''").replace(/"/g, '``');
    execSync(
      `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${s}', '${title.replace(/'/g, "''")}')"`,
      { timeout: 10000 }
    );
  } catch {}
}

// ── CSV ──
function csvEscape(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function writeResults(results, resultsPath) {
  const rp = resultsPath || RESULTS_PATH;
  const header = 'video_path,title,status,error';
  const rows = [header];
  for (const r of results) {
    rows.push([csvEscape(r.video_path), csvEscape(r.title), csvEscape(r.status), csvEscape(r.error)].join(','));
  }
  fs.writeFileSync(rp, '﻿' + rows.join('\n'), 'utf-8');
}

function loadPublishedTitles(resultsPath, resume) {
  const set = new Set();
  if (!resume || !fs.existsSync(resultsPath)) return set;
  const text = fs.readFileSync(resultsPath, 'utf-8');
  for (const line of text.split('\n').slice(1)) {
    if (!line.trim()) continue;
    try {
      const p = parse(line, { columns: ['vp', 't', 'st', 'err'], skip_empty_lines: true, relax_column_count: true });
      if (p.length > 0 && p[0].st === 'published' && p[0].t && p[0].t.trim()) set.add(p[0].t);
    } catch {}
  }
  return set;
}

// ── ffprobe ──
function probeVideo(filePath) {
  try {
    const out = execSync(
      `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath.replace(/"/g, '\\"')}"`,
      { timeout: 15000, encoding: 'utf-8' }
    );
    const data = JSON.parse(out);
    const vs = (data.streams || []).find(s => s.codec_type === 'video');
    const fmt = data.format || {};
    return {
      duration: parseFloat(fmt.duration || 0),
      size: parseInt(fmt.size || 0),
      codec: vs ? vs.codec_name : 'unknown',
      bitrate: parseInt(fmt.bit_rate || 0),
      width: vs ? vs.width : 0,
      height: vs ? vs.height : 0,
    };
  } catch (e) {
    logger.warn(`  ffprobe failed for ${path.basename(filePath)}: ${e.message}`);
    return null;
  }
}

// ── Validation ──
function loadCSV(csvPath) {
  if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);
  return parse(fs.readFileSync(csvPath, 'utf-8'), {
    columns: true, skip_empty_lines: true, relax_column_count: true, bom: true,
  });
}

function validateTitle(title) {
  if (!title) return null; // optional
  const allowed = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 《》（）《》“”‘’：，。！？、；；,.!?:;+-_%℃ ');
  for (const ch of title) {
    if (!allowed.has(ch) && !(ch >= '一' && ch <= '鿿')) return `Unsupported char "${ch}"`;
  }
  if (title.length < 6) return `Title too short (${title.length}), min 6`;
  return null;
}

function preflightRecords(records) {
  const valid = [];
  for (const r of records) {
    const errs = [];
    if (!r.video_path || !r.video_path.trim()) {
      errs.push('Missing video_path');
    } else {
      const vp = r.video_path.trim();
      if (!fs.existsSync(vp)) {
        errs.push(`File not found: ${vp}`);
      } else {
        const stat = fs.statSync(vp);
        if (stat.size > PLATFORM.maxFileSize) errs.push(`File too large (${(stat.size / 1024 / 1024 / 1024).toFixed(1)} GB)`);
        const ext = path.extname(vp).toLowerCase();
        if (!PLATFORM.allowedFormats.includes(ext)) logger.warn(`  [Preflight] ${r.title}: format ${ext} not recommended`);
        const info = probeVideo(vp);
        if (info) {
          if (info.duration > PLATFORM.maxDuration) errs.push(`Video too long (${(info.duration / 3600).toFixed(1)}h)`);
          if (info.codec !== PLATFORM.allowedCodec && info.codec !== 'unknown') logger.warn(`  [Preflight] ${r.title}: codec ${info.codec}`);
          if (info.bitrate > PLATFORM.maxBitrate) logger.warn(`  [Preflight] ${r.title || r.description || path.basename(r.video_path)}: bitrate ${(info.bitrate / 1000 / 1000).toFixed(1)} Mbps`);
        }
      }
    }
    if (!r.title || !r.title.trim()) {
      // title is optional
    } else {
      const ve = validateTitle(r.title.trim());
      if (ve) errs.push(ve);
    }
    if (errs.length > 0) {
      r._skip = true;
      r._skipReason = errs.join('; ');
      logger.warn(`  [Preflight] ${r.title || r.description || r.video_path || 'row'} skipped: ${r._skipReason}`);
    }
    valid.push(r._skip ? r : r); // keep all, just mark skipped
  }
  return records; // return all with _skip flags
}

// ── Error classification ──
function classifyError(msg) {
  if (!msg) return 'fatal';
  if (['login', 'Login', 'Not logged in', '登录'].some(k => msg.includes(k))) return 'login-expired';
  if (['title', 'Title'].some(k => msg.includes(k))) return 'title-error';
  if (['timeout', 'Timeout', 'net::ERR_', 'ETIMEDOUT', 'ECONNRESET', 'NS_ERROR_', 'CONNECTION', 'INTERNET_'].some(k => msg.includes(k))) return 'retryable';
  return 'fatal';
}

function isLogin(url) { return url.includes('login'); }

// ── Browser helpers ──
function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    path.join(__dirname, 'runtime', 'chrome', 'chrome.exe'),
    path.join(__dirname, 'chrome', 'chrome.exe'),
    path.join(__dirname, 'chrome-win64', 'chrome.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LocalAppData && path.join(process.env.LocalAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p));
}

async function initBrowser(profileDir) {
  fs.mkdirSync(profileDir, { recursive: true });
  const chromePath = findChromeExecutable();
  const launchOptions = {
    headless: false,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    args: ['--no-first-run', '--no-default-browser-check', '--mute-audio'],
  };
  if (chromePath) {
    logger.info(`Using Chrome: ${chromePath}`);
    launchOptions.executablePath = chromePath;
  } else {
    logger.warn('Chrome executable not found, trying Playwright channel chrome');
    launchOptions.channel = 'chrome';
  }

  try {
    return await chromium.launchPersistentContext(profileDir, launchOptions);
  } catch (e) {
    logger.error(`Browser launch failed: ${e.message}`);
    if (e.stack) logger.error(e.stack);
    throw e;
  }
}

async function getMainPage(browserContext) {
  const page = browserContext.pages().find(p => !p.isClosed());
  return page || await browserContext.newPage();
}

async function checkLoginState(browserContext, options = {}) {
  const timeout = options.timeout || 12000;
  const page = await getMainPage(browserContext);
  if (options.navigate !== false) {
    await page.goto('https://channels.weixin.qq.com/platform/post/create', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
  }

  if (isLogin(page.url())) {
    return { loggedIn: false, url: page.url(), reason: 'login-url' };
  }

  const uploadInput = page.locator('input[type=file]').first();
  const hasUploadInput = await uploadInput.waitFor({ state: 'attached', timeout }).then(() => true).catch(() => false);
  if (hasUploadInput && !isLogin(page.url())) {
    return { loggedIn: true, url: page.url(), reason: 'upload-page' };
  }

  const bodyText = await page.textContent('body').catch(() => '');
  if (/login|登录|扫码|二维码|微信/.test(bodyText) || isLogin(page.url())) {
    return { loggedIn: false, url: page.url(), reason: 'login-required' };
  }

  return { loggedIn: false, url: page.url(), reason: 'upload-page-not-ready' };
}

async function unlockProfile(profileDir) {
  const lockFile = path.join(profileDir, 'SingletonLock');
  if (fs.existsSync(lockFile)) {
    logger.warn('Profile locked — killing Chrome...');
    try {
      execSync('taskkill /F /IM chrome.exe', { stdio: 'ignore' });
      const t0 = Date.now();
      while (Date.now() - t0 < 2000) {}
      logger.info('Profile unlocked');
    } catch { logger.warn('Could not kill Chrome'); }
  }
}

async function loginFlow(browserContext) {
  const page = await getMainPage(browserContext);
  await page.goto('https://channels.weixin.qq.com/', { waitUntil: 'domcontentloaded' });
  logger.info('=== Scan QR code to login, then press Enter ===');
  await new Promise(r => process.stdin.once('data', r));
  logger.info('Login saved');
}

// ── Upload helpers ──
async function waitForUploadWithProgress(page) {
  const startTime = Date.now();
  while (Date.now() - startTime < 300000) {
    if (await page.locator('.ant-slider').count().catch(() => 0) > 0) {
      logger.info(`  Upload complete (${Math.round((Date.now() - startTime) / 1000)}s)`);
      return;
    }
    logger.info(`  Uploading... ${Math.round((Date.now() - startTime) / 1000)}s`);
    await page.waitForTimeout(15000);
  }
  logger.warn('  Upload timeout (300s), continuing');
}

async function selectShortDrama(page, dramaName) {
  logger.info(`  Selecting drama: ${dramaName}`);
  try {
    const base = page.locator('.link-selector').getByText('选择链接').or(page.getByText('选择链接', { exact: true }));
    await base.first().click();
    await page.getByText('视频号剧集', { exact: true }).waitFor({ state: 'visible', timeout: 5000 });
    await page.getByText('视频号剧集', { exact: true }).click();
    await page.getByText('选择需要添加的视频号剧集').waitFor({ state: 'visible', timeout: 5000 });
    await page.getByText('选择需要添加的视频号剧集').click();
    const sb = page.getByRole('textbox', { name: '搜索内容' });
    await sb.waitFor({ state: 'visible', timeout: 5000 });
    await sb.fill(dramaName);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    for (const loc of [
      page.locator('table tbody tr').first(), page.getByRole('row').nth(1),
    ]) {
      try { if (await loc.count() > 0) { await loc.click({ timeout: 3000 }); logger.info(`  Selected drama: ${dramaName}`); return; } } catch {}
    }
    logger.warn(`  Drama "${dramaName}" not found`);
    await page.keyboard.press('Escape');
  } catch (e) { logger.warn(`  Drama failed: ${e.message}`); }
}

async function clickFirstVisible(candidates, timeout = 5000) {
  let lastError = null;
  for (const loc of candidates) {
    try {
      await loc.first().waitFor({ state: 'visible', timeout });
      await loc.first().click();
      return true;
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError) throw lastError;
  throw new Error('No clickable candidates');
}

async function selectShoppingCartProduct(page, productName) {
  const name = productName.trim();
  logger.info(`  Selecting product: ${name}`);

  await clickFirstVisible([
    page.locator('.link-selector').getByText('选择链接'),
    page.getByText('选择链接', { exact: true }),
    page.locator('div,button').filter({ hasText: /^选择链接$/ }),
  ]);

  await clickFirstVisible([
    page.getByText('商品', { exact: true }),
    page.locator('[role="option"]').filter({ hasText: '商品' }),
    page.locator('li,div').filter({ hasText: /^商品$/ }),
  ]);

  await clickFirstVisible([
    page.getByText('选择需要添加的商品', { exact: true }),
    page.locator('div,button').filter({ hasText: '选择需要添加的商品' }),
  ], 8000);

  const productDialog = page
    .locator('[role="dialog"], .weui-desktop-dialog, .ant-modal, .modal, body')
    .filter({ hasText: /从橱窗添加商品|商品链接导入|去选品中心添加/ })
    .last();
  await productDialog.waitFor({ state: 'visible', timeout: 10000 });

  const searchBox = productDialog.locator('input[placeholder*="商品名称"], input[placeholder*="编码"]').first();
  await searchBox.waitFor({ state: 'visible', timeout: 10000 });
  await searchBox.fill(name);

  await clickFirstVisible([
    productDialog.getByRole('button', { name: '筛选' }),
    productDialog.getByText('筛选', { exact: true }),
  ]);

  await page.waitForTimeout(1500);
  const productRows = productDialog
    .locator('table tbody tr, [role="row"], .ant-table-row')
    .filter({ hasText: /ID\s*\d+|￥|¥/ });
  let productRow = productRows.filter({ hasText: name }).first();
  if (await productRow.count().catch(() => 0) === 0) productRow = productRows.first();
  await productRow.waitFor({ state: 'visible', timeout: 15000 });

  const radio = productRow.locator('input[type="radio"], [role="radio"], .ant-radio, .weui-check, .radio').first();
  if (await radio.count().catch(() => 0)) {
    await radio.click({ force: true });
  } else {
    await productRow.click();
  }

  await clickFirstVisible([
    productDialog.locator('button').filter({ hasText: /^添加\(\d+\)$/ }),
    productDialog.getByRole('button', { name: /^添加\(\d+\)$/ }),
    productDialog.locator('button').filter({ hasText: /^添加$/ }),
  ], 8000);

  await productDialog.waitFor({ state: 'hidden', timeout: 10000 }).catch(async () => {
    logger.warn('  Product dialog still visible after add, closing with Escape');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  });
  logger.info(`  Product selected: ${name}`);
  await handleProductTimingDialog(page);
}

async function setCover(page, coverPath) {
  logger.info(`  Setting cover`);
  if (!fs.existsSync(coverPath)) { logger.warn(`  Cover not found: ${coverPath}`); return; }
  try {
    await page.getByText('编辑', { exact: true }).click({ force: true });
    await page.getByRole('heading', { name: '编辑封面' }).waitFor({ state: 'visible', timeout: 5000 });
    await page.getByText('上传封面', { exact: true }).click();
    await page.locator('input[type=file]').nth(1).setInputFiles(coverPath);
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: '确认' }).click();
    logger.info('  Cover set');
  } catch (e) { logger.warn(`  Cover failed: ${e.message}`); }
}

async function hideLocation(page) {
  logger.info('  Hiding location');
  try {
    if (await page.getByText('不显示位置').first().isVisible().catch(() => false)) return;
    await page.locator('.location-name').first().click();
    await page.waitForTimeout(300);
    await page.getByText('不显示位置', { exact: true }).click();
  } catch (e) { logger.warn(`  Location failed: ${e.message}`); }
}

async function verifyPublish(page) {
  await page.waitForTimeout(2000);
  try { await page.waitForURL(u => !u.href.includes('/post/create'), { timeout: 15000 }); return true; } catch {}
  try { await page.waitForSelector('text=/已发表|发表成功|success/i', { timeout: 8000 }); return true; } catch {}
  try { await page.waitForSelector('[class*="success"]', { timeout: 5000 }); return true; } catch {}
  return false;
}

async function handleOriginalDeclarationDialog(page) {
  await handleProductTimingDialog(page);
  const hasDialog = await page.getByText(/声明原创的视频有机会获得广告分成|原创权益/).first().isVisible({ timeout: 3000 }).catch(() => false);
  if (!hasDialog) return false;

  try {
    logger.info('  Handling original declaration dialog');
    const dialog = page
      .locator('.weui-desktop-dialog__wrp, .weui-desktop-dialog, .ant-modal, [role="dialog"]')
      .filter({ visible: true })
      .last();
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    const checkbox = dialog
      .locator('.ant-checkbox, input[type="checkbox"], [role="checkbox"], [class*="checkbox"], [class*="weui-check"]')
      .filter({ visible: true })
      .first();
    await checkbox.click({ force: true, timeout: 5000 });
    logger.info('  Agreement checkbox clicked');
    await page.waitForTimeout(300);

    const confirm = dialog
      .locator('button:not(.weui-desktop-btn_disabled), .weui-desktop-btn_primary:not(.weui-desktop-btn_disabled), [role="button"]:not(.weui-desktop-btn_disabled)')
      .filter({ visible: true })
      .last();
    await confirm.click({ force: true, timeout: 5000 });
    logger.info('  Original dialog confirm clicked');
    return true;
  } catch (e) {
    logger.warn(`  Original dialog skipped: ${e.message}`);
    return false;
  }
}

async function enableOriginalDeclaration(page) {
  logger.info('  Enabling original declaration');
  const hint = page.getByText(/声明后，作品将展示原创标记|有机会获得广告收入/).first();
  const hasHint = await hint.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
  if (!hasHint) {
    logger.warn('  Original declaration box not found, skipping');
    return false;
  }
  const clicked = await hint.evaluate((el) => {
    function isCheckbox(node) {
      if (!node || node.nodeType !== 1) return false;
      const cls = String(node.className || '');
      return node.matches?.('input[type="checkbox"], [role="checkbox"]') ||
        /checkbox|check|weui-check|ant-checkbox/.test(cls);
    }
    function clickNode(node) {
      node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
      node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }

    const textRect = el.getBoundingClientRect();
    let scope = el;
    for (let i = 0; i < 8 && scope.parentElement; i++) {
      scope = scope.parentElement;
      const candidates = [...scope.querySelectorAll('input[type="checkbox"], [role="checkbox"], [class*="checkbox"], [class*="weui-check"], [class*="ant-checkbox"]')];
      const leftCandidates = candidates
        .map(node => ({ node, rect: node.getBoundingClientRect() }))
        .filter(item => item.rect.width >= 0 && item.rect.height >= 0 && item.rect.left < textRect.left && item.rect.top < textRect.bottom && item.rect.bottom > textRect.top)
        .sort((a, b) => Math.abs(a.rect.right - textRect.left) - Math.abs(b.rect.right - textRect.left));
      const target = leftCandidates[0]?.node || candidates.find(isCheckbox);
      if (target) {
        clickNode(target);
        return {
          ok: true,
          tag: target.tagName,
          className: String(target.className || ''),
          scope: scope.tagName,
        };
      }
    }
    return { ok: false, text: el.textContent };
  });
  logger.info(`  Original checkbox DOM click: ${JSON.stringify(clicked)}`);
  if (!clicked || !clicked.ok) {
    logger.warn('  Original checkbox not found near declaration text, skipping');
    return false;
  }
  await page.waitForTimeout(500);
  return true;
}

async function clearBlockingProductDialog(page) {
  const blocking = page
    .locator('.weui-desktop-dialog__wrp, [role="dialog"], .ant-modal')
    .filter({ hasText: /从橱窗添加商品|商品链接导入|去选品中心添加|选择需要添加的商品/ })
    .last();
  if (!await blocking.isVisible({ timeout: 1000 }).catch(() => false)) return;
  logger.warn('  Closing leftover product dialog');
  await page.keyboard.press('Escape');
  await blocking.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
}

async function handleProductTimingDialog(page) {
  const marker = page.getByText(/选择商品出现时机|商品出现时机|视频播放5秒后出现|自定义出现时机/).first();
  if (!await marker.isVisible({ timeout: 1500 }).catch(() => false)) return false;

  try {
    logger.info('  Handling product timing dialog');
    const dialog = page
      .locator('.sale-visible-dialog, .weui-desktop-dialog__wrp, .weui-desktop-dialog, .ant-modal, [role="dialog"]')
      .filter({ hasText: /选择商品出现时机|商品出现时机|视频播放5秒后出现|自定义出现时机/ })
      .last();
    const visibleConfirm = dialog
      .locator('button, .weui-desktop-btn_primary, .ant-btn-primary, [role="button"]')
      .filter({ hasText: /^确认$/ })
      .filter({ visible: true })
      .last();
    if (!await visibleConfirm.isVisible({ timeout: 1000 }).catch(() => false)) {
      logger.info('  Product timing dialog already closed');
      return false;
    }
    await clickFirstVisible([
      visibleConfirm,
    ], 5000);
    await dialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    logger.info('  Product timing confirmed');
    return true;
  } catch (e) {
    logger.warn(`  Product timing dialog skipped: ${e.message}`);
    return false;
  }
}

async function processVideo(browserContext, record) {
  const page = await getMainPage(browserContext);
  const result = { video_path: record.video_path, title: record.title, status: 'unknown', error: '', _errorType: 'fatal', _loginExpired: false };

  try {
    logger.info(`\n=== ${record.title || record.description || path.basename(record.video_path)} ===`);
    await page.goto('https://channels.weixin.qq.com/platform/post/create', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForSelector('input[type=file]', { state: 'attached', timeout: 15000 });
    if (isLogin(page.url())) { result.status = 'failed'; result.error = 'Not logged in'; result._loginExpired = true; return result; }

    logger.info(`  Upload: ${record.video_path}`);
    if (!fs.existsSync(record.video_path)) throw new Error(`File not found: ${record.video_path}`);
    await page.locator('input[type=file]').first().setInputFiles(record.video_path);
    await waitForUploadWithProgress(page);
    await page.waitForTimeout(5000);
    if (isLogin(page.url())) { result.status = 'failed'; result.error = 'Login expired during upload'; result._loginExpired = true; return result; }

    if (record.cover_path && record.cover_path.trim()) await setCover(page, record.cover_path.trim());
    await hideLocation(page);
    if (isLogin(page.url())) { result.status = 'failed'; result.error = 'Login expired'; result._loginExpired = true; return result; }

    if (record.title && record.title.trim()) {
      logger.info(`  Title: ${record.title}`);
      await page.getByRole('textbox', { name: /概括视频主要内容/ }).fill(record.title);
    }
    if (record.description) {
      logger.info('  Description');
      const editor = page.locator('.input-editor');
      await editor.click();
      await editor.evaluate(el => { el.textContent = ''; });
      await page.keyboard.type(record.description);
    }
    const productPolicy = String(record.product_policy || 'required').trim().toLowerCase();
    if (productPolicy !== 'none' && record.shopping_cart && record.shopping_cart.trim()) {
      try {
        await selectShoppingCartProduct(page, record.shopping_cart.trim());
      } catch (e) {
        if (productPolicy === 'best_effort') {
          logger.warn(`  Product attach skipped: ${e.message}`);
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(500);
          await clearBlockingProductDialog(page);
        } else {
          throw e;
        }
      }
    } else if (productPolicy === 'none') {
      logger.info('  Product attach disabled by policy');
    }
    if (record.short_drama_name) await selectShortDrama(page, record.short_drama_name);
    await handleProductTimingDialog(page);
    const originalPolicy = String(record.original_policy || 'best_effort').trim().toLowerCase();
    if (originalPolicy !== 'none') {
      try {
        const originalEnabled = await enableOriginalDeclaration(page);
        if (!originalEnabled) throw new Error('Original declaration checkbox not found');
        await handleOriginalDeclarationDialog(page);
      } catch (e) {
        if (originalPolicy === 'required') {
          throw e;
        }
        logger.warn(`  Original declaration skipped: ${e.message}`);
      }
    } else {
      logger.info('  Original declaration disabled by policy');
    }
    await clearBlockingProductDialog(page);
    await handleProductTimingDialog(page);

    logger.info('  Clicking 发表...');
    await page.getByRole('button', { name: '发表' }).click();

    await handleOriginalDeclarationDialog(page);

    if (await verifyPublish(page)) {
      result.status = 'published'; logger.info(`  SUCCESS: ${record.title}`);
    } else {
      if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
      const ss = `${Date.now()}_${(record.title || 'unknown').replace(/[<>:"/\\|?*]/g, '_').slice(0, 50)}.png`;
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, ss), fullPage: false });
      logger.info(`  Screenshot: ${ss}`);
      result.status = 'uncertain';
      result.error = (await page.textContent('body').catch(() => '')).substring(0, 200);
    }
  } catch (e) {
    result.status = 'failed'; result.error = e.message;
    result._errorType = classifyError(e.message);
    logger.error(`  FAILED: ${e.message}`);
  }
  return result;
}

async function waitUntil(targetTime) {
  const diff = targetTime.getTime() - Date.now();
  if (diff > 0) {
    logger.info(`  Waiting ${Math.round(diff / 1000 / 60)} min...`);
    await new Promise(r => setTimeout(r, diff));
  }
}

async function waitBetweenUploads(intervalMinutes, abortSignal, startedAt) {
  const getIntervalMinutes = typeof intervalMinutes === 'function' ? intervalMinutes : () => intervalMinutes;
  intervalMinutes = Math.max(0, Math.min(1440, Number.parseInt(getIntervalMinutes(), 10) || 0));
  if (!intervalMinutes || intervalMinutes <= 0) return;
  const started = startedAt || Date.now();
  let waitMs = intervalMinutes * 60 * 1000;
  const elapsedMs = startedAt ? Math.max(0, Date.now() - startedAt) : 0;
  const remainingMs = Math.max(0, waitMs - elapsedMs);
  if (remainingMs <= 0) {
    logger.info(`  Interval ${intervalMinutes} min already elapsed, starting next upload...`);
    return;
  }
  const waitMinutes = Math.ceil(remainingMs / 1000 / 60);
  logger.info(`  Waiting ${waitMinutes} min before next upload...`);
  while (true) {
    if (abortSignal && (abortSignal.aborted || abortSignal.abort)) return;
    intervalMinutes = Math.max(0, Math.min(1440, Number.parseInt(getIntervalMinutes(), 10) || 0));
    waitMs = intervalMinutes * 60 * 1000;
    const remaining = Math.max(0, waitMs - Math.max(0, Date.now() - started));
    if (remaining <= 0) return;
    await new Promise(r => setTimeout(r, Math.min(1000, remaining)));
  }
}

function handleLoginExpired() {
  logger.error('LOGIN EXPIRED — run node batch-upload.js --setup');
  notifyUser('视频号上传 - 登录过期', '登录态已过期，请重新扫码登录。');
}

// ── Batch process (used by both CLI and server) ──
async function batchUpload(browserContext, records, options = {}) {
  const { resultsPath = RESULTS_PATH, resume = false, results: existingResults = [], abortSignal, onProgress, onPublished, onRecordStart } = options;
  const getIntervalMinutes = typeof options.getIntervalMinutes === 'function'
    ? options.getIntervalMinutes
    : () => options.intervalMinutes;
  const results = existingResults.slice();
  const publishedSet = loadPublishedTitles(resultsPath, resume);
  let loginExpired = false;

  // Close extra tabs
  const pages = browserContext.pages().filter(p => !p.isClosed());
  if (pages.length === 0) await browserContext.newPage();
  for (let i = pages.length - 1; i >= 1; i--) await pages[i].close();

  const total = records.length;
  for (let i = 0; i < records.length; i++) {
    if (abortSignal && (abortSignal.aborted || abortSignal.abort)) {
      logger.warn('Upload aborted by user');
      break;
    }

    const record = records[i];
    if (record._skip) {
      results.push({ video_path: record.video_path, title: record.title, status: 'skipped', error: record._skipReason });
      if (onProgress) onProgress({ current: i + 1, total, status: 'skipped', title: record.title });
      continue;
    }
    if (record.title && publishedSet.has(record.title)) {
      results.push({ video_path: record.video_path, title: record.title, status: 'published', error: '' });
      if (onProgress) onProgress({ current: i + 1, total, status: 'published', title: record.title });
      continue;
    }
    if (loginExpired) {
      results.push({ video_path: record.video_path, title: record.title, status: 'failed', error: 'Login expired' });
      continue;
    }

    const pt = record.publish_time ? new Date(record.publish_time) : null;
    if (pt) await waitUntil(pt);

    const startedAt = Date.now();
    if (typeof onRecordStart === 'function') onRecordStart({ current: i + 1, total, title: record.title, startedAt });

    let result = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (abortSignal && (abortSignal.aborted || abortSignal.abort)) {
        logger.warn('Upload aborted by user');
        break;
      }
      if (attempt > 0) {
        logger.info(`  Retry ${attempt}/${MAX_RETRIES}`);
        await new Promise(r => setTimeout(r, 3000));
        if (abortSignal && (abortSignal.aborted || abortSignal.abort)) {
          logger.warn('Upload aborted by user');
          break;
        }
      }
      result = await processVideo(browserContext, record);
      if (abortSignal && (abortSignal.aborted || abortSignal.abort)) break;
      if (result.status === 'published' || result._errorType === 'login-expired' || result._errorType === 'title-error') break;
    }

    if (!result) break;
    results.push(result);
    if (result._loginExpired) { loginExpired = true; handleLoginExpired(); }
    writeResults(results, resultsPath);
    if (result.status === 'published' && typeof onPublished === 'function') {
      await onPublished(result, record);
    }
    if (onProgress) onProgress({ current: i + 1, total, status: result.status, title: record.title });

    const nextRecord = records[i + 1];
    if (!loginExpired && nextRecord) {
      await waitBetweenUploads(getIntervalMinutes, abortSignal, startedAt);
    }
  }
  return results;
}

// ── CLI entry ──
async function main() {
  const args = process.argv.slice(2);
  const isSetup = args.includes('--setup');
  const csvIdx = args.indexOf('--csv');
  const csvPath = csvIdx >= 0 ? path.resolve(args[csvIdx + 1]) : path.join(__dirname, 'batch-config.csv');
  const resume = args.includes('--resume');

  if (fs.existsSync(LOG_PATH)) fs.unlinkSync(LOG_PATH);
  unlockProfile(PROFILE_DIR);

  logger.info('Opening browser...');
  const browserContext = await initBrowser(PROFILE_DIR);

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down...');
    try { await browserContext.close(); } catch {}
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (isSetup) {
    await loginFlow(browserContext);
    await browserContext.close();
    return;
  }

  let records;
  try {
    records = loadCSV(csvPath);
    logger.info(`Loaded ${records.length} records`);
  } catch (e) {
    logger.error(`CSV: ${e.message}`);
    await browserContext.close(); process.exit(1);
  }

  records = preflightRecords(records);
  const validCount = records.filter(r => !r._skip).length;
  if (validCount === 0) { logger.warn('No valid records'); await browserContext.close(); return; }
  logger.info(`Preflight: ${validCount} valid, ${records.length - validCount} skipped`);

  const results = await batchUpload(browserContext, records, { resume, resultsPath: RESULTS_PATH });

  logger.info(`\nDone. ${results.filter(r => r.status === 'published').length}/${results.length} published`);
  logger.info('Browser left open. Close when done.');
  writeResults(results, RESULTS_PATH);
}

if (require.main === module) {
  main().catch(e => { logger.error(`Fatal: ${e.message}`); process.exit(1); });
}

module.exports = {
  // Constants
  PROFILE_DIR, LOG_PATH, RESULTS_PATH, SCREENSHOTS_DIR, PLATFORM, MAX_RETRIES,
  // Core
  initBrowser, unlockProfile, loginFlow, batchUpload, processVideo, preflightRecords, loadCSV, validateTitle, writeResults, loadPublishedTitles,
  // Helpers
  classifyError, isLogin, waitForUploadWithProgress, selectShortDrama, selectShoppingCartProduct, setCover, hideLocation, verifyPublish,
  handleProductTimingDialog,
  waitUntil, waitBetweenUploads, handleLoginExpired, probeVideo, logger, notifyUser, checkLoginState,
};

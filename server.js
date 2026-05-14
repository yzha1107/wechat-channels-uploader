const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { execFileSync } = require('child_process');
const accounts = require('./accounts');
const {
  initBrowser, unlockProfile, loginFlow, batchUpload,
  preflightRecords, loadCSV, logger, LOG_PATH, RESULTS_PATH,
  checkLoginState, writeResults, waitBetweenUploads,
} = require('./batch-upload');

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const GENERATED_COVERS_DIR = path.join(UPLOADS_DIR, 'covers');
if (!fs.existsSync(GENERATED_COVERS_DIR)) fs.mkdirSync(GENERATED_COVERS_DIR, { recursive: true });
const INSTALLERS_DIR = path.join(__dirname, 'installers');

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const ARK_API_KEY_FILE = path.join(__dirname, 'ark-api-key.txt');
const DOUBAO_MODEL = process.env.ARK_MODEL || 'doubao-seed-2-0-lite-260215';
const DOUBAO_ENDPOINT = process.env.ARK_ENDPOINT || 'https://ark.cn-beijing.volces.com/api/v3/responses';
const TEMPLATE_HEADERS = [
  '视频路径(必填)',
  '视频描述(非必填)',
  '封面路径(非必填)',
  '位置(非必填,填"本地"默认为作者位置)',
  '链接(非必填)',
  '活动(非必填)',
  '原创(非必填)',
  '购物车(非必填)',
  '短标题(非必填)',
  '合集(非必填)',
];
const MAX_SHORT_TITLE_LEN = Number.parseInt(process.env.MAX_SHORT_TITLE_LEN, 10) || 16;

function loadArkApiKey() {
  if (process.env.ARK_API_KEY && process.env.ARK_API_KEY.trim()) return process.env.ARK_API_KEY.trim();
  if (fs.existsSync(ARK_API_KEY_FILE)) return fs.readFileSync(ARK_API_KEY_FILE, 'utf-8').trim();
  return '';
}

function findBundledFfmpegExecutable() {
  const candidates = [
    path.join(__dirname, 'runtime', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    path.join(__dirname, 'runtime', 'ffmpeg', 'ffmpeg.exe'),
  ];
  return candidates.find(p => fs.existsSync(p)) || '';
}

function findLargestFfmpegZip() {
  if (!fs.existsSync(INSTALLERS_DIR)) return '';
  return fs.readdirSync(INSTALLERS_DIR)
    .filter(name => /^ffmpeg.*\.zip$/i.test(name))
    .map(name => path.join(INSTALLERS_DIR, name))
    .filter(file => fs.statSync(file).isFile())
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0] || '';
}

function ensureBundledFfmpeg() {
  if (findBundledFfmpegExecutable()) return;

  const zipPath = findLargestFfmpegZip();
  if (!zipPath) {
    throw new Error('Bundled FFmpeg is required. Put ffmpeg*.zip in installers and restart start.bat.');
  }

  const runtimeDir = path.join(__dirname, 'runtime');
  const tmpDir = path.join(runtimeDir, 'ffmpeg_tmp');
  const targetDir = path.join(runtimeDir, 'ffmpeg');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  execFileSync('powershell', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command',
    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${tmpDir.replace(/'/g, "''")}' -Force`,
  ], { stdio: 'ignore', timeout: 120000 });

  const stack = [tmpDir];
  let ffmpegDir = '';
  while (stack.length && !ffmpegDir) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      if (entry.isFile() && entry.name.toLowerCase() === 'ffmpeg.exe') {
        ffmpegDir = current;
        break;
      }
    }
  }
  if (!ffmpegDir) throw new Error(`ffmpeg.exe not found in ${path.basename(zipPath)}`);

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.cpSync(ffmpegDir, targetDir, { recursive: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (!findBundledFfmpegExecutable()) {
    throw new Error('FFmpeg extracted but bundled ffmpeg.exe was not found.');
  }
}

ensureBundledFfmpeg();

const app = express();
app.use(express.json({ limit: '200mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ── WebSocket: stream log to all clients ──
function broadcast(msg) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(JSON.stringify(msg));
  });
}

// Override logger to broadcast to WS
const origInfo = logger.info.bind(logger);
const origWarn = logger.warn.bind(logger);
const origError = logger.error.bind(logger);
logger.info = (msg) => { origInfo(msg); broadcast({ type: 'log', level: 'INFO', msg, ts: new Date().toISOString() }); };
logger.warn = (msg) => { origWarn(msg); broadcast({ type: 'log', level: 'WARN', msg, ts: new Date().toISOString() }); };
logger.error = (msg) => { origError(msg); broadcast({ type: 'log', level: 'ERROR', msg, ts: new Date().toISOString() }); };

// ── State ──
let activeContexts = {};
let uploadState = { running: false, abort: false };

function rememberContext(accountName, ctx) {
  activeContexts[accountName] = ctx;
  ctx.on('close', () => {
    if (activeContexts[accountName] === ctx) delete activeContexts[accountName];
  });
  return ctx;
}

function forgetContext(accountName, ctx) {
  if (activeContexts[accountName] === ctx) delete activeContexts[accountName];
}

function deleteUploadedVideoFile(result, record) {
  const rawPath = String(result.video_path || record.video_path || '').trim();
  if (!rawPath) return;
  const videoPath = path.resolve(rawPath);
  try {
    if (!fs.existsSync(videoPath)) {
      logger.warn(`Uploaded file already gone: ${videoPath}`);
      return;
    }
    const stat = fs.statSync(videoPath);
    if (!stat.isFile()) {
      logger.warn(`Skip deleting non-file upload path: ${videoPath}`);
      return;
    }
    const ext = path.extname(videoPath).toLowerCase();
    if (!VIDEO_EXTS.has(ext)) {
      logger.warn(`Skip deleting unexpected upload file type: ${videoPath}`);
      return;
    }
    fs.unlinkSync(videoPath);
    logger.info(`Deleted uploaded video: ${videoPath}`);
  } catch (e) {
    logger.warn(`Could not delete uploaded video ${videoPath}: ${e.message}`);
  }
}

async function closeUploadContexts(accountNames) {
  for (const accountName of accountNames) {
    const ctx = activeContexts[accountName];
    if (!ctx) continue;
    try {
      await ctx.close();
      logger.info(`Closed browser for ${accountName}`);
    } catch (e) {
      logger.warn(`Could not close browser for ${accountName}: ${e.message}`);
    } finally {
      forgetContext(accountName, ctx);
    }
  }
}

// ── API Routes ──

// Accounts
app.get('/api/accounts', (req, res) => {
  res.json(accounts.loadAccounts());
});

app.post('/api/accounts', (req, res) => {
  try {
    const { name, label } = req.body;
    const acct = accounts.createAccount(name, label || name);
    res.json(acct);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/accounts/:name', (req, res) => {
  try {
    const acct = accounts.updateAccount(req.params.name, req.body);
    res.json(acct);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/accounts/:name', (req, res) => {
  try {
    const acct = accounts.deleteAccount(req.params.name);
    // Close context if open
    if (activeContexts[req.params.name]) {
      const ctx = activeContexts[req.params.name];
      ctx.close().catch(() => {});
      forgetContext(req.params.name, ctx);
    }
    res.json(acct);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Login: open browser for an account
app.post('/api/accounts/:name/login', async (req, res) => {
  try {
    const acct = accounts.getAccount(req.params.name);
    if (!acct) return res.status(404).json({ error: 'Account not found' });

    unlockProfile(acct.profileDir);

    let ctx = activeContexts[req.params.name];
    if (!ctx) {
      ctx = rememberContext(req.params.name, await initBrowser(acct.profileDir));
    }

    // Navigate to channels
    const page = ctx.pages().find(p => !p.isClosed()) || await ctx.newPage();
    await page.goto('https://channels.weixin.qq.com/platform/post/create', { waitUntil: 'domcontentloaded' });
    logger.info(`Login browser opened for ${acct.label}`);

    res.json({ message: 'Browser opened for login' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Login done: mark account as ready
app.post('/api/accounts/:name/login/done', async (req, res) => {
  try {
    const acct = accounts.getAccount(req.params.name);
    if (!acct) return res.status(404).json({ error: 'Account not found' });

    let ctx = activeContexts[req.params.name];
    if (!ctx) {
      unlockProfile(acct.profileDir);
      ctx = rememberContext(req.params.name, await initBrowser(acct.profileDir));
    }

    const state = await checkLoginState(ctx, { timeout: 15000 });
    if (!state.loggedIn) {
      accounts.updateAccountStatus(req.params.name, 'needs-login');
      return res.status(400).json({
        error: '还没有检测到登录成功，请扫码后再点“已完成扫码”。',
        state,
      });
    }

    accounts.updateAccountStatus(req.params.name, 'ready');
    res.json({ message: 'Login verified', state });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/accounts/:name/login/status', async (req, res) => {
  try {
    const acct = accounts.getAccount(req.params.name);
    if (!acct) return res.status(404).json({ error: 'Account not found' });

    let ctx = activeContexts[req.params.name];
    if (!ctx) {
      unlockProfile(acct.profileDir);
      ctx = rememberContext(req.params.name, await initBrowser(acct.profileDir));
    }

    const state = await checkLoginState(ctx, { timeout: 5000, navigate: false });
    accounts.updateAccountStatus(req.params.name, state.loggedIn ? 'ready' : 'needs-login');
    res.json(state);
  } catch (e) {
    logger.error(`Login browser failed for ${req.params.name}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Close browser for an account
app.post('/api/accounts/:name/close', async (req, res) => {
  try {
    if (activeContexts[req.params.name]) {
      const ctx = activeContexts[req.params.name];
      await ctx.close();
      forgetContext(req.params.name, ctx);
    }
    res.json({ message: 'Browser closed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload
app.post('/api/upload/start', async (req, res) => {
  if (uploadState.running) return res.status(400).json({ error: 'Upload already running' });

  const { account: accountName, csv: csvContent } = req.body;
  const intervalMinutes = Math.max(0, Math.min(1440, Number.parseInt(req.body.intervalMinutes, 10) || 0));
  if (!accountName) return res.status(400).json({ error: 'account required' });
  if (!csvContent) return res.status(400).json({ error: 'csv content required' });

  const roundRobin = accountName === '__round_robin__';
  const uploadAccounts = roundRobin
    ? accounts.loadAccounts().filter(a => a.status === 'ready')
    : [accounts.getAccount(accountName)].filter(Boolean);
  if (uploadAccounts.length === 0) {
    return res.status(roundRobin ? 400 : 404).json({ error: roundRobin ? 'No ready accounts found' : 'Account not found' });
  }
  if (!roundRobin && uploadAccounts[0].status !== 'ready') {
    return res.status(400).json({ error: 'Account is not logged in' });
  }

  res.json({ message: 'Upload started' });

  // Run async in background
  uploadState.running = true;
  uploadState.abort = false;
  const uploadContextAccounts = new Set();

  try {
    // Parse CSV
    let records;
    try {
      const tmpCsv = path.join(__dirname, `_upload_${Date.now()}.csv`);
      fs.writeFileSync(tmpCsv, csvContent, 'utf-8');
      records = loadCSV(tmpCsv);
      fs.unlinkSync(tmpCsv);
    } catch (e) {
      logger.error(`CSV parse error: ${e.message}`);
      uploadState.running = false;
      broadcast({ type: 'upload-end', success: false, error: e.message });
      return;
    }

    records = preflightRecords(records);
    const validCount = records.filter(r => !r._skip).length;
    if (validCount === 0) {
      logger.warn('No valid records');
      uploadState.running = false;
      broadcast({ type: 'upload-end', success: false, error: 'No valid records' });
      return;
    }
    logger.info(`Preflight: ${validCount} valid, ${records.length - validCount} skipped`);
    logger.info(`Upload interval: ${intervalMinutes} min`);

    let results;
    if (roundRobin) {
      results = [];
      logger.info(`Round-robin upload enabled: ${uploadAccounts.map(a => a.label || a.name).join(', ')}`);

      for (let i = 0; i < records.length; i++) {
        if (uploadState.abort) {
          logger.warn('Upload aborted by user');
          break;
        }

        const record = records[i];
        const acct = uploadAccounts[i % uploadAccounts.length];
        logger.info(`Account ${acct.label || acct.name}: item ${i + 1}/${records.length}`);

        let ctx = activeContexts[acct.name];
        if (!ctx) {
          unlockProfile(acct.profileDir);
          ctx = rememberContext(acct.name, await initBrowser(acct.profileDir));
        }
        uploadContextAccounts.add(acct.name);

        const before = results.length;
        let recordStartedAt = null;
        results = await batchUpload(ctx, [record], {
          resume: false,
          results,
          intervalMinutes,
          abortSignal: uploadState,
          onRecordStart: (p) => { recordStartedAt = p.startedAt; },
          onProgress: (p) => {
            broadcast({
              type: 'progress',
              current: i + 1,
              total: records.length,
              status: p.status,
              title: p.title,
              account: acct.label || acct.name,
            });
          },
        });

        const latest = results[results.length - 1];
        if (latest && latest._loginExpired) {
          accounts.updateAccountStatus(acct.name, 'needs-login');
        }
        await closeUploadContexts(new Set([acct.name]));
        if (results.length === before && uploadState.abort) break;
        const nextRecord = records[i + 1];
        if (intervalMinutes > 0 && nextRecord && !uploadState.abort && recordStartedAt) {
          await waitBetweenUploads(intervalMinutes, uploadState, recordStartedAt);
        }
      }
      writeResults(results, RESULTS_PATH);
    } else {
      const acct = uploadAccounts[0];
      let ctx = activeContexts[acct.name];
      if (!ctx) {
        unlockProfile(acct.profileDir);
        ctx = rememberContext(acct.name, await initBrowser(acct.profileDir));
      }
      uploadContextAccounts.add(acct.name);

      results = await batchUpload(ctx, records, {
        resume: true,
        intervalMinutes,
        abortSignal: uploadState,
        onProgress: (p) => {
          broadcast({ type: 'progress', current: p.current, total: p.total, status: p.status, title: p.title, account: acct.label || acct.name });
        },
      });
    }

    broadcast({ type: 'upload-end', success: true, results: results.filter(r => r.status === 'published').length, total: results.length });
    logger.info(`Upload complete: ${results.filter(r => r.status === 'published').length}/${results.length}`);
  } catch (e) {
    logger.error(`Upload error: ${e.message}`);
    broadcast({ type: 'upload-end', success: false, error: e.message });
  } finally {
    await closeUploadContexts(uploadContextAccounts);
    uploadState.running = false;
  }
});

app.post('/api/upload/stop', (req, res) => {
  uploadState.abort = true;
  res.json({ message: 'Stopping after current video' });
});

app.get('/api/upload/status', (req, res) => {
  res.json({ running: uploadState.running, abort: uploadState.abort });
});

// File upload (drag-drop support)
app.post('/api/upload/file', (req, res) => {
  try {
    const { name, data } = req.body; // data = base64 string
    if (!name || !data) return res.status(400).json({ error: 'name and data required' });
    const ext = path.extname(name) || '.bin';
    const safeName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    const dest = path.join(UPLOADS_DIR, safeName);
    const buffer = Buffer.from(data, 'base64');
    fs.writeFileSync(dest, buffer);
    res.json({ path: dest, name: safeName, originalName: name, size: buffer.length });
  } catch (e) {
    logger.error(`Login browser failed for ${req.params.name}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

function firstValue(row, names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== '') {
      return String(row[name]).trim();
    }
  }
  return '';
}

function normalizeExcelRows(rows) {
  return rows.map((row, index) => {
    const videoPath = firstValue(row, ['视频路径(必填)', '视频路径', 'video_path', '视频']);
    const desc = firstValue(row, ['视频描述(非必填)', '视频描述', 'description', '描述']);
    const shortTitle = firstValue(row, ['短标题(非必填)', '短标题', 'title', '标题']);
    const coverPath = firstValue(row, ['封面路径(非必填)', '封面路径', 'cover_path', '封面']);
    const shoppingCart = firstValue(row, ['购物车(非必填)', '购物车', '小黄车', '商品', '商品名称', 'shopping_cart']);
    return {
      row: index + 2,
      video_path: videoPath,
      video_name: videoPath ? path.basename(videoPath) : '',
      title: shortTitle,
      description: desc,
      cover_path: coverPath,
      location: firstValue(row, ['位置(非必填,填"本地"默认为作者位置)', '位置', 'location']),
      link: firstValue(row, ['链接(非必填)', '链接', 'link']),
      activity: firstValue(row, ['活动(非必填)', '活动', 'activity']),
      original: firstValue(row, ['原创(非必填)', '原创', 'original']),
      shopping_cart: shoppingCart,
      category: firstValue(row, ['分类', '类目', '原创(非必填)']),
      collection: firstValue(row, ['合集(非必填)', '合集', 'collection']),
      video_exists: videoPath ? fs.existsSync(videoPath) : false,
      cover_exists: coverPath ? fs.existsSync(coverPath) : false,
    };
  }).filter(row => row.video_path || row.title || row.description || row.shopping_cart);
}

function normalizeExcelRowsCn(rows) {
  return rows.map((row, index) => {
    const videoPath = firstValue(row, ['视频路径(必填)', '视频路径', 'video_path', '视频']);
    const desc = firstValue(row, ['视频描述(非必填)', '视频描述', 'description', '描述']);
    const shortTitle = firstValue(row, ['短标题(非必填)', '短标题', 'title', '标题']);
    const coverPath = firstValue(row, ['封面路径(非必填)', '封面路径', 'cover_path', '封面']);
    const shoppingCart = firstValue(row, ['购物车(非必填)', '购物车', '小黄车', '商品', '商品名称', 'shopping_cart']);
    return {
      row: index + 2,
      video_path: videoPath,
      video_name: videoPath ? path.basename(videoPath) : '',
      title: shortTitle,
      description: desc,
      cover_path: coverPath,
      location: firstValue(row, ['位置(非必填,填"本地"默认为作者位置)', '位置', 'location']),
      link: firstValue(row, ['链接(非必填)', '链接', 'link']),
      activity: firstValue(row, ['活动(非必填)', '活动', 'activity']),
      original: firstValue(row, ['原创(非必填)', '原创', 'original']),
      shopping_cart: shoppingCart,
      category: firstValue(row, ['分类', '类目', '原创(非必填)']),
      collection: firstValue(row, ['合集(非必填)', '合集', 'collection']),
      video_exists: videoPath ? fs.existsSync(videoPath) : false,
      cover_exists: coverPath ? fs.existsSync(coverPath) : false,
    };
  }).filter(row => row.video_path || row.title || row.description || row.shopping_cart);
}

function stripExt(name) {
  return path.basename(name, path.extname(name)).trim();
}

function listFilesByExt(dir, exts) {
  if (!dir || !fs.existsSync(dir)) return [];
  const stat = fs.statSync(dir);
  if (stat.isFile()) return exts.has(path.extname(dir).toLowerCase()) ? [dir] : [];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(dir)
    .map(name => path.join(dir, name))
    .filter(file => {
      try {
        return fs.statSync(file).isFile() && exts.has(path.extname(file).toLowerCase());
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function findMatchingImage(videoPath, images) {
  const wanted = stripExt(videoPath).toLowerCase();
  return images.find(img => stripExt(img).toLowerCase() === wanted) || images[0] || '';
}

function safeFileStem(name) {
  return stripExt(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 80) || 'cover';
}

function findFfmpegExecutable() {
  return findBundledFfmpegExecutable();
}

function extractCoverWithFfmpeg(videoPath) {
  const ffmpeg = findFfmpegExecutable();
  if (!ffmpeg) throw new Error('Bundled FFmpeg not found. Put ffmpeg*.zip in installers and restart start.bat.');
  const outPath = path.join(GENERATED_COVERS_DIR, `${Date.now()}_${safeFileStem(videoPath)}.jpg`);
  try {
    execFileSync(ffmpeg, [
      '-y',
      '-ss', '00:00:01',
      '-i', videoPath,
      '-frames:v', '1',
      '-q:v', '3',
      outPath,
    ], { stdio: 'ignore', timeout: 30000 });
    if (!fs.existsSync(outPath)) throw new Error('FFmpeg did not create a cover image');
    return outPath;
  } catch (e) {
    throw new Error(`FFmpeg cover extract failed for ${path.basename(videoPath)}: ${e.message}`);
  }
}

function imageToDataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

function extractOutputText(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string') return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const part of item.content || []) {
      if (typeof part.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('\n');
}

function parseDoubaoJson(text) {
  const raw = String(text || '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(raw); } catch {}
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error('Doubao did not return JSON');
}

async function callDoubaoForRows(items) {
  const apiKey = loadArkApiKey();
  if (!apiKey) throw new Error('ARK_API_KEY is not set');

  if (items.length > 10) {
    const rows = [];
    for (let start = 0; start < items.length; start += 10) {
      const chunk = items.slice(start, start + 10).map((item, offset) => ({ ...item, rowIndex: start + offset }));
      rows.push(...await callDoubaoForRows(chunk));
    }
    return rows;
  }

  const promptItems = items.map((item, index) => ({
    index: item.rowIndex ?? index,
    product_name: item.productName,
    video_file: path.basename(item.videoPath),
    has_image: !!item.imagePath,
  }));
  promptItems.short_title_rule = `short_title is required, max ${MAX_SHORT_TITLE_LEN} characters, only Chinese letters and numbers, no punctuation spaces or symbols. It must summarize the specific video scene or selling point, must be different for each row, and must not equal or simply repeat product_name.`;
  const content = [
    {
      type: 'input_text',
      text:
        '你是视频号带货发布表格助手。请根据产品名称、视频文件名和图片，生成发布 Excel 的字段。' +
        '要求：只返回 JSON，不要 Markdown。JSON 格式为 {"rows":[{"index":0,"description":"","short_title":""}]}。' +
        'description 使用中文短视频文案风格，尽量贴近视频文件名和封面图，不要夸大功效，不要出现违禁医疗承诺；short_title 可为空。' +
        `待处理项目：${JSON.stringify(promptItems)}`,
    },
  ];

  items.forEach((item, index) => {
    if (!item.imagePath) return;
    content.push({ type: 'input_text', text: `第 ${index} 个项目图片：${item.productName}` });
    content.push({ type: 'input_image', image_url: imageToDataUrl(item.imagePath) });
  });

  const response = await fetch(DOUBAO_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: DOUBAO_MODEL, input: [{ role: 'user', content }] }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || `Doubao request failed: ${response.status}`);
  const parsed = parseDoubaoJson(extractOutputText(data));
  return Array.isArray(parsed.rows) ? parsed.rows : [];
}

function buildWorkbookRows(items, generatedRows) {
  const byIndex = new Map(generatedRows.map(row => [Number(row.index), row]));
  const usedTitles = new Set();
  return items.map((item, index) => {
    const gen = byIndex.get(index) || {};
    const description = String(gen.description || item.productName).trim();
    const shortTitle = uniqueShortTitle(
      cleanShortTitle(gen.short_title || gen.title || description),
      item,
      description,
      usedTitles
    );
    return {
      [TEMPLATE_HEADERS[0]]: item.videoPath,
      [TEMPLATE_HEADERS[1]]: description,
      [TEMPLATE_HEADERS[2]]: item.imagePath || '',
      [TEMPLATE_HEADERS[3]]: '',
      [TEMPLATE_HEADERS[4]]: '',
      [TEMPLATE_HEADERS[5]]: '',
      [TEMPLATE_HEADERS[6]]: '生活',
      [TEMPLATE_HEADERS[7]]: item.productName,
      [TEMPLATE_HEADERS[8]]: shortTitle,
      [TEMPLATE_HEADERS[9]]: '',
    };
  });
}

function cleanShortTitle(value) {
  return String(value || '')
    .replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '')
    .slice(0, MAX_SHORT_TITLE_LEN);
}

function uniqueShortTitle(candidate, item, description, usedTitles) {
  const productTitle = cleanShortTitle(item.productName);
  let title = candidate;
  if (!title || title === productTitle || usedTitles.has(title)) {
    title = cleanShortTitle(description);
  }
  if (!title || title === productTitle || usedTitles.has(title)) {
    title = cleanShortTitle(`${productTitle}${usedTitles.size + 1}`);
  }
  let unique = title;
  let counter = 2;
  while (usedTitles.has(unique)) {
    const suffix = String(counter++);
    unique = `${title.slice(0, Math.max(1, MAX_SHORT_TITLE_LEN - suffix.length))}${suffix}`;
  }
  usedTitles.add(unique);
  return unique;
}

function normalizeGeneratedRows(items, workbookRows) {
  return workbookRows.map((row, index) => {
    const item = items[index];
    const videoPath = item.videoPath;
    const coverPath = item.imagePath || '';
    return {
      row: index + 2,
      video_path: videoPath,
      video_name: path.basename(videoPath),
      title: cleanShortTitle(row[TEMPLATE_HEADERS[8]] || row[TEMPLATE_HEADERS[1]]),
      description: row[TEMPLATE_HEADERS[1]] || '',
      cover_path: coverPath,
      location: row[TEMPLATE_HEADERS[3]] || '',
      link: row[TEMPLATE_HEADERS[4]] || '',
      activity: row[TEMPLATE_HEADERS[5]] || '',
      original: row[TEMPLATE_HEADERS[6]] || '',
      shopping_cart: row[TEMPLATE_HEADERS[7]] || '',
      category: row[TEMPLATE_HEADERS[6]] || '',
      collection: row[TEMPLATE_HEADERS[9]] || '',
      video_exists: true,
      cover_exists: coverPath ? fs.existsSync(coverPath) : false,
    };
  });
}

app.post('/api/doubao/excel', async (req, res) => {
  try {
    const videoDir = String(req.body.videoDir || '').trim();
    const productName = String(req.body.productName || '').trim();
    if (!videoDir) return res.status(400).json({ error: 'videoDir required' });

    const videos = listFilesByExt(path.resolve(videoDir), VIDEO_EXTS);
    if (videos.length === 0) return res.status(400).json({ error: 'No video files found' });
    const items = [];
    for (const videoPath of videos) {
      items.push({
        videoPath,
        imagePath: extractCoverWithFfmpeg(videoPath),
        productName: productName || stripExt(videoPath),
      });
    }

    logger.info(`Doubao Excel: ${items.length} videos, ${items.filter(i => i.imagePath).length} covers ready`);
    const generatedRows = await callDoubaoForRows(items);
    const workbookRows = buildWorkbookRows(items, generatedRows);
    const worksheet = XLSX.utils.json_to_sheet(workbookRows, { header: TEMPLATE_HEADERS });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet0');
    const outPath = path.join(UPLOADS_DIR, `doubao_${Date.now()}.xlsx`);
    XLSX.writeFile(workbook, outPath);

    res.json({
      path: outPath,
      rows: normalizeGeneratedRows(items, workbookRows),
      total: workbookRows.length,
      missingVideos: 0,
      missingCovers: workbookRows.filter(r => !r[TEMPLATE_HEADERS[2]]).length,
    });
  } catch (e) {
    logger.error(`Doubao Excel failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/doubao/scan-new', async (req, res) => {
  try {
    const videoDir = String(req.body.videoDir || '').trim();
    const productName = String(req.body.productName || '').trim();
    const known = new Set((req.body.known || []).map(p => path.resolve(String(p))));
    const minAgeSeconds = Math.max(5, Math.min(3600, Number.parseInt(req.body.minAgeSeconds, 10) || 20));
    if (!videoDir) return res.status(400).json({ error: 'videoDir required' });

    const now = Date.now();
    const videos = listFilesByExt(path.resolve(videoDir), VIDEO_EXTS)
      .filter(videoPath => !known.has(path.resolve(videoPath)))
      .filter(videoPath => {
        const stat = fs.statSync(videoPath);
        return stat.size > 0 && now - stat.mtimeMs >= minAgeSeconds * 1000;
      });

    if (videos.length === 0) {
      return res.json({ rows: [], total: 0 });
    }

    const items = [];
    for (const videoPath of videos) {
      items.push({
        videoPath,
        imagePath: extractCoverWithFfmpeg(videoPath),
        productName: productName || stripExt(videoPath),
      });
    }

    logger.info(`Doubao watch: ${items.length} new videos`);
    const generatedRows = await callDoubaoForRows(items);
    const workbookRows = buildWorkbookRows(items, generatedRows);
    res.json({
      rows: normalizeGeneratedRows(items, workbookRows),
      total: workbookRows.length,
    });
  } catch (e) {
    logger.error(`Doubao watch failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/doubao/list-videos', (req, res) => {
  try {
    const videoDir = String(req.body.videoDir || '').trim();
    if (!videoDir) return res.status(400).json({ error: 'videoDir required' });
    const videos = listFilesByExt(path.resolve(videoDir), VIDEO_EXTS);
    res.json({ videos, total: videos.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/upload/excel', (req, res) => {
  try {
    const { name, data } = req.body;
    if (!name || !data) return res.status(400).json({ error: 'name and data required' });
    const buffer = Buffer.from(data, 'base64');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames.find(n => !/dictionary/i.test(n)) || workbook.SheetNames[0];
    if (!sheetName) return res.status(400).json({ error: 'No sheets found' });
    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    const rows = normalizeExcelRowsCn(rawRows);
    res.json({
      name,
      sheet: sheetName,
      rows,
      total: rows.length,
      missingVideos: rows.filter(r => r.video_path && !r.video_exists).length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Results & log
app.get('/api/results', (req, res) => {
  if (!fs.existsSync(RESULTS_PATH)) return res.json([]);
  const text = fs.readFileSync(RESULTS_PATH, 'utf-8');
  const lines = text.split('\n').filter(Boolean);
  if (lines.length <= 1) return res.json([]);
  const headers = lines[0].split(',');
  const rows = lines.slice(1).map(line => {
    const vals = line.split(',');
    return headers.reduce((obj, h, i) => ({ ...obj, [h.trim()]: (vals[i] || '').replace(/^"|"$/g, '') }), {});
  });
  res.json(rows);
});

app.get('/api/log', (req, res) => {
  if (!fs.existsSync(LOG_PATH)) return res.json([]);
  const text = fs.readFileSync(LOG_PATH, 'utf-8');
  res.json(text.split('\n').filter(Boolean).slice(-200));
});

// ── Start ──
server.listen(PORT, () => {
  console.log(`Server: http://localhost:${PORT}`);
});

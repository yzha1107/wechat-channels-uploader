const fs = require('fs');
const path = require('path');

const ACCOUNTS_PATH = path.join(__dirname, 'accounts.json');
const BASE_PROFILE_DIR = path.join(__dirname, 'browser-profile');
const SAVE_RETRIES = 10;
const SAVE_RETRY_DELAY_MS = 200;

const DEFAULT_ACCOUNTS = [
  { name: 'default', profileDir: BASE_PROFILE_DIR, label: '主账号', status: 'needs-login', lastLogin: null, createdAt: null },
];

function profileDirFor(name) {
  return name === 'default'
    ? BASE_PROFILE_DIR
    : path.join(__dirname, `browser-profile-${name}`);
}

function normalizeAccount(account) {
  const name = account.name || 'default';
  const expectedProfileDir = profileDirFor(name);
  const normalized = {
    ...account,
    name,
    profileDir: expectedProfileDir,
  };
  if (account.profileDir && path.resolve(account.profileDir) !== path.resolve(expectedProfileDir)) {
    normalized.status = 'needs-login';
    normalized.lastLogin = null;
  }
  return normalized;
}

function serializeAccount(account) {
  const { profileDir, ...stored } = account;
  return stored;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_PATH)) {
    saveAccounts(DEFAULT_ACCOUNTS);
    return JSON.parse(JSON.stringify(DEFAULT_ACCOUNTS));
  }
  try {
    const data = fs.readFileSync(ACCOUNTS_PATH, 'utf-8');
    const loaded = JSON.parse(data);
    const normalized = loaded.map(normalizeAccount);
    if (JSON.stringify(loaded) !== JSON.stringify(normalized)) saveAccounts(normalized);
    return normalized;
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_ACCOUNTS));
  }
}

function saveAccounts(accounts) {
  const dir = path.dirname(ACCOUNTS_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.accounts.${process.pid}.${Date.now()}.tmp`);
  const data = JSON.stringify(accounts.map(serializeAccount), null, 2);

  for (let attempt = 1; attempt <= SAVE_RETRIES; attempt++) {
    try {
      if (fs.existsSync(ACCOUNTS_PATH)) {
        try { fs.chmodSync(ACCOUNTS_PATH, 0o666); } catch {}
      }
      fs.writeFileSync(tmpPath, data, 'utf-8');
      fs.renameSync(tmpPath, ACCOUNTS_PATH);
      return;
    } catch (e) {
      try { if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true }); } catch {}
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt === SAVE_RETRIES) throw e;
      sleep(SAVE_RETRY_DELAY_MS);
    }
  }
}

function getAccount(name) {
  return loadAccounts().find(a => a.name === name) || null;
}

function generateAccountName(accounts) {
  const used = new Set(accounts.map(a => a.name));
  let index = 2;
  while (used.has(`account${index}`)) index += 1;
  return `account${index}`;
}

function createAccount(name, label) {
  const accounts = loadAccounts();
  name = (name || '').trim() || generateAccountName(accounts);
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error('Account name can only contain letters, numbers, underscores, and hyphens');
  }
  if (accounts.find(a => a.name === name)) {
    throw new Error(`Account "${name}" already exists`);
  }
  const profileDir = profileDirFor(name);
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }
  const account = {
    name,
    profileDir,
    label: label || name,
    status: 'needs-login',
    lastLogin: null,
    createdAt: new Date().toISOString(),
  };
  accounts.push(account);
  saveAccounts(accounts);
  return account;
}

function deleteAccount(name) {
  if (name === 'default') throw new Error('Cannot delete default account');
  const accounts = loadAccounts();
  const idx = accounts.findIndex(a => a.name === name);
  if (idx === -1) throw new Error(`Account "${name}" not found`);
  const [account] = accounts.splice(idx, 1);
  saveAccounts(accounts);
  // Remove profile directory (best effort)
  if (fs.existsSync(account.profileDir)) {
    fs.rmSync(account.profileDir, { recursive: true, force: true });
  }
  return account;
}

function updateAccount(name, updates) {
  const accounts = loadAccounts();
  const account = accounts.find(a => a.name === name);
  if (!account) throw new Error(`Account "${name}" not found`);
  Object.assign(account, updates);
  saveAccounts(accounts);
  return account;
}

function updateAccountStatus(name, status) {
  const accounts = loadAccounts();
  const account = accounts.find(a => a.name === name);
  if (!account) return;
  account.status = status;
  if (status === 'ready') account.lastLogin = new Date().toISOString();
  saveAccounts(accounts);
}

module.exports = { loadAccounts, saveAccounts, getAccount, createAccount, deleteAccount, updateAccount, updateAccountStatus };

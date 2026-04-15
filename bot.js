// WhatsApp Web bot that auto-approves group join requests.
//
// Flow:
//   1. Admin scans QR in the web panel (one-time per session).
//   2. Admin picks the OLD group (where we check membership) and the NEW
//      group (where we approve requests).
//   3. On a new membership request in the NEW group, the bot checks whether
//      the requester is already in the OLD group. If yes — approve, if no
//      — reject. Small random delays are added so the behavior looks like
//      a human admin.

const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const db = require('./database');

// Resolve Chromium path: prefer the one puppeteer installs into its cache.
// Falls back to undefined (let whatsapp-web.js handle it) if puppeteer isn't installed.
let chromePath;
try {
  chromePath = require('puppeteer').executablePath();
} catch (_) {
  chromePath = undefined;
}

// ---- State ----
let client = null;
let status = 'disconnected'; // 'disconnected' | 'qr' | 'authenticating' | 'ready' | 'error'
let latestQr = null;         // data URL of the current QR code (only while status === 'qr')
let lastError = null;

// Ring buffer of recent bot events for debugging via admin panel
const logBuffer = [];
const LOG_CAP = 200;
function blog(level, ...parts) {
  const line = `[${new Date().toISOString()}] [${level}] ${parts.join(' ')}`;
  logBuffer.push(line);
  if (logBuffer.length > LOG_CAP) logBuffer.shift();
  if (level === 'error') console.error(line);
  else console.log(line);
}
function getLogs() {
  return logBuffer.slice();
}

// Normalize a WhatsApp JID (e.g. "972526059554@c.us") → local Israeli mobile "0526059554".
function jidToPhone(jid) {
  if (!jid) return '';
  let digits = String(jid).split('@')[0].replace(/[^\d]/g, '');
  if (digits.startsWith('972') && digits.length > 9) digits = '0' + digits.slice(3);
  if (digits.length === 9 && digits.startsWith('5')) digits = '0' + digits;
  return digits;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---- Membership check ----
async function isPhoneInOldGroup(phone) {
  const oldGroupId = db.getConfig('old_group_id');
  if (!oldGroupId || !client) return false;
  try {
    const chat = await client.getChatById(oldGroupId);
    if (!chat || !chat.isGroup) return false;
    const participants = chat.participants || [];
    return participants.some(p => jidToPhone(p.id && p.id._serialized) === phone);
  } catch (err) {
    console.error('[bot] isPhoneInOldGroup error:', err.message);
    return false;
  }
}

// ---- Handle a single membership request (from live event or pending list) ----
async function handleRequest({ chatId, authorId }) {
  const newGroupId = db.getConfig('new_group_id');
  if (!newGroupId || chatId !== newGroupId) return;

  const phone = jidToPhone(authorId);
  if (!phone) {
    db.logBotAction(null, 'error', 'no phone in author JID', chatId);
    return;
  }

  // Small delay so we don't look like a bot hammering instantly
  await sleep(1500 + Math.floor(Math.random() * 2500));

  try {
    const chat = await client.getChatById(chatId);
    const inOldGroup = await isPhoneInOldGroup(phone);

    if (inOldGroup) {
      await chat.approveGroupMembershipRequests({ requesterIds: [authorId] });
      db.logBotAction(phone, 'approved', 'member of old group', chatId);
      console.log(`[bot] approved ${phone}`);
    } else {
      await chat.rejectGroupMembershipRequests({ requesterIds: [authorId] });
      db.logBotAction(phone, 'rejected', 'not a member of old group', chatId);
      console.log(`[bot] rejected ${phone}`);
    }
  } catch (err) {
    console.error('[bot] handleRequest error:', err.message);
    db.logBotAction(phone, 'error', err.message, chatId);
  }
}

// ---- Process any pending requests on startup (caught up while bot was offline) ----
async function processPendingRequests() {
  const newGroupId = db.getConfig('new_group_id');
  if (!newGroupId || !client) return;
  try {
    const chat = await client.getChatById(newGroupId);
    if (!chat || !chat.isGroup) return;
    const pending = await chat.getGroupMembershipRequests();
    console.log(`[bot] found ${pending.length} pending request(s)`);
    for (const req of pending) {
      await handleRequest({ chatId: newGroupId, authorId: req.id._serialized || req.id });
    }
  } catch (err) {
    console.error('[bot] processPendingRequests error:', err.message);
  }
}

// ---- Start / stop ----
function start() {
  if (client) return;
  status = 'disconnected';
  lastError = null;

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
    puppeteer: {
      headless: true,
      executablePath: chromePath, // undefined → let puppeteer find its own
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
      ],
    },
  });

  blog('info', 'starting client (chromePath =', chromePath || '<default>', ')');

  client.on('qr', async (qr) => {
    try {
      latestQr = await QRCode.toDataURL(qr);
      status = 'qr';
      blog('info', 'QR ready (len', qr.length, ')');
    } catch (err) {
      blog('error', 'QR render failed:', err.message);
    }
  });

  client.on('loading_screen', (percent, msg) => {
    blog('info', `loading_screen ${percent}% — ${msg}`);
  });

  client.on('authenticated', (session) => {
    status = 'authenticating';
    latestQr = null;
    blog('info', 'authenticated event fired');
  });

  client.on('ready', async () => {
    status = 'ready';
    latestQr = null;
    blog('info', 'READY event fired — client connected');
    try {
      await processPendingRequests();
    } catch (err) {
      blog('error', 'processPendingRequests threw:', err.message);
    }
  });

  client.on('auth_failure', (msg) => {
    status = 'error';
    lastError = 'auth failure: ' + msg;
    blog('error', 'auth_failure:', msg);
  });

  client.on('change_state', (s) => {
    blog('info', 'change_state:', s);
  });

  client.on('disconnected', (reason) => {
    status = 'disconnected';
    blog('info', 'disconnected:', reason);
  });

  // Live membership request event
  client.on('group_membership_request', async (notification) => {
    blog('info', 'membership_request', notification.chatId, notification.author);
    await handleRequest({
      chatId: notification.chatId,
      authorId: notification.author,
    });
  });

  client.initialize().catch(err => {
    status = 'error';
    lastError = err.message;
    blog('error', 'initialize() rejected:', err.message, err.stack || '');
  });
}

async function stop() {
  if (!client) return;
  try { await client.destroy(); } catch (_) {}
  client = null;
  status = 'disconnected';
  latestQr = null;
}

async function logout() {
  if (!client) return;
  try { await client.logout(); } catch (_) {}
  await stop();
}

// ---- Introspection for admin panel ----
async function listGroups() {
  if (!client || status !== 'ready') return [];
  try {
    const chats = await client.getChats();
    return chats
      .filter(c => c.isGroup)
      .map(c => ({
        id: c.id._serialized,
        name: c.name,
        participantCount: (c.participants || []).length,
      }));
  } catch (err) {
    console.error('[bot] listGroups error:', err.message);
    return [];
  }
}

async function getStatus() {
  let oldGroupName = null;
  let newGroupName = null;
  let oldGroupMemberCount = null;

  if (status === 'ready' && client) {
    const oldId = db.getConfig('old_group_id');
    const newId = db.getConfig('new_group_id');
    try {
      if (oldId) {
        const c = await client.getChatById(oldId);
        if (c) { oldGroupName = c.name; oldGroupMemberCount = (c.participants || []).length; }
      }
      if (newId) {
        const c = await client.getChatById(newId);
        if (c) newGroupName = c.name;
      }
    } catch (_) { /* ignore */ }
  }

  return {
    status,
    lastError,
    oldGroupId: db.getConfig('old_group_id') || '',
    newGroupId: db.getConfig('new_group_id') || '',
    oldGroupName,
    newGroupName,
    oldGroupMemberCount,
    hasQr: !!latestQr,
  };
}

function getQr() {
  return latestQr;
}

module.exports = {
  start,
  stop,
  logout,
  getStatus,
  getQr,
  listGroups,
  processPendingRequests,
  getLogs,
};

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const db = new Database(path.join(__dirname, 'gatekeeper.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS access_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    choice TEXT,
    ip TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rate_limit (
    ip TEXT NOT NULL,
    attempt_time DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS one_time_tokens (
    token TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    used INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS bot_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT,
    action TEXT,           -- 'approved', 'rejected', 'error'
    reason TEXT,
    group_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Add choice column to access_log if it doesn't exist (migration for existing DBs)
try {
  db.exec(`ALTER TABLE access_log ADD COLUMN choice TEXT`);
} catch (e) { /* already exists */ }

// Set default admin password if not exists
const existingPassword = db.prepare('SELECT value FROM config WHERE key = ?').get('admin_password');
if (!existingPassword) {
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('admin_password', 'admin123');
}

// Set default WhatsApp link if not configured
const existingLink = db.prepare('SELECT value FROM config WHERE key = ?').get('whatsapp_link');
if (!existingLink) {
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run(
    'whatsapp_link',
    'https://chat.whatsapp.com/DoVU8eHoN0wBvDknONXh7M'
  );
}

// Config helpers
function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setConfig(key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
}

// Access log helpers
function hasReceivedLink(phone) {
  const row = db.prepare('SELECT id FROM access_log WHERE phone = ?').get(phone);
  return !!row;
}

function logAccess(phone, choice, ip) {
  db.prepare('INSERT INTO access_log (phone, choice, ip) VALUES (?, ?, ?)').run(phone, choice, ip);
}

function getAccessLog() {
  return db.prepare('SELECT phone, choice, ip, created_at FROM access_log ORDER BY created_at DESC').all();
}

function getAccessCount() {
  const row = db.prepare('SELECT COUNT(*) as count FROM access_log').get();
  return row.count;
}

function getChoiceCount(choice) {
  const row = db.prepare('SELECT COUNT(*) as count FROM access_log WHERE choice = ?').get(choice);
  return row.count;
}

// Rate limiting
function checkRateLimit(ip, maxAttempts = 5, windowMinutes = 60) {
  db.prepare(`DELETE FROM rate_limit WHERE attempt_time < datetime('now', '-${windowMinutes} minutes')`).run();
  const row = db.prepare('SELECT COUNT(*) as count FROM rate_limit WHERE ip = ?').get(ip);
  return row.count < maxAttempts;
}

function recordAttempt(ip) {
  db.prepare('INSERT INTO rate_limit (ip) VALUES (?)').run(ip);
}

// One-time token helpers
// Tokens are valid for 60 seconds and can be used exactly once to redirect to the WhatsApp link.
function createToken(phone) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO one_time_tokens (token, phone) VALUES (?, ?)').run(token, phone);
  return token;
}

function consumeToken(token) {
  // Clean up expired tokens
  db.prepare(`DELETE FROM one_time_tokens WHERE created_at < datetime('now', '-5 minutes')`).run();
  const row = db.prepare('SELECT phone, used, created_at FROM one_time_tokens WHERE token = ?').get(token);
  if (!row) return null;
  if (row.used) return null;
  // Check age: 60 seconds window
  const ageRow = db.prepare(`SELECT (strftime('%s','now') - strftime('%s', created_at)) AS age FROM one_time_tokens WHERE token = ?`).get(token);
  if (ageRow && ageRow.age > 60) return null;
  db.prepare('UPDATE one_time_tokens SET used = 1 WHERE token = ?').run(token);
  return row.phone;
}

// Bot action log
function logBotAction(phone, action, reason, groupId) {
  db.prepare(
    'INSERT INTO bot_actions (phone, action, reason, group_id) VALUES (?, ?, ?, ?)'
  ).run(phone || null, action, reason || null, groupId || null);
}

function getBotActions(limit = 100) {
  return db
    .prepare('SELECT phone, action, reason, group_id, created_at FROM bot_actions ORDER BY created_at DESC LIMIT ?')
    .all(limit);
}

function getBotActionCounts() {
  const approved = db.prepare("SELECT COUNT(*) as c FROM bot_actions WHERE action = 'approved'").get().c;
  const rejected = db.prepare("SELECT COUNT(*) as c FROM bot_actions WHERE action = 'rejected'").get().c;
  return { approved, rejected };
}

module.exports = {
  getConfig,
  setConfig,
  hasReceivedLink,
  logAccess,
  getAccessLog,
  getAccessCount,
  getChoiceCount,
  checkRateLimit,
  recordAttempt,
  createToken,
  consumeToken,
  logBotAction,
  getBotActions,
  getBotActionCounts,
};

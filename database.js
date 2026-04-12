const Database = require('better-sqlite3');
const path = require('path');

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
    ip TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rate_limit (
    ip TEXT NOT NULL,
    attempt_time DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Set default admin password if not exists
const existingPassword = db.prepare('SELECT value FROM config WHERE key = ?').get('admin_password');
if (!existingPassword) {
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('admin_password', 'admin123');
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

function logAccess(phone, ip) {
  db.prepare('INSERT INTO access_log (phone, ip) VALUES (?, ?)').run(phone, ip);
}

function getAccessLog() {
  return db.prepare('SELECT phone, ip, created_at FROM access_log ORDER BY created_at DESC').all();
}

function getAccessCount() {
  const row = db.prepare('SELECT COUNT(*) as count FROM access_log').get();
  return row.count;
}

// Rate limiting
function checkRateLimit(ip, maxAttempts = 5, windowMinutes = 60) {
  // Clean old entries
  db.prepare(`DELETE FROM rate_limit WHERE attempt_time < datetime('now', '-${windowMinutes} minutes')`).run();

  const row = db.prepare('SELECT COUNT(*) as count FROM rate_limit WHERE ip = ?').get(ip);
  return row.count < maxAttempts;
}

function recordAttempt(ip) {
  db.prepare('INSERT INTO rate_limit (ip) VALUES (?)').run(ip);
}

module.exports = {
  getConfig,
  setConfig,
  hasReceivedLink,
  logAccess,
  getAccessLog,
  getAccessCount,
  checkRateLimit,
  recordAttempt,
};

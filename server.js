const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Load approved phone HASHES. No plaintext PII in the repo. ---
// Real phones are hashed with a server-side PEPPER (env var).
// The hash file is committed; without the PEPPER the hashes are opaque.
const PEPPER = process.env.PEPPER || '';
if (!PEPPER) {
  console.warn('WARNING: PEPPER env var is not set — all phone validations will fail until it is configured.');
}

const HASHES_PATH = path.join(__dirname, 'approved-hashes.json');
let approvedHashes = new Set();
function loadApprovedHashes() {
  try {
    const arr = JSON.parse(fs.readFileSync(HASHES_PATH, 'utf8'));
    approvedHashes = new Set(arr);
    console.log(`Loaded ${approvedHashes.size} approved phone hashes.`);
  } catch (err) {
    console.error('Failed to load approved-hashes.json:', err.message);
    approvedHashes = new Set();
  }
}
loadApprovedHashes();

// Normalize phone: strip non-digits, convert Israeli 972XXXXXXXXX → 0XXXXXXXXX
function normalizePhone(phone) {
  let c = String(phone).replace(/[^\d]/g, '');
  if (c.startsWith('972') && c.length > 9) c = '0' + c.slice(3);
  return c;
}

function phoneHash(normalized) {
  return crypto.createHash('sha256').update(normalized + PEPPER).digest('hex');
}

function isApproved(normalized) {
  if (!PEPPER) return false;
  return approvedHashes.has(phoneHash(normalized));
}

// --- Routes ---

// Main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Validate phone number — returns { success, approved: true } without the link.
// The link is only handed out after the user picks a group preference.
app.post('/validate', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!db.checkRateLimit(ip)) {
    return res.json({ success: false, message: 'יותר מדי ניסיונות. נסה שוב מאוחר יותר.' });
  }
  db.recordAttempt(ip);

  const { phone } = req.body;
  if (!phone) {
    return res.json({ success: false, message: 'יש להזין מספר טלפון.' });
  }

  const normalized = normalizePhone(phone);

  if (db.hasReceivedLink(normalized)) {
    return res.json({
      success: false,
      message: 'כבר קיבלת את הלינק. ניתן לקבל פעם אחת בלבד.',
    });
  }

  if (!isApproved(normalized)) {
    return res.json({
      success: false,
      message: 'מספר הטלפון לא נמצא ברשימה המאושרת.',
    });
  }

  // Approved — but don't hand out the link yet. Client should POST /claim with choice.
  return res.json({
    success: true,
    approved: true,
    phone: normalized,
    message: 'המספר אומת. אנא בחר את ההעדפה שלך.',
  });
});

// Claim link — user picks a choice and gets a one-time token (NOT the link).
// The token can be redeemed exactly once, within 60 seconds, via GET /open/:token.
app.post('/claim', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  const { phone, choice } = req.body;
  if (!phone || !choice) {
    return res.json({ success: false, message: 'חסר מידע.' });
  }

  const normalized = normalizePhone(phone);

  // Re-verify approval and no prior claim
  if (!isApproved(normalized)) {
    return res.json({ success: false, message: 'מספר הטלפון לא נמצא ברשימה המאושרת.' });
  }
  if (db.hasReceivedLink(normalized)) {
    return res.json({ success: false, message: 'כבר קיבלת את הלינק.' });
  }

  const allowedChoices = ['only_new', 'both'];
  if (!allowedChoices.includes(choice)) {
    return res.json({ success: false, message: 'בחירה לא חוקית.' });
  }

  const whatsappLink = db.getConfig('whatsapp_link');
  if (!whatsappLink) {
    return res.json({ success: false, message: 'הלינק לקבוצה עדיין לא הוגדר. פנה למנהל.' });
  }

  // Log access and mint a one-time token
  db.logAccess(normalized, choice, ip);
  const token = db.createToken(normalized);

  return res.json({
    success: true,
    token,
    choice,
    // No link in the response — client uses /open/:token which redirects server-side.
  });
});

// One-time redirect: consumes the token and 302s to the WhatsApp link.
// After first hit, the token is invalid — anyone who copies the /open/TOKEN URL gets an error.
app.get('/open/:token', (req, res) => {
  const token = req.params.token;
  const phone = db.consumeToken(token);
  if (!phone) {
    return res.status(410).send(`
      <!DOCTYPE html>
      <html lang="he" dir="rtl"><head><meta charset="UTF-8">
      <title>לינק פג תוקף</title>
      <style>body{font-family:-apple-system,sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}
      .box{background:white;border-radius:16px;padding:40px;max-width:420px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,0.1)}
      h1{color:#c62828;font-size:22px;margin:0 0 15px}p{color:#555;line-height:1.6}</style>
      </head><body><div class="box"><h1>הלינק פג תוקף</h1>
      <p>הלינק כבר נוצל או שתוקפו פג. ניתן לקבל את הלינק פעם אחת בלבד.</p>
      </div></body></html>
    `);
  }
  const whatsappLink = db.getConfig('whatsapp_link');
  if (!whatsappLink) {
    return res.status(500).send('לינק לא מוגדר');
  }
  // Prevent this redirect from being cached anywhere
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.redirect(302, whatsappLink);
});

// --- Admin Routes ---

function adminAuth(req, res, next) {
  const password = db.getConfig('admin_password');
  const provided = req.headers['x-admin-password'] || req.body.password || req.query.password;
  if (provided === password) next();
  else res.status(401).json({ error: 'סיסמה שגויה' });
}

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

app.get('/admin/config', adminAuth, (req, res) => {
  res.json({
    whatsapp_link: db.getConfig('whatsapp_link') || '',
    access_count: db.getAccessCount(),
    approved_count: approvedHashes.size,
    only_new_count: db.getChoiceCount('only_new'),
    both_count: db.getChoiceCount('both'),
  });
});

app.post('/admin/config', adminAuth, (req, res) => {
  const { whatsapp_link, new_password } = req.body;
  if (whatsapp_link !== undefined) db.setConfig('whatsapp_link', whatsapp_link);
  if (new_password) db.setConfig('admin_password', new_password);
  res.json({ success: true, message: 'ההגדרות עודכנו בהצלחה.' });
});

app.get('/admin/log', adminAuth, (req, res) => {
  res.json(db.getAccessLog());
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
});

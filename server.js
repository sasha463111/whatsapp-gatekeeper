const express = require('express');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'views')));

// Normalize phone number: remove spaces, dashes, convert +972 to 0
function normalizePhone(phone) {
  let cleaned = phone.replace(/[\s\-\(\)]/g, '');
  // Convert +972 to 0
  if (cleaned.startsWith('+972')) {
    cleaned = '0' + cleaned.slice(4);
  }
  // Convert 972 to 0 (without +)
  if (cleaned.startsWith('972') && cleaned.length > 9) {
    cleaned = '0' + cleaned.slice(3);
  }
  return cleaned;
}

// Fetch approved phones from Google Sheet (published as CSV)
async function fetchApprovedPhones() {
  const sheetUrl = db.getConfig('sheet_url');
  if (!sheetUrl) return [];

  try {
    const response = await fetch(sheetUrl);
    const csv = await response.text();
    const lines = csv.split('\n');
    const phones = [];

    for (const line of lines) {
      // Take first column, remove quotes
      const value = line.split(',')[0].replace(/"/g, '').trim();
      if (value && /\d{5,}/.test(value)) {
        phones.push(normalizePhone(value));
      }
    }
    return phones;
  } catch (err) {
    console.error('Error fetching Google Sheet:', err.message);
    return [];
  }
}

// --- Routes ---

// Main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Validate phone number
app.post('/validate', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  // Rate limit check
  if (!db.checkRateLimit(ip)) {
    return res.json({
      success: false,
      message: 'יותר מדי ניסיונות. נסה שוב מאוחר יותר.',
    });
  }
  db.recordAttempt(ip);

  const { phone } = req.body;
  if (!phone) {
    return res.json({ success: false, message: 'יש להזין מספר טלפון.' });
  }

  const normalized = normalizePhone(phone);

  // Check if already received
  if (db.hasReceivedLink(normalized)) {
    return res.json({
      success: false,
      message: 'כבר קיבלת את הלינק. ניתן לקבל פעם אחת בלבד.',
    });
  }

  // Check if in approved list
  const approvedPhones = await fetchApprovedPhones();
  if (approvedPhones.length === 0) {
    return res.json({
      success: false,
      message: 'המערכת לא מוגדרת כראוי. פנה למנהל.',
    });
  }

  if (!approvedPhones.includes(normalized)) {
    return res.json({
      success: false,
      message: 'מספר הטלפון לא נמצא ברשימה המאושרת.',
    });
  }

  // Success - log and return link
  const whatsappLink = db.getConfig('whatsapp_link');
  if (!whatsappLink) {
    return res.json({
      success: false,
      message: 'הלינק לקבוצה עדיין לא הוגדר. פנה למנהל.',
    });
  }

  db.logAccess(normalized, ip);

  return res.json({
    success: true,
    link: whatsappLink,
    message: 'הלינק נשלח בהצלחה! יש לך 30 שניות להצטרף.',
  });
});

// --- Admin Routes ---

// Simple admin auth middleware
function adminAuth(req, res, next) {
  const password = db.getConfig('admin_password');
  const provided = req.headers['x-admin-password'] || req.body.password || req.query.password;

  if (provided === password) {
    next();
  } else {
    res.status(401).json({ error: 'סיסמה שגויה' });
  }
}

// Admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

// Get admin config
app.get('/admin/config', adminAuth, (req, res) => {
  res.json({
    whatsapp_link: db.getConfig('whatsapp_link') || '',
    sheet_url: db.getConfig('sheet_url') || '',
    access_count: db.getAccessCount(),
  });
});

// Update config
app.post('/admin/config', adminAuth, (req, res) => {
  const { whatsapp_link, sheet_url, new_password } = req.body;

  if (whatsapp_link !== undefined) db.setConfig('whatsapp_link', whatsapp_link);
  if (sheet_url !== undefined) db.setConfig('sheet_url', sheet_url);
  if (new_password) db.setConfig('admin_password', new_password);

  res.json({ success: true, message: 'ההגדרות עודכנו בהצלחה.' });
});

// Get access log
app.get('/admin/log', adminAuth, (req, res) => {
  const log = db.getAccessLog();
  res.json(log);
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
});

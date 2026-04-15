// Hash approved phones with the server pepper.
// Reads approved-phones.json (NOT committed — contains PII),
// writes approved-hashes.json (safe to commit — opaque hashes).
//
// Run: PEPPER=... node hash-phones.js
// The same PEPPER must be set as an env var on the server.

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const pepper = process.env.PEPPER;
if (!pepper || pepper.length < 32) {
  console.error('ERROR: PEPPER env var is required (min 32 chars). Set via: PEPPER=xxx node hash-phones.js');
  process.exit(1);
}

const phones = JSON.parse(fs.readFileSync(path.join(__dirname, 'approved-phones.json'), 'utf8'));
const hashes = Object.keys(phones).map(phone =>
  crypto.createHash('sha256').update(phone + pepper).digest('hex')
);

fs.writeFileSync(
  path.join(__dirname, 'approved-hashes.json'),
  JSON.stringify(hashes, null, 2)
);
console.log(`Hashed ${hashes.length} phones → approved-hashes.json`);

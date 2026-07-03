const nodeCrypto = require('crypto');

function id(prefix) {
  return `${prefix}_${Date.now()}_${nodeCrypto.randomBytes(4).toString('hex')}`;
}

function dateFolderName(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

module.exports = { id, dateFolderName };

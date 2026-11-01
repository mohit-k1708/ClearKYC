/**
 * Application-level protection for PAN and Aadhaar numbers.
 *
 *  - encrypt()/decrypt(): AES-256-GCM (authenticated encryption). The stored value is
 *    "iv.authTag.ciphertext" (each part base64). A fresh random IV is used every time,
 *    so the same PAN encrypts to a different string each time.
 *  - blindIndex(): HMAC-SHA256 with a separate key. It is deterministic, so the database
 *    can enforce UNIQUE (duplicate detection) without ever storing the plaintext.
 *
 * Keys come from environment variables (see config/env.js), never from source code.
 */
const crypto = require('crypto');
const env = require('../config/env');

function encrypt(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', env.encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((b) => b.toString('base64')).join('.');
}

function decrypt(payload) {
  const [iv, tag, encrypted] = String(payload)
    .split('.')
    .map((part) => Buffer.from(part, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', env.encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/** Deterministic keyed hash used only for duplicate detection. `scope` separates PAN from Aadhaar. */
function blindIndex(scope, value) {
  return crypto.createHmac('sha256', env.hashKey).update(`${scope}:${value}`).digest('hex');
}

module.exports = { encrypt, decrypt, blindIndex };

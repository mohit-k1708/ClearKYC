/**
 * Encryption for generated data that gives the SAME output for the same input, so two runs with one seed are identical.
 *
 * The application's encrypt() uses a random IV (a different ciphertext each time). Here the IV is derived from the value with a
 * keyed hash (a synthetic-IV construction), and everything else is identical: AES-256-GCM, the same key, the same
 * "iv.tag.ciphertext" format, so the application's decrypt() reads it normally.
 */
const crypto = require('crypto');
const env = require('../../server/src/config/env');
const { blindIndex } = require('../../server/src/utils/crypto');

function encryptDeterministic(plainText) {
  const text = String(plainText);
  const iv = crypto.createHmac('sha256', env.hashKey).update(`iv:${text}`).digest().subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-256-gcm', env.encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((b) => b.toString('base64')).join('.');
}

module.exports = { encryptDeterministic, blindIndex };

/**
 * Local-disk storage for uploaded document files (development only).
 *
 * Safety rules:
 *  - The file BYTES are never stored in PostgreSQL; the database keeps only metadata and a reference.
 *  - The stored name is generated (32 random hex characters + a checked extension). The user's
 *    file name is never used as a path, so path traversal ("../../x") is impossible.
 *  - A reference is validated against a strict pattern before any disk access.
 *  - The upload directory is outside the web root and is not served statically; files are
 *    only delivered through the API as attachments.
 * Production would use private object storage (S3, Azure Blob...) with virus scanning.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { UPLOAD } = require('../config/kycRules');

const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '..', '..', 'uploads');

const REFERENCE_PATTERN = /^[a-f0-9]{32}\.(pdf|jpg|png)$/;

/** Identifies a file type from its first bytes. Returns 'pdf' | 'jpg' | 'png' | null. */
function sniffExtension(buffer) {
  for (const [ext, { magic }] of Object.entries(UPLOAD.types)) {
    if (buffer.length >= magic.length && magic.every((byte, i) => buffer[i] === byte)) return ext;
  }
  return null;
}

/** Strips any folder part and control characters from a client-supplied file name (metadata only). */
function cleanFileName(name) {
  const base = String(name || 'document').split(/[\\/]/).pop();
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '_').trim();
  return (cleaned || 'document').slice(0, 120);
}

async function saveFile(buffer, ext) {
  if (!UPLOAD.types[ext]) throw new Error('Unsupported file extension');
  await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
  const reference = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  await fs.promises.writeFile(path.join(UPLOAD_DIR, reference), buffer, { flag: 'wx' });
  return reference;
}

function isValidReference(reference) {
  return typeof reference === 'string' && REFERENCE_PATTERN.test(reference);
}

function openFile(reference) {
  if (!isValidReference(reference)) return null;
  const filePath = path.join(UPLOAD_DIR, reference);
  return fs.existsSync(filePath) ? fs.createReadStream(filePath) : null;
}

/** Best-effort cleanup (used when a database write fails after the file was saved). */
async function deleteFile(reference) {
  if (!isValidReference(reference)) return;
  await fs.promises.unlink(path.join(UPLOAD_DIR, reference)).catch(() => {});
}

module.exports = { UPLOAD_DIR, sniffExtension, cleanFileName, saveFile, openFile, deleteFile, isValidReference };

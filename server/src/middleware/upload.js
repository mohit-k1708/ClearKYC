/**
 * Optional file upload for document records (multipart/form-data, field name "file").
 *
 * Checks, in order: size limit, allowed extension and declared MIME type, then the file's real
 * leading bytes ("magic numbers") so a renamed .exe cannot pass as a .pdf. Nothing is written to
 * disk here; the service saves the file only after the rest of the request validated.
 * JSON requests (no file) pass straight through.
 */
const multer = require('multer');
const path = require('path');
const { UPLOAD } = require('../config/kycRules');
const { AppError } = require('../utils/errors');
const { sniffExtension, cleanFileName } = require('../utils/fileStorage');
const { bindRequestContext } = require('../utils/requestContext');

const MIME_TO_EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };
const EXT_ALIASES = { jpeg: 'jpg' };
const allowedText = 'PDF, JPG or PNG up to ' + UPLOAD.maxBytes / (1024 * 1024) + ' MB';

const parser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD.maxBytes, files: 1, fields: 20, fieldSize: 4 * 1024 },
  fileFilter(req, file, cb) {
    const rawExt = path.extname(file.originalname || '').slice(1).toLowerCase();
    const ext = EXT_ALIASES[rawExt] || rawExt;
    if (!UPLOAD.types[ext] || MIME_TO_EXT[file.mimetype] !== ext) {
      return cb(new AppError(400, 'INVALID_FILE_TYPE', `Only ${allowedText} files are accepted`, { file: `Only ${allowedText} files are accepted` }));
    }
    cb(null, true);
  },
}).single('file');

function uploadOptionalFile(req, res, next) {
  parser(req, res, (err) => {
    if (err instanceof AppError) return next(err);
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new AppError(413, 'FILE_TOO_LARGE', `The file is too large. Maximum size is ${UPLOAD.maxBytes / (1024 * 1024)} MB`, { file: `Maximum file size is ${UPLOAD.maxBytes / (1024 * 1024)} MB` }));
      }
      return next(new AppError(400, 'INVALID_UPLOAD', 'The upload could not be processed', { file: 'Send one file in the "file" field' }));
    }
    if (err) return next(err);

    if (req.file) {
      const ext = sniffExtension(req.file.buffer);
      const declared = MIME_TO_EXT[req.file.mimetype];
      if (!ext || ext !== declared) {
        return next(new AppError(400, 'INVALID_FILE_TYPE', 'The file content does not match its type', { file: `The file is not a real ${allowedText.split(' up')[0]} file` }));
      }
      req.uploadedFile = {
        buffer: req.file.buffer,
        ext,
        mime: req.file.mimetype,
        size: req.file.size,
        originalName: cleanFileName(req.file.originalname),
      };
    }
    bindRequestContext(req); // multer calls next() from a stream callback; re-attach the audit context
    return next();
  });
}

module.exports = { uploadOptionalFile };

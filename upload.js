'use strict';
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const { v4: uuidv4 } = require('uuid');

const UPLOAD_DIR   = process.env.UPLOAD_DIR || path.join(__dirname, '../uploads');
const MAX_SIZE_MB   = parseInt(process.env.MAX_VIDEO_SIZE_MB || '100', 10);

// Ensure upload directories exist
['videos', 'thumbnails'].forEach(dir => {
  const p = path.join(UPLOAD_DIR, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, path.join(UPLOAD_DIR, 'videos'));
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
    cb(null, `${uuidv4()}${ext}`);
  },
});

function fileFilter(req, file, cb) {
  const allowed = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported video type: ${file.mimetype}`), false);
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_SIZE_MB * 1024 * 1024 },
});

module.exports = upload;

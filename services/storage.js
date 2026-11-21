// services/storage.js
// Saves uploaded photos and returns their public URL.
//
//  • Cloudinary settings present (Vercel / live)  → photo goes to Cloudinary (kept forever, fast CDN)
//  • No Cloudinary settings (your laptop)          → photo goes to the local uploads folder, as before
//
// .env (live only — leave out on your laptop):
//   CLOUDINARY_URL=cloudinary://API_KEY:API_SECRET@CLOUD_NAME
//   (or CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET)
//   CLOUDINARY_FOLDER=hostelkhojo          (optional)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const uploadDir = path.resolve(__dirname, '..', process.env.UPLOAD_DIR || 'uploads');

function cloudinaryConfig() {
  const url = (process.env.CLOUDINARY_URL || '').trim();
  const m = url.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
  const cfg = m
    ? { key: m[1], secret: m[2], cloud: m[3] }
    : {
        key: (process.env.CLOUDINARY_API_KEY || '').trim(),
        secret: (process.env.CLOUDINARY_API_SECRET || '').trim(),
        cloud: (process.env.CLOUDINARY_CLOUD_NAME || '').trim(),
      };
  if (!cfg.key || !cfg.secret || !cfg.cloud) return null;
  cfg.folder = (process.env.CLOUDINARY_FOLDER || 'hostelkhojo').trim();
  cfg.base = (process.env.CLOUDINARY_API_BASE || 'https://api.cloudinary.com').replace(/\/+$/, '');
  return cfg;
}

/** Cloudinary request signature: sorted params joined with &, then the secret, SHA-1. */
function sign(params, secret) {
  const str = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(str + secret).digest('hex');
}

function usingCloud() {
  return !!cloudinaryConfig();
}

function ensureLocalDir() {
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
}

/**
 * Save one multer file (memory storage: file.buffer).
 * @param file      multer file
 * @param baseName  name without extension, e.g. a doc_id or "profile-8-1712345678"
 * @param req       express request (used for the local URL)
 * @returns { url, fileName, storage: 'cloudinary' | 'local', publicId? }
 */
async function saveImage(file, baseName, req) {
  const ext = (path.extname(file.originalname || '') || '.jpg').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
  const cfg = cloudinaryConfig();

  if (cfg) {
    const timestamp = Math.floor(Date.now() / 1000);
    const params = { folder: cfg.folder, public_id: baseName, timestamp };
    const form = new FormData();
    form.append('file', new Blob([file.buffer], { type: file.mimetype || 'image/jpeg' }), file.originalname || baseName + ext);
    form.append('api_key', cfg.key);
    form.append('timestamp', String(timestamp));
    form.append('folder', cfg.folder);
    form.append('public_id', baseName);
    form.append('signature', sign(params, cfg.secret));

    const r = await fetch(`${cfg.base}/v1_1/${cfg.cloud}/image/upload`, { method: 'POST', body: form });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.secure_url) {
      throw new Error('Photo upload failed: ' + (out?.error?.message || `Cloudinary answered ${r.status}`));
    }
    return { url: out.secure_url, fileName: baseName + ext, storage: 'cloudinary', publicId: out.public_id };
  }

  ensureLocalDir();
  const fileName = baseName + ext;
  await fs.promises.writeFile(path.join(uploadDir, fileName), file.buffer);
  return { url: `${req.protocol}://${req.get('host')}/uploads/${fileName}`, fileName, storage: 'local' };
}

/** Undo a save (used when the listing fails to save). Never throws. */
async function removeImage(saved) {
  try {
    if (!saved) return;
    if (saved.storage === 'local') {
      await fs.promises.unlink(path.join(uploadDir, saved.fileName)).catch(() => {});
      return;
    }
    const cfg = cloudinaryConfig();
    if (!cfg || !saved.publicId) return;
    const timestamp = Math.floor(Date.now() / 1000);
    const form = new FormData();
    form.append('public_id', saved.publicId);
    form.append('timestamp', String(timestamp));
    form.append('api_key', cfg.key);
    form.append('signature', sign({ public_id: saved.publicId, timestamp }, cfg.secret));
    await fetch(`${cfg.base}/v1_1/${cfg.cloud}/image/destroy`, { method: 'POST', body: form });
  } catch (_) {
    /* best effort */
  }
}

module.exports = { saveImage, removeImage, usingCloud, uploadDir, _sign: sign };

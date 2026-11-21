const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const { saveImage } = require('../services/storage');

// Photos are kept in memory for a moment, then saved by services/storage.js
// (Cloudinary on the live site, the local uploads folder on your laptop).
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: Number(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /image\/(jpeg|jpg|png|webp)/.test(file.mimetype);
    cb(ok ? null : new Error('Only JPG, PNG or WEBP images are allowed.'), ok);
  },
});

function signUserToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, type: 'user' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

function publicUser(u) {
  const { password_hash, otp_code, otp_expires, reset_token, reset_expires, ...safe } = u;
  return safe;
}

router.post('/register', async (req, res, next) => {
  try {
    const { full_name, email, phone, password, gender } = req.body;
    if (!full_name || !email || !phone || !password) {
      return res.status(400).json({ success: false, message: 'Full name, email, phone and password are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
    }

    const [[existing]] = await pool.query(
      'SELECT id FROM users WHERE email = :email OR phone = :phone',
      { email, phone }
    );
    if (existing) {
      return res.status(409).json({ success: false, message: 'An account with this email or phone already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const [result] = await pool.query(
      `INSERT INTO users (full_name, email, phone, password_hash, gender, is_verified, is_active)
       VALUES (:full_name, :email, :phone, :password_hash, :gender, 0, 1)`,
      { full_name, email, phone, password_hash: passwordHash, gender: gender || null }
    );

    const [[user]] = await pool.query('SELECT * FROM users WHERE id = :id', { id: result.insertId });
    const token = signUserToken(user);

    res.status(201).json({ success: true, message: 'Account created!', token, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    const [[user]] = await pool.query('SELECT * FROM users WHERE email = :email', { email });
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }
    if (!user.is_active) {
      return res.status(403).json({ success: false, message: 'This account has been deactivated.' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    const token = signUserToken(user);
    res.json({ success: true, message: 'Login successful', token, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const [[user]] = await pool.query('SELECT * FROM users WHERE id = :id', { id: req.user.id });
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    res.json({ success: true, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.put('/profile', requireAuth, async (req, res, next) => {
  try {
    const { full_name, phone, gender } = req.body;

    if (phone) {
      const [[taken]] = await pool.query(
        'SELECT id FROM users WHERE phone = :phone AND id != :id',
        { phone, id: req.user.id }
      );
      if (taken) return res.status(409).json({ success: false, message: 'That phone number is already in use.' });
    }

    await pool.query(
      `UPDATE users SET
         full_name = COALESCE(:full_name, full_name),
         phone     = COALESCE(:phone, phone),
         gender    = COALESCE(:gender, gender)
       WHERE id = :id`,
      { full_name: full_name || null, phone: phone || null, gender: gender || null, id: req.user.id }
    );

    const [[user]] = await pool.query('SELECT * FROM users WHERE id = :id', { id: req.user.id });
    res.json({ success: true, message: 'Profile updated.', user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/profile/picture', requireAuth, upload.single('profile_pic'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No image file received.' });

    const saved = await saveImage(req.file, `profile-${req.user.id}-${Date.now()}`, req);
    const publicUrl = saved.url;
    await pool.query('UPDATE users SET profile_pic = :url WHERE id = :id', { url: publicUrl, id: req.user.id });

    res.json({ success: true, message: 'Profile picture updated.', profile_pic: publicUrl });
  } catch (err) {
    next(err);
  }
});
// ── Change password ───────────────────────────────────────
router.put('/password', requireAuth, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ success: false, message: 'Current and new password are required.' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ success: false, message: 'New password must be at least 8 characters.' });
    }

    const [[user]] = await pool.query('SELECT password_hash FROM users WHERE id = :id', { id: req.user.id });
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const match = await bcrypt.compare(current_password, user.password_hash);
    if (!match) return res.status(400).json({ success: false, message: 'Current password is incorrect.' });

    const hash = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE users SET password_hash = :hash WHERE id = :id', { hash, id: req.user.id });

    res.json({ success: true, message: 'Password changed successfully.' });
  } catch (err) {
    next(err);
  }
});

// ── Deactivate account (soft delete: is_active = 0) ───────
router.delete('/account', requireAuth, async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ success: false, message: 'Please enter your password to confirm.' });

    const [[user]] = await pool.query('SELECT password_hash FROM users WHERE id = :id', { id: req.user.id });
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(400).json({ success: false, message: 'Password is incorrect.' });

    await pool.query('UPDATE users SET is_active = 0 WHERE id = :id', { id: req.user.id });
    res.json({ success: true, message: 'Your account has been deactivated.' });
  } catch (err) {
    next(err);
  }
});
module.exports = router;
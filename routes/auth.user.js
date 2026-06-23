// routes/auth.user.js
const express        = require('express');
const bcrypt         = require('bcryptjs');
const jwt            = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const pool           = require('../config/db');

const router = express.Router();

// ── Auth Middleware (inline — avoids circular import) ─────
const authUser = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer '))
      return res.status(401).json({ success: false, message: 'No token provided' });

    const token   = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const [rows] = await pool.query(
      'SELECT id, full_name, email, phone, is_active FROM users WHERE id = ?',
      [decoded.id]
    );

    if (!rows.length || !rows[0].is_active)
      return res.status(401).json({ success: false, message: 'User not found or inactive' });

    req.user = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

// Helper
const genOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

// ── POST /api/auth/register ───────────────────────────────
router.post('/register', async (req, res) => {
  const { full_name, email, phone, password, gender } = req.body;

  if (!full_name || !email || !phone || !password)
    return res.status(400).json({ success: false, message: 'All fields are required' });

  try {
    const [exist] = await pool.query(
      'SELECT id FROM users WHERE email = ? OR phone = ?', [email, phone]
    );
    if (exist.length)
      return res.status(409).json({ success: false, message: 'Email or phone already registered' });

    const hash       = await bcrypt.hash(password, 12);
    const otp        = genOTP();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000);

    const [result] = await pool.query(
      `INSERT INTO users (full_name, email, phone, password_hash, gender, otp_code, otp_expires)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [full_name, email, phone, hash, gender || null, otp, otpExpires]
    );

    console.log(`OTP for ${email}: ${otp}`);

    res.status(201).json({
      success: true,
      message: 'Registered! Please verify OTP sent to your email.',
      user_id: result.insertId
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/auth/verify-otp ─────────────────────────────
router.post('/verify-otp', async (req, res) => {
  const { user_id, otp } = req.body;
  try {
    const [rows] = await pool.query(
      'SELECT id, otp_code, otp_expires FROM users WHERE id = ?', [user_id]
    );
    if (!rows.length)
      return res.status(404).json({ success: false, message: 'User not found' });

    const user = rows[0];
    if (user.otp_code !== otp || new Date() > new Date(user.otp_expires))
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });

    await pool.query(
      'UPDATE users SET is_verified = 1, otp_code = NULL, otp_expires = NULL WHERE id = ?',
      [user_id]
    );

    res.json({ success: true, message: 'Email verified! You can now login.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/auth/login ──────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ success: false, message: 'Email and password required' });

  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (!rows.length)
      return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const user = rows[0];
    if (!user.is_active)
      return res.status(403).json({ success: false, message: 'Account is inactive' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match)
      return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      success:  true,
      message:  'Login successful',
      token,
      user: {
        id:          user.id,
        full_name:   user.full_name,
        email:       user.email,
        phone:       user.phone,
        is_verified: user.is_verified,
        profile_pic: user.profile_pic
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/auth/forgot-password ───────────────────────
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  try {
    const [rows] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (!rows.length)
      return res.status(404).json({ success: false, message: 'Email not registered' });

    const token   = uuidv4();
    const expires = new Date(Date.now() + 60 * 60 * 1000);

    await pool.query(
      'UPDATE users SET reset_token = ?, reset_expires = ? WHERE email = ?',
      [token, expires, email]
    );

    console.log(`Reset link: ${process.env.FRONTEND_URL}/reset-password?token=${token}`);
    res.json({ success: true, message: 'Password reset link sent to your email' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/auth/reset-password ────────────────────────
router.post('/reset-password', async (req, res) => {
  const { token, new_password } = req.body;
  try {
    const [rows] = await pool.query(
      'SELECT id, reset_expires FROM users WHERE reset_token = ?', [token]
    );
    if (!rows.length)
      return res.status(400).json({ success: false, message: 'Invalid reset token' });

    if (new Date() > new Date(rows[0].reset_expires))
      return res.status(400).json({ success: false, message: 'Reset token expired' });

    const hash = await bcrypt.hash(new_password, 12);
    await pool.query(
      'UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?',
      [hash, rows[0].id]
    );

    res.json({ success: true, message: 'Password reset successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────
router.get('/me', authUser, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, full_name, email, phone, gender, profile_pic, is_verified, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    res.json({ success: true, user: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/auth/profile ─────────────────────────────────
router.put('/profile', authUser, async (req, res) => {
  const { full_name, phone, gender } = req.body;
  try {
    await pool.query(
      `UPDATE users SET
         full_name = COALESCE(?, full_name),
         phone     = COALESCE(?, phone),
         gender    = COALESCE(?, gender)
       WHERE id = ?`,
      [full_name, phone, gender, req.user.id]
    );
    res.json({ success: true, message: 'Profile updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
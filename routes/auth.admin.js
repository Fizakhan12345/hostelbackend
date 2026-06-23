// routes/auth.admin.js
const express          = require('express');
const bcrypt           = require('bcryptjs');
const jwt              = require('jsonwebtoken');
const pool             = require('../config/db');
const { authAdmin }    = require('../middleware/auth');

const router = express.Router();

// POST /api/admin/auth/register
router.post('/register', async (req, res) => {
  const { full_name, email, phone, password } = req.body;

  if (!full_name || !email || !phone || !password)
    return res.status(400).json({ success: false, message: 'All fields are required' });

  try {
    const [exist] = await pool.query(
      'SELECT id FROM admins WHERE email = ? OR phone = ?', [email, phone]
    );
    if (exist.length)
      return res.status(409).json({ success: false, message: 'Email or phone already registered' });

    const hash = await bcrypt.hash(password, 12);

    const [result] = await pool.query(
      `INSERT INTO admins (full_name, email, phone, password_hash) VALUES (?, ?, ?, ?)`,
      [full_name, email, phone, hash]
    );

    res.status(201).json({
      success:  true,
      message:  'Registered! Your account is pending approval. We will notify you via email.',
      admin_id: result.insertId
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password)
    return res.status(400).json({ success: false, message: 'Email and password required' });

  try {
    const [rows] = await pool.query('SELECT * FROM admins WHERE email = ?', [email]);
    if (!rows.length)
      return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const admin = rows[0];

    if (!admin.is_active)
      return res.status(403).json({ success: false, message: 'Account is inactive' });

    if (!admin.is_approved)
      return res.status(403).json({ success: false, message: 'Account pending approval. We will contact you soon.' });

    const match = await bcrypt.compare(password, admin.password_hash);
    if (!match)
      return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const token = jwt.sign(
      { id: admin.id, email: admin.email, role: 'admin' },
      process.env.JWT_ADMIN_SECRET,
      { expiresIn: '7d' }
    );

    const [[propCount]] = await pool.query(
      'SELECT COUNT(*) as total FROM properties WHERE admin_id = ?', [admin.id]
    );

    res.json({
      success: true,
      message: 'Login successful',
      token,
      admin: {
        id:               admin.id,
        full_name:        admin.full_name,
        email:            admin.email,
        phone:            admin.phone,
        is_approved:      admin.is_approved,
        profile_pic:      admin.profile_pic,
        total_properties: propCount.total
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/auth/me
router.get('/me', authAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.id, a.full_name, a.email, a.phone, a.profile_pic, a.is_approved, a.created_at,
              COUNT(p.id) AS total_properties,
              SUM(p.available_rooms) AS total_available_rooms
       FROM admins a
       LEFT JOIN properties p ON p.admin_id = a.id
       WHERE a.id = ?
       GROUP BY a.id`,
      [req.admin.id]
    );
    res.json({ success: true, admin: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/admin/auth/change-password
router.put('/change-password', authAdmin, async (req, res) => {
  const { current_password, new_password } = req.body;
  try {
    const [rows] = await pool.query(
      'SELECT password_hash FROM admins WHERE id = ?', [req.admin.id]
    );
    const match = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!match)
      return res.status(400).json({ success: false, message: 'Current password is incorrect' });

    const hash = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE admins SET password_hash = ? WHERE id = ?', [hash, req.admin.id]);
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
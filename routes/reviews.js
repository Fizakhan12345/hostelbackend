// routes/reviews.js
const express = require('express');
const jwt     = require('jsonwebtoken');
const pool    = require('../config/db');

// ── Inline Middlewares (no circular imports) ──────────────

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

const authAdmin = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer '))
      return res.status(401).json({ success: false, message: 'No token provided' });

    const token   = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_ADMIN_SECRET);

    const [rows] = await pool.query(
      'SELECT id, full_name, email, is_approved, is_active FROM admins WHERE id = ?',
      [decoded.id]
    );

    if (!rows.length || !rows[0].is_active)
      return res.status(401).json({ success: false, message: 'Admin not found or inactive' });

    if (!rows[0].is_approved)
      return res.status(403).json({ success: false, message: 'Admin account pending approval' });

    req.admin = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

// ════════════════════════════════════════════════════════
// 1. REVIEWS ROUTER  →  mounted at /api/reviews
// ════════════════════════════════════════════════════════
const router = express.Router();

// POST /api/reviews
router.post('/', authUser, async (req, res) => {
  const { property_id, booking_id, rating, title, comment } = req.body;

  if (!property_id || !booking_id || !rating)
    return res.status(400).json({ success: false, message: 'Property, booking and rating are required' });

  try {
    const [rows] = await pool.query(
      `SELECT id FROM bookings
       WHERE id = ? AND user_id = ? AND property_id = ?
       AND status IN ('checked_in', 'checked_out')`,
      [booking_id, req.user.id, property_id]
    );

    if (!rows.length)
      return res.status(403).json({ success: false, message: 'You can only review after check-in' });

    await pool.query(
      `INSERT INTO reviews (property_id, user_id, booking_id, rating, title, comment)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [property_id, req.user.id, booking_id, rating, title || null, comment || null]
    );

    // Recalculate avg rating on property
    await pool.query(
      `UPDATE properties SET
         avg_rating    = (SELECT AVG(rating) FROM reviews WHERE property_id = ? AND is_approved = 1),
         total_reviews = (SELECT COUNT(*)    FROM reviews WHERE property_id = ? AND is_approved = 1)
       WHERE id = ?`,
      [property_id, property_id, property_id]
    );

    res.status(201).json({
      success: true,
      message: 'Review submitted! It will appear after approval.'
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ success: false, message: 'You have already reviewed this booking' });
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/reviews/property/:id
router.get('/property/:id', async (req, res) => {
  try {
    const [reviews] = await pool.query(
      `SELECT r.id, r.rating, r.title, r.comment, r.created_at,
              u.full_name, u.profile_pic
       FROM reviews r
       JOIN users u ON u.id = r.user_id
       WHERE r.property_id = ? AND r.is_approved = 1
       ORDER BY r.created_at DESC`,
      [req.params.id]
    );
    res.json({ success: true, data: reviews });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════
// 2. FAVORITES ROUTER  →  mounted at /api/favorites
// ════════════════════════════════════════════════════════
const favRouter = express.Router();

// POST /api/favorites/:property_id  (toggle)
favRouter.post('/:property_id', authUser, async (req, res) => {
  const { property_id } = req.params;
  try {
    const [exist] = await pool.query(
      'SELECT 1 FROM favorites WHERE user_id = ? AND property_id = ?',
      [req.user.id, property_id]
    );

    if (exist.length) {
      await pool.query(
        'DELETE FROM favorites WHERE user_id = ? AND property_id = ?',
        [req.user.id, property_id]
      );
      return res.json({ success: true, favorited: false, message: 'Removed from favorites' });
    }

    await pool.query(
      'INSERT INTO favorites (user_id, property_id) VALUES (?, ?)',
      [req.user.id, property_id]
    );
    res.json({ success: true, favorited: true, message: 'Added to favorites' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/favorites
favRouter.get('/', authUser, async (req, res) => {
  try {
    const [favs] = await pool.query(
      `SELECT
         p.id, p.name, p.area, p.city, p.property_type,
         p.monthly_rent, p.avg_rating, p.available_rooms,
         f.created_at AS saved_at,
         (SELECT image_url FROM property_images
          WHERE property_id = p.id AND is_primary = 1 LIMIT 1) AS image
       FROM favorites f
       JOIN properties p ON p.id = f.property_id
       WHERE f.user_id = ? AND p.is_active = 1
       ORDER BY f.created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, data: favs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════
// 3. DASHBOARD ROUTER  →  mounted at /api/dashboard
// ════════════════════════════════════════════════════════
const dashRouter = express.Router();

// GET /api/dashboard/admin
dashRouter.get('/admin', authAdmin, async (req, res) => {
  try {
    const adminId = req.admin.id;

    const [[props]] = await pool.query(
      'SELECT COUNT(*) as total, SUM(available_rooms) as available FROM properties WHERE admin_id = ?',
      [adminId]
    );

    const [[bookings]] = await pool.query(
      `SELECT
         COUNT(b.id)  AS total_bookings,
         SUM(CASE WHEN b.status = 'confirmed' THEN 1 ELSE 0 END) AS active_bookings,
         SUM(CASE WHEN b.status = 'pending'   THEN 1 ELSE 0 END) AS pending_bookings,
         SUM(b.monthly_rent) AS total_revenue
       FROM bookings b
       JOIN properties p ON p.id = b.property_id
       WHERE p.admin_id = ?`,
      [adminId]
    );

    const [[commission]] = await pool.query(
      `SELECT SUM(commission_amt) AS total_commission
       FROM commission_ledger WHERE admin_id = ? AND status = 'settled'`,
      [adminId]
    );

    const [recentBookings] = await pool.query(
      `SELECT
         b.booking_ref, b.status, b.created_at, b.total_amount,
         u.full_name AS tenant,
         p.name AS property
       FROM bookings b
       JOIN properties p ON p.id = b.property_id
       JOIN users u      ON u.id = b.user_id
       WHERE p.admin_id = ?
       ORDER BY b.created_at DESC
       LIMIT 5`,
      [adminId]
    );

    res.json({
      success: true,
      data: {
        properties:      { total: props.total, available_rooms: props.available },
        bookings:         bookings,
        commission_paid:  commission.total_commission || 0,
        recent_bookings:  recentBookings
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/dashboard/amenities  (public)
dashRouter.get('/amenities', async (req, res) => {
  try {
    const [amenities] = await pool.query(
      'SELECT * FROM amenities ORDER BY category, name'
    );
    res.json({ success: true, data: amenities });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════════
module.exports            = router;      // default → reviews
module.exports.favRouter  = favRouter;   // named   → favorites
module.exports.dashRouter = dashRouter;  // named   → dashboard
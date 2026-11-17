// routes/bookings.js
const express              = require('express');
const pool                 = require('../config/db');
const { authUser, authAdmin } = require('../middleware/auth');

const router = express.Router();

const genRef = () => {
  const year = new Date().getFullYear();
  const rand = Math.floor(10000 + Math.random() * 90000);
  return `HB-${year}-${rand}`;
};

// POST /api/bookings  (User — Create)
router.post('/', authUser, async (req, res) => {
  const { property_id, room_id, check_in_date, duration_months } = req.body;

  if (!property_id || !room_id || !check_in_date || !duration_months)
    return res.status(400).json({ success: false, message: 'All booking fields required' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [props] = await conn.query(
      'SELECT * FROM properties WHERE id = ? AND is_active = 1', [property_id]
    );
    if (!props.length) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Property not found' });
    }

    const [rooms] = await conn.query(
      'SELECT * FROM rooms WHERE id = ? AND property_id = ? AND available > 0',
      [room_id, property_id]
    );
    if (!rooms.length) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Room not available' });
    }

    const property        = props[0];
    const room            = rooms[0];
    const monthly_rent    = room.price_per_bed;
    const commission_rate = parseFloat(process.env.DEFAULT_COMMISSION_RATE) || 5;
    const commission_amt  = (monthly_rent * commission_rate) / 100;
    const total_amount    = monthly_rent + property.security_deposit;
    const booking_ref     = genRef();

    const [result] = await conn.query(
      `INSERT INTO bookings
         (booking_ref, user_id, property_id, room_id, check_in_date,
          duration_months, monthly_rent, security_deposit, total_amount,
          commission_rate, commission_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        booking_ref, req.user.id, property_id, room_id, check_in_date,
        duration_months, monthly_rent, property.security_deposit, total_amount,
        commission_rate, commission_amt
      ]
    );

    await conn.query('UPDATE rooms SET available = available - 1 WHERE id = ?', [room_id]);
    await conn.query('UPDATE properties SET available_rooms = available_rooms - 1 WHERE id = ?', [property_id]);

    await conn.query(
      `INSERT INTO commission_ledger
         (booking_id, property_id, admin_id, booking_amount, commission_rate, commission_amt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [result.insertId, property_id, property.admin_id, total_amount, commission_rate, commission_amt]
    );

    await conn.query(
      `INSERT INTO notifications (admin_id, type, title, message) VALUES (?, 'new_booking', 'New Booking Received!', ?)`,
      [property.admin_id, `New booking (${booking_ref}) for ${property.name}.`]
    );

    await conn.commit();
    res.status(201).json({
      success: true,
      message: 'Booking created! Proceed to payment.',
      booking: {
        id:               result.insertId,
        booking_ref,
        total_amount,
        monthly_rent,
        security_deposit: property.security_deposit,
        commission:       commission_amt
      }
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

// GET /api/bookings/admin/all  (Admin)
router.get('/admin/all', authAdmin, async (req, res) => {
  try {
    const { status, page = 1, limit = 15 } = req.query;
    const offset = (page - 1) * limit;

    let where  = 'WHERE p.admin_id = ?';
    const params = [req.admin.id];

    if (status) { where += ' AND b.status = ?'; params.push(status); }

    const [bookings] = await pool.query(
      `SELECT
         b.id, b.booking_ref, b.check_in_date, b.duration_months,
         b.monthly_rent, b.total_amount, b.commission_amount,
         b.status, b.payment_status, b.created_at,
         u.full_name AS tenant_name, u.phone AS tenant_phone, u.email AS tenant_email,
         p.name AS property_name, r.room_type
       FROM bookings b
       JOIN users u      ON u.id = b.user_id
       JOIN properties p ON p.id = b.property_id
       JOIN rooms r      ON r.id = b.room_id
       ${where}
       ORDER BY b.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    res.json({ success: true, data: bookings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/bookings/my  (User)
router.get('/my', authUser, async (req, res) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    let where  = 'WHERE b.user_id = ?';
    const params = [req.user.id];

    if (status) { where += ' AND b.status = ?'; params.push(status); }

    const [bookings] = await pool.query(
      `SELECT
         b.id, b.booking_ref, b.check_in_date, b.duration_months,
         b.monthly_rent, b.total_amount, b.status, b.payment_status, b.created_at,
         p.name AS property_name, p.area, p.city, p.property_type,
         (SELECT image_url FROM property_images WHERE property_id = p.id AND is_primary = 1 LIMIT 1) AS image,
         r.room_type
       FROM bookings b
       JOIN properties p ON p.id = b.property_id
       JOIN rooms r      ON r.id = b.room_id
       ${where}
       ORDER BY b.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    res.json({ success: true, data: bookings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/bookings/:id  (User)
router.get('/:id', authUser, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
         b.*,
         p.name AS property_name, p.address, p.city, p.area, p.property_type,
         a.full_name AS owner_name, a.phone AS owner_phone,
         r.room_type, r.capacity
       FROM bookings b
       JOIN properties p ON p.id = b.property_id
       JOIN admins a     ON a.id = p.admin_id
       JOIN rooms r      ON r.id = b.room_id
       WHERE b.id = ? AND b.user_id = ?`,
      [req.params.id, req.user.id]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, message: 'Booking not found' });

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/bookings/:id/cancel  (User)
router.put('/:id/cancel', authUser, async (req, res) => {
  const { reason } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      'SELECT * FROM bookings WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    const booking = rows[0];
    if (['cancelled', 'checked_out'].includes(booking.status)) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Cannot cancel this booking' });
    }

    await conn.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = ? WHERE id = ?`,
      [reason || null, booking.id]
    );

    await conn.query('UPDATE rooms SET available = available + 1 WHERE id = ?', [booking.room_id]);
    await conn.query('UPDATE properties SET available_rooms = available_rooms + 1 WHERE id = ?', [booking.property_id]);

    await conn.commit();
    res.json({ success: true, message: 'Booking cancelled successfully' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

// PUT /api/bookings/admin/:id/status  (Admin)
router.put('/admin/:id/status', authAdmin, async (req, res) => {
  const { status } = req.body;
  const allowed = ['confirmed', 'checked_in', 'checked_out'];

  if (!allowed.includes(status))
    return res.status(400).json({ success: false, message: 'Invalid status value' });

  try {
    const [rows] = await pool.query(
      `SELECT b.id FROM bookings b
       JOIN properties p ON p.id = b.property_id
       WHERE b.id = ? AND p.admin_id = ?`,
      [req.params.id, req.admin.id]
    );

    if (!rows.length)
      return res.status(403).json({ success: false, message: 'Booking not found or access denied' });

    await pool.query('UPDATE bookings SET status = ? WHERE id = ?', [status, req.params.id]);
    res.json({ success: true, message: `Booking status updated to ${status}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
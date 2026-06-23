// routes/payments.js
const express          = require('express');
const pool             = require('../config/db');
const { authUser }     = require('../middleware/auth');

const router = express.Router();

// POST /api/payments/create-order
router.post('/create-order', authUser, async (req, res) => {
  const { booking_id } = req.body;
  try {
    const [rows] = await pool.query(
      'SELECT * FROM bookings WHERE id = ? AND user_id = ? AND payment_status = ?',
      [booking_id, req.user.id, 'unpaid']
    );
    if (!rows.length)
      return res.status(404).json({ success: false, message: 'Booking not found or already paid' });

    const booking = rows[0];

    // Mock order for development
    // Replace with real Razorpay when keys are ready:
    // const Razorpay = require('razorpay');
    // const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
    // const order = await razorpay.orders.create({ amount: booking.total_amount * 100, currency: 'INR', receipt: booking.booking_ref });

    const order = {
      id:       `order_dev_${Date.now()}`,
      amount:   booking.total_amount * 100,
      currency: 'INR'
    };

    await pool.query(
      `INSERT INTO payments (booking_id, user_id, amount, payment_type, payment_method, razorpay_order_id)
       VALUES (?, ?, ?, 'booking', 'upi', ?)
       ON DUPLICATE KEY UPDATE razorpay_order_id = VALUES(razorpay_order_id)`,
      [booking_id, req.user.id, booking.total_amount, order.id]
    );

    res.json({
      success:     true,
      order_id:    order.id,
      amount:      booking.total_amount,
      currency:    'INR',
      booking_ref: booking.booking_ref,
      key_id:      process.env.RAZORPAY_KEY_ID
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/payments/verify
router.post('/verify', authUser, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, booking_id } = req.body;

  try {
    // Uncomment in production for real signature verification:
    // const crypto = require('crypto');
    // const body = razorpay_order_id + '|' + razorpay_payment_id;
    // const expectedSig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');
    // if (expectedSig !== razorpay_signature)
    //   return res.status(400).json({ success: false, message: 'Payment verification failed' });

    const conn = await pool.getConnection();
    await conn.beginTransaction();
    try {
      await conn.query(
        `UPDATE payments SET
           razorpay_payment_id = ?, razorpay_signature = ?,
           status = 'success', paid_at = NOW()
         WHERE booking_id = ? AND razorpay_order_id = ?`,
        [razorpay_payment_id, razorpay_signature, booking_id, razorpay_order_id]
      );

      await conn.query(
        `UPDATE bookings SET status = 'confirmed', payment_status = 'paid' WHERE id = ?`,
        [booking_id]
      );

      await conn.query(
        `UPDATE commission_ledger SET status = 'pending' WHERE booking_id = ?`,
        [booking_id]
      );

      await conn.commit();
      res.json({ success: true, message: 'Payment verified! Booking confirmed.' });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/payments/my  (User — Payment History)
router.get('/my', authUser, async (req, res) => {
  try {
    const [payments] = await pool.query(
      `SELECT
         pay.id, pay.amount, pay.payment_type, pay.payment_method,
         pay.status, pay.paid_at, pay.created_at,
         b.booking_ref,
         p.name AS property_name
       FROM payments pay
       JOIN bookings b   ON b.id = pay.booking_id
       JOIN properties p ON p.id = b.property_id
       WHERE pay.user_id = ?
       ORDER BY pay.created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, data: payments });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
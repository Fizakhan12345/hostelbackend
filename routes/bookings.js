const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../config/db');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { sendBookingEnquiryEmails } = require('../utils/mailer');
const { sendBookingEnquiryMessages } = require('../utils/notifier');

const router = express.Router();

function generateBookingRef() {
  const year = new Date().getFullYear();
  const rand = Math.floor(10000 + Math.random() * 89999);
  return `HB-${year}-${rand}`;
}

// Finds an existing user by email/phone, or creates a lightweight one on
// the fly for guest enquiries. This keeps the `bookings.user_id NOT NULL`
// foreign key intact without forcing the visitor through a full signup —
// the account is unverified/inert until they ever bother logging in.
async function findOrCreateGuestUser(conn, { full_name, email, phone }) {
  const [[existing]] = await conn.query(
    'SELECT id, full_name, email, phone FROM users WHERE email = :email OR phone = :phone LIMIT 1',
    { email, phone }
  );
  if (existing) return existing;

  const randomPassword = crypto.randomBytes(16).toString('hex');
  const passwordHash = await bcrypt.hash(randomPassword, 10);

  const [result] = await conn.query(
    `INSERT INTO users (full_name, email, phone, password_hash, is_verified, is_active)
     VALUES (:full_name, :email, :phone, :password_hash, 0, 1)`,
    { full_name, email, phone, password_hash: passwordHash }
  );
  return { id: result.insertId, full_name, email, phone };
}

// POST /api/bookings — create a booking enquiry.
// Logged-in users: body needs { property_id, room_id, check_in_date, duration_months }.
// Guests (no auth token): body ALSO needs { full_name, email, phone, address, city } —
// captured from the "Book Now" dialog and included in every enquiry email.
router.post('/', optionalAuth, async (req, res, next) => {
  const {
    property_id, room_id, check_in_date, duration_months = 1,
    full_name, email, phone, address, city,
  } = req.body;

  if (!property_id || !room_id || !check_in_date) {
    return res.status(400).json({ success: false, message: 'property_id, room_id and check_in_date are required.' });
  }

  if (!req.user && (!full_name || !email || !phone)) {
    return res.status(400).json({
      success: false,
      message: 'Please share your name, email and phone number so the property owner can reach you.',
    });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Lock the room row so two simultaneous bookings can't both grab the
    // last bed — small critical section, keeps the API fast under load.
    const [[room]] = await conn.query(
      'SELECT * FROM rooms WHERE id = :room_id AND property_id = :property_id AND is_active = 1 FOR UPDATE',
      { room_id, property_id }
    );
    if (!room) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Room not found for this property.' });
    }
    if (room.available < 1) {
      await conn.rollback();
      return res.status(409).json({ success: false, message: 'No beds currently available in this room type.' });
    }

  const [[property]] = await conn.query(
  `SELECT p.*, a.full_name AS owner_name, a.email AS owner_email, a.phone AS owner_phone
   FROM properties p JOIN admins a ON a.id = p.admin_id
   WHERE p.id = :property_id AND p.is_active = 1`,
  { property_id }
);
    if (!property) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Property not found.' });
    }

    let user;
    if (req.user) {
      [[user]] = await conn.query('SELECT id, full_name, email, phone FROM users WHERE id = :id', { id: req.user.id });
    } else {
      user = await findOrCreateGuestUser(conn, { full_name, email, phone });
    }

    const months = Math.max(1, Number(duration_months));
    const monthlyRent = Number(room.price_per_bed);
    const securityDeposit = Number(property.security_deposit);
    const totalAmount = monthlyRent + securityDeposit; // first month + deposit due now
    const commissionRate = Number(process.env.DEFAULT_COMMISSION_RATE) || 5.0;
    const commissionAmount = Number(((monthlyRent * commissionRate) / 100).toFixed(2));
    const bookingRef = generateBookingRef();

    const [result] = await conn.query(
      `INSERT INTO bookings
         (booking_ref, user_id, property_id, room_id, check_in_date, duration_months,
          monthly_rent, security_deposit, total_amount, commission_rate, commission_amount,
          status, payment_status)
       VALUES
         (:booking_ref, :user_id, :property_id, :room_id, :check_in_date, :months,
          :monthly_rent, :security_deposit, :total_amount, :commission_rate, :commission_amount,
          'pending', 'unpaid')`,
      {
        booking_ref: bookingRef, user_id: user.id, property_id, room_id, check_in_date, months,
        monthly_rent: monthlyRent, security_deposit: securityDeposit, total_amount: totalAmount,
        commission_rate: commissionRate, commission_amount: commissionAmount,
      }
    );
    const bookingId = result.insertId;

    await conn.query('UPDATE rooms SET available = available - 1 WHERE id = :room_id', { room_id });

    await conn.query(
      `INSERT INTO commission_ledger (booking_id, property_id, admin_id, booking_amount, commission_rate, commission_amt, status)
       VALUES (:booking_id, :property_id, :admin_id, :booking_amount, :commission_rate, :commission_amt, 'draft')`,
      {
        booking_id: bookingId, property_id, admin_id: property.admin_id,
        booking_amount: totalAmount, commission_rate: commissionRate, commission_amt: commissionAmount,
      }
    );

    await conn.query(
      `INSERT INTO notifications (admin_id, type, title, message)
       VALUES (:admin_id, 'new_booking', 'New Booking Enquiry!', :message)`,
      {
        admin_id: property.admin_id,
        message: `New enquiry (${bookingRef}) for ${property.name} from ${user.full_name}.`,
      }
    );

    await conn.commit();

    // Respond immediately — booking is durable. Emails are sent right
    // after, without the client waiting on SMTP round-trips.
    res.status(201).json({
      success: true,
      message: 'Enquiry received! We will reach you within 2 hours.',
      data: {
        booking_id: bookingId,
        booking_ref: bookingRef,
        status: 'pending',
        monthly_rent: monthlyRent,
        security_deposit: securityDeposit,
        total_amount: totalAmount,
      },
    });

    sendBookingEnquiryEmails({
      booking: {
        booking_ref: bookingRef,
        check_in_date,
        duration_months: months,
        monthly_rent: monthlyRent,
        security_deposit: securityDeposit,
        total_amount: totalAmount,
      },
      property,
      room,
      user,
      // address/city are enquiry context only (not persisted on the users
      // table) — they're included in the email body as requested.
      address: address || null,
      city: city || null,
      ownerEmail: property.owner_email,
        ownerPhone: property.owner_phone,
    }).catch((err) => console.error('[bookings] email dispatch failed:', err.message));
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// GET /api/bookings/my — the logged-in user's booking history
router.get('/my', requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT b.*, p.name AS property_name, p.city, r.room_type,
              (SELECT image_url FROM property_images pi WHERE pi.property_id = p.id
                 ORDER BY pi.is_primary DESC LIMIT 1) AS image
       FROM bookings b
       JOIN properties p ON p.id = b.property_id
       JOIN rooms r ON r.id = b.room_id
       WHERE b.user_id = :uid
       ORDER BY b.created_at DESC`,
      { uid: req.user.id }
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
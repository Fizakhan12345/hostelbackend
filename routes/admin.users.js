// routes/admin.users.js  — mounted at /api/admin/users
//
//   GET   /api/admin/users              → all registered users (+ booking / saved counts)
//   PATCH /api/admin/users/:id/status   → { is_active: true|false }  activate / deactivate
const express = require('express');
const pool = require('../config/db');
const { requireAdmin } = require('../middleware/requireAdmin');

const router = express.Router();
router.use(requireAdmin);

// Never send these to the browser
function safeUser(u) {
  const { password_hash, otp_code, otp_expires, reset_token, reset_expires, ...safe } = u;
  return safe;
}

async function countBy(table, userIds) {
  const counts = new Map();
  if (!userIds.length) return counts;
  try {
    const [rows] = await pool.query(
      `SELECT user_id, COUNT(*) AS total FROM ${table} WHERE user_id IN (:ids) GROUP BY user_id`,
      { ids: userIds }
    );
    for (const r of rows) counts.set(Number(r.user_id), Number(r.total));
  } catch (_) {
    // table/column missing — just show 0
  }
  return counts;
}

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM users');

    // newest first, by created_at if present, otherwise by id
    rows.sort((a, b) => {
      if (a.created_at && b.created_at) return new Date(b.created_at) - new Date(a.created_at);
      return Number(b.id) - Number(a.id);
    });

    const ids = rows.map((u) => Number(u.id));
    const [bookings, favorites] = await Promise.all([countBy('bookings', ids), countBy('favorites', ids)]);

    const users = rows.map((u) => ({
      ...safeUser(u),
      bookings_count: bookings.get(Number(u.id)) || 0,
      favorites_count: favorites.get(Number(u.id)) || 0,
    }));

    res.json({ success: true, count: users.length, users });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/status', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ success: false, message: 'Invalid user id.' });
    }
    const isActive = req.body?.is_active ? 1 : 0;

    const [result] = await pool.query('UPDATE users SET is_active = :active WHERE id = :id', { active: isActive, id });
    if (!result.affectedRows) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    res.json({
      success: true,
      message: isActive ? 'User activated.' : 'User deactivated.',
      id,
      is_active: isActive,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

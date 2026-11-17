// routes/user.lists.js
// Logged-in user's own lists: saved hostels (favourites) + my bookings.
// Mounted at /api/me  — does NOT touch your existing /api/favorites or /api/bookings routes.
//
//   GET    /api/me/favorites/ids          → [3, 7, 12]  (just the property ids, for heart buttons)
//   GET    /api/me/favorites              → saved hostels with full property data
//   POST   /api/me/favorites/:propertyId  → save
//   DELETE /api/me/favorites/:propertyId  → unsave
//   GET    /api/me/bookings               → this user's bookings with property data

const express = require('express');
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ── Make sure the favorites table exists (no-op if you already have one) ──
let favTableReady = false;
async function ensureFavoritesTable() {
  if (favTableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS favorites (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      user_id     INT NOT NULL,
      property_id INT NOT NULL,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_user_property (user_id, property_id)
    )
  `);
  favTableReady = true;
}

// ── Load properties by id (+ images from property_images if that table exists) ──
async function loadProperties(ids) {
  const map = new Map();
  const uniqueIds = [...new Set(ids.map(Number).filter(Boolean))];
  if (!uniqueIds.length) return map;

  const [rows] = await pool.query('SELECT * FROM properties WHERE id IN (:ids)', { ids: uniqueIds });

  let images = [];
  try {
    const [imgRows] = await pool.query('SELECT * FROM property_images WHERE property_id IN (:ids)', { ids: uniqueIds });
    images = imgRows;
  } catch (_) {
    // property_images table doesn't exist — images come from the properties row instead
  }

  for (const p of rows) {
    map.set(Number(p.id), {
      ...p,
      gallery: images.filter((img) => Number(img.property_id) === Number(p.id)),
    });
  }
  return map;
}

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ═══════════════════════════════════════════
//  FAVOURITES
// ═══════════════════════════════════════════

router.get('/favorites/ids', async (req, res, next) => {
  try {
    await ensureFavoritesTable();
    const [rows] = await pool.query(
      'SELECT property_id FROM favorites WHERE user_id = :uid',
      { uid: req.user.id }
    );
    res.json({ success: true, ids: rows.map((r) => Number(r.property_id)) });
  } catch (err) {
    next(err);
  }
});

router.get('/favorites', async (req, res, next) => {
  try {
    await ensureFavoritesTable();
    // No ORDER BY on a specific column — your favorites table may not have id / created_at
    const [rows] = await pool.query(
      'SELECT * FROM favorites WHERE user_id = :uid',
      { uid: req.user.id }
    );

    // Newest first: by created_at if the column exists, otherwise reverse insert order
    const favs = rows.some((f) => f.created_at)
      ? [...rows].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      : [...rows].reverse();

    const props = await loadProperties(favs.map((f) => f.property_id));
    const favorites = favs
      .filter((f) => props.has(Number(f.property_id)))          // skip deleted hostels
      .map((f) => ({
        property_id: Number(f.property_id),
        saved_at: f.created_at || null,
        property: props.get(Number(f.property_id)),
      }));

    res.json({ success: true, count: favorites.length, favorites });
  } catch (err) {
    next(err);
  }
});

router.post('/favorites/:propertyId', async (req, res, next) => {
  try {
    const propertyId = parseId(req.params.propertyId);
    if (!propertyId) return res.status(400).json({ success: false, message: 'Invalid hostel id.' });

    await ensureFavoritesTable();

    const [[property]] = await pool.query('SELECT id FROM properties WHERE id = :id', { id: propertyId });
    if (!property) return res.status(404).json({ success: false, message: 'Hostel not found.' });

    const [[existing]] = await pool.query(
      'SELECT property_id FROM favorites WHERE user_id = :uid AND property_id = :pid LIMIT 1',
      { uid: req.user.id, pid: propertyId }
    );
    if (!existing) {
      await pool.query(
        'INSERT INTO favorites (user_id, property_id) VALUES (:uid, :pid)',
        { uid: req.user.id, pid: propertyId }
      );
    }

    res.status(201).json({ success: true, message: 'Hostel saved.', property_id: propertyId });
  } catch (err) {
    next(err);
  }
});

router.delete('/favorites/:propertyId', async (req, res, next) => {
  try {
    const propertyId = parseId(req.params.propertyId);
    if (!propertyId) return res.status(400).json({ success: false, message: 'Invalid hostel id.' });

    await ensureFavoritesTable();
    await pool.query(
      'DELETE FROM favorites WHERE user_id = :uid AND property_id = :pid',
      { uid: req.user.id, pid: propertyId }
    );
    res.json({ success: true, message: 'Removed from saved hostels.', property_id: propertyId });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════
//  MY BOOKINGS
// ═══════════════════════════════════════════

router.get('/bookings', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM bookings WHERE user_id = :uid',
      { uid: req.user.id }
    );

    // Newest first, using whichever column exists
    const bookings = [...rows].sort((a, b) => {
      if (a.created_at && b.created_at) return new Date(b.created_at) - new Date(a.created_at);
      if (a.id && b.id) return b.id - a.id;
      return 0;
    });

    const props = await loadProperties(bookings.map((b) => b.property_id));
    const result = bookings.map((b) => ({
      ...b,
      property: props.get(Number(b.property_id)) || null,
    }));

    res.json({ success: true, count: result.length, bookings: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
const express = require('express');
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Every route below requires a logged-in user — anonymous visitors
// get a 401 with a friendly message the frontend can use to trigger
// a "please log in to save favorites" prompt.
router.use(requireAuth);

// GET /api/favorites — the current user's saved properties
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.id, p.name, p.area, p.city, p.monthly_rent, p.avg_rating,
              (SELECT image_url FROM property_images pi WHERE pi.property_id = p.id
                 ORDER BY pi.is_primary DESC LIMIT 1) AS image
       FROM favorites f
       JOIN properties p ON p.id = f.property_id
       WHERE f.user_id = :uid AND p.is_active = 1
       ORDER BY f.created_at DESC`,
      { uid: req.user.id }
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/favorites/:propertyId — add to favorites (idempotent)
router.post('/:propertyId', async (req, res, next) => {
  try {
    const { propertyId } = req.params;
    const [[prop]] = await pool.query('SELECT id FROM properties WHERE id = :id AND is_active = 1', { id: propertyId });
    if (!prop) return res.status(404).json({ success: false, message: 'Property not found.' });

    await pool.query(
      'INSERT IGNORE INTO favorites (user_id, property_id) VALUES (:uid, :pid)',
      { uid: req.user.id, pid: propertyId }
    );
    res.json({ success: true, message: 'Added to favorites.' });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/favorites/:propertyId — remove from favorites
router.delete('/:propertyId', async (req, res, next) => {
  try {
    const { propertyId } = req.params;
    await pool.query(
      'DELETE FROM favorites WHERE user_id = :uid AND property_id = :pid',
      { uid: req.user.id, pid: propertyId }
    );
    res.json({ success: true, message: 'Removed from favorites.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

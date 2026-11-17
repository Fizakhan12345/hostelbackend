const express = require('express');
const pool = require('../config/db');

const router = express.Router();

// GET /api/cities — all active cities with a live property_count
// GET /api/cities?featured=1 — only the ones shown as "Popular" chips on home
router.get('/', async (req, res, next) => {
  try {
    const { featured } = req.query;
    const where = featured ? 'WHERE is_featured = 1' : '';
    const [rows] = await pool.query(
      `SELECT id, name, slug, state, banner_image_url, thumb_image_url,
              short_description, property_count
       FROM city_property_counts
       ${where}
       ORDER BY sort_order ASC, name ASC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

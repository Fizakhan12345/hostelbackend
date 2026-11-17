// routes/amenities.js
const express = require('express');
const pool    = require('../config/db');
const { authAdmin } = require('../middleware/auth');

const router = express.Router();

// ──────────────────────────────────────────────────────────
// GET /api/amenities  (Public)
// Returns a flat list of all amenities.
// Used in: property create/edit form (checkbox list), search filters
//
// Query params:
//   category      -> filter to a single category (e.g. ?category=security)
//   with_counts=1 -> also returns how many active properties use each amenity
// ──────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { category, with_counts } = req.query;

    let where  = [];
    let params = [];

    if (category) {
      where.push('a.category = ?');
      params.push(category);
    }

    const whereStr = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const query = with_counts
      ? `
        SELECT
          a.id, a.name, a.category,
          COUNT(DISTINCT CASE WHEN p.is_active = 1 THEN pa.property_id END) AS property_count
        FROM amenities a
        LEFT JOIN property_amenities pa ON pa.amenity_id = a.id
        LEFT JOIN properties p          ON p.id = pa.property_id
        ${whereStr}
        GROUP BY a.id
        ORDER BY a.category, a.name
      `
      : `
        SELECT a.id, a.name, a.category
        FROM amenities a
        ${whereStr}
        ORDER BY a.category, a.name
      `;

    const [amenities] = await pool.query(query, params);

    res.json({ success: true, data: amenities });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ──────────────────────────────────────────────────────────
// GET /api/amenities/grouped  (Public)
// Same data as above but grouped by category, e.g.:
// { connectivity: [...], comfort: [...], security: [...] }
// Handy for rendering amenities in labeled sections on the
// property form or property detail page.
// ──────────────────────────────────────────────────────────
router.get('/grouped', async (req, res) => {
  try {
    const [amenities] = await pool.query(
      `SELECT id, name, category
       FROM amenities
       ORDER BY category, name`
    );

    const grouped = amenities.reduce((acc, a) => {
      const key = a.category || 'other';
      if (!acc[key]) acc[key] = [];
      acc[key].push({ id: a.id, name: a.name });
      return acc;
    }, {});

    res.json({ success: true, data: grouped });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ──────────────────────────────────────────────────────────
// GET /api/amenities/:id  (Public)
// Single amenity lookup, plus a small sample of properties
// that offer it (useful for an admin "who uses this?" view).
// ──────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, category FROM amenities WHERE id = ?',
      [req.params.id]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, message: 'Amenity not found' });

    const [properties] = await pool.query(
      `SELECT p.id, p.name, p.city, p.area
       FROM properties p
       JOIN property_amenities pa ON pa.property_id = p.id
       WHERE pa.amenity_id = ? AND p.is_active = 1
       LIMIT 20`,
      [req.params.id]
    );

    res.json({
      success: true,
      data: { ...rows[0], properties }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ──────────────────────────────────────────────────────────
// POST /api/amenities  (Admin — Create)
// Lets an approved admin add a new amenity to the master list
// (e.g. a facility not yet covered by the seeded set).
// ──────────────────────────────────────────────────────────
router.post('/', authAdmin, async (req, res) => {
  const { name, category } = req.body;

  if (!name)
    return res.status(400).json({ success: false, message: 'Amenity name is required' });

  try {
    const [existing] = await pool.query(
      'SELECT id FROM amenities WHERE name = ?',
      [name]
    );
    if (existing.length)
      return res.status(409).json({ success: false, message: 'Amenity already exists' });

    const [result] = await pool.query(
      'INSERT INTO amenities (name, category) VALUES (?, ?)',
      [name, category || null]
    );

    res.status(201).json({
      success:     true,
      message:     'Amenity created successfully',
      amenity_id:  result.insertId
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ──────────────────────────────────────────────────────────
// PUT /api/amenities/:id  (Admin — Update)
// ──────────────────────────────────────────────────────────
router.put('/:id', authAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id FROM amenities WHERE id = ?', [req.params.id]);
    if (!rows.length)
      return res.status(404).json({ success: false, message: 'Amenity not found' });

    const { name, category } = req.body;

    await pool.query(
      `UPDATE amenities SET
         name     = COALESCE(?, name),
         category = COALESCE(?, category)
       WHERE id = ?`,
      [name, category, req.params.id]
    );

    res.json({ success: true, message: 'Amenity updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ──────────────────────────────────────────────────────────
// DELETE /api/amenities/:id  (Admin — Delete)
// Blocked if any property still references it, so you don't
// silently orphan property_amenities rows or break listings.
// ──────────────────────────────────────────────────────────
router.delete('/:id', authAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id FROM amenities WHERE id = ?', [req.params.id]);
    if (!rows.length)
      return res.status(404).json({ success: false, message: 'Amenity not found' });

    const [[{ count }]] = await pool.query(
      'SELECT COUNT(*) AS count FROM property_amenities WHERE amenity_id = ?',
      [req.params.id]
    );

    if (count > 0)
      return res.status(409).json({
        success: false,
        message: `Cannot delete — ${count} propert${count === 1 ? 'y' : 'ies'} still use this amenity`
      });

    await pool.query('DELETE FROM amenities WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Amenity deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
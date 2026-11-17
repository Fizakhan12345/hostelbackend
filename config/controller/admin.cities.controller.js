// controllers/admin.cities.controller.js
// Admin CRUD for cities. Mount behind your existing `verifyAdmin`
// middleware (the same one auth.admin.js / middleware/auth.js already export).

const db = require('../db');

function slugify(text) {
  return text
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// POST /api/admin/cities
async function createCity(req, res) {
  try {
    const {
      name, state, banner_image_url, thumb_image_url,
      short_description, is_featured = 0, sort_order = 0,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'City name is required' });
    }

    const slug = slugify(name);

    const [existing] = await db.query(
      'SELECT id FROM cities WHERE name = ? OR slug = ?', [name, slug]
    );
    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: 'City already exists' });
    }

    const [result] = await db.query(
      `INSERT INTO cities
        (name, slug, state, banner_image_url, thumb_image_url, short_description, is_featured, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [name.trim(), slug, state || null, banner_image_url || null,
       thumb_image_url || null, short_description || null, is_featured ? 1 : 0, sort_order]
    );

    res.status(201).json({ success: true, id: result.insertId, slug });
  } catch (err) {
    console.error('createCity error:', err);
    res.status(500).json({ success: false, message: 'Failed to create city' });
  }
}

// PUT /api/admin/cities/:id
async function updateCity(req, res) {
  try {
    const { id } = req.params;
    const {
      name, state, banner_image_url, thumb_image_url,
      short_description, is_active, is_featured, sort_order,
    } = req.body;

    const fields = [];
    const params = [];

    const set = (col, val) => { fields.push(`${col} = ?`); params.push(val); };

    if (name !== undefined) { set('name', name); set('slug', slugify(name)); }
    if (state !== undefined) set('state', state);
    if (banner_image_url !== undefined) set('banner_image_url', banner_image_url);
    if (thumb_image_url !== undefined) set('thumb_image_url', thumb_image_url);
    if (short_description !== undefined) set('short_description', short_description);
    if (is_active !== undefined) set('is_active', is_active ? 1 : 0);
    if (is_featured !== undefined) set('is_featured', is_featured ? 1 : 0);
    if (sort_order !== undefined) set('sort_order', sort_order);

    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: 'Nothing to update' });
    }

    params.push(id);
    const [result] = await db.query(
      `UPDATE cities SET ${fields.join(', ')} WHERE id = ?`, params
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'City not found' });
    }

    res.json({ success: true, message: 'City updated' });
  } catch (err) {
    console.error('updateCity error:', err);
    res.status(500).json({ success: false, message: 'Failed to update city' });
  }
}

// DELETE /api/admin/cities/:id  (soft delete — keeps FK integrity with properties)
async function deleteCity(req, res) {
  try {
    const { id } = req.params;
    const [result] = await db.query(
      'UPDATE cities SET is_active = 0 WHERE id = ?', [id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'City not found' });
    }
    res.json({ success: true, message: 'City deactivated' });
  } catch (err) {
    console.error('deleteCity error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete city' });
  }
}

// GET /api/admin/cities  (includes inactive ones, for the admin table view)
async function listAllCitiesAdmin(req, res) {
  try {
    const [rows] = await db.query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM properties p WHERE p.city_id = c.id) AS property_count
       FROM cities c
       ORDER BY c.sort_order ASC, c.name ASC`
    );
    res.json({ success: true, cities: rows });
  } catch (err) {
    console.error('listAllCitiesAdmin error:', err);
    res.status(500).json({ success: false, message: 'Failed to load cities' });
  }
}

module.exports = { createCity, updateCity, deleteCity, listAllCitiesAdmin };
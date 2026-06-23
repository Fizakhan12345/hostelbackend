// routes/properties.js
const express              = require('express');
const pool                 = require('../config/db');
const { authAdmin, authUser } = require('../middleware/auth');

const router = express.Router();

// GET /api/properties  (Public — Search & Filter)
router.get('/', async (req, res) => {
  try {
    const {
      area, city, type, gender,
      min_rent, max_rent, amenities,
      is_featured, page = 1, limit = 12,
      sort = 'created_at', order = 'DESC'
    } = req.query;

    let where  = ['p.is_active = 1'];
    let params = [];

    if (city)        { where.push('p.city = ?');               params.push(city); }
    if (area)        { where.push('p.area LIKE ?');             params.push(`%${area}%`); }
    if (type)        { where.push('p.property_type = ?');       params.push(type); }
    if (gender)      { where.push('p.gender_allowed IN (?,?)'); params.push(gender, 'both'); }
    if (min_rent)    { where.push('p.monthly_rent >= ?');       params.push(min_rent); }
    if (max_rent)    { where.push('p.monthly_rent <= ?');       params.push(max_rent); }
    if (is_featured) { where.push('p.is_featured = 1'); }

    const allowedSorts  = ['monthly_rent', 'avg_rating', 'created_at', 'views_count'];
    const allowedOrders = ['ASC', 'DESC'];
    const safeSort  = allowedSorts.includes(sort)            ? sort            : 'created_at';
    const safeOrder = allowedOrders.includes(order.toUpperCase()) ? order.toUpperCase() : 'DESC';

    const offset   = (parseInt(page) - 1) * parseInt(limit);
    const whereStr = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const query = `
      SELECT
        p.id, p.name, p.property_type, p.gender_allowed,
        p.area, p.city, p.monthly_rent, p.security_deposit,
        p.available_rooms, p.total_rooms, p.avg_rating, p.total_reviews,
        p.is_verified, p.is_featured, p.created_at,
        (SELECT image_url FROM property_images
         WHERE property_id = p.id AND is_primary = 1 LIMIT 1) AS primary_image,
        GROUP_CONCAT(DISTINCT am.name SEPARATOR ',') AS amenity_names
      FROM properties p
      LEFT JOIN property_amenities pa2 ON pa2.property_id = p.id
      LEFT JOIN amenities am           ON am.id = pa2.amenity_id
      ${whereStr}
      GROUP BY p.id
      ORDER BY p.${safeSort} ${safeOrder}
      LIMIT ? OFFSET ?
    `;

    const [properties] = await pool.query(query, [...params, parseInt(limit), offset]);

    const [[countResult]] = await pool.query(
      `SELECT COUNT(DISTINCT p.id) AS total FROM properties p ${whereStr}`,
      params
    );

    res.json({
      success: true,
      data: properties.map(p => ({
        ...p,
        amenity_names: p.amenity_names ? p.amenity_names.split(',') : []
      })),
      pagination: {
        total:       countResult.total,
        page:        parseInt(page),
        limit:       parseInt(limit),
        total_pages: Math.ceil(countResult.total / limit)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/properties/admin/my-properties
router.get('/admin/my-properties', authAdmin, async (req, res) => {
  try {
    const [properties] = await pool.query(
      `SELECT
         p.*,
         (SELECT image_url FROM property_images WHERE property_id = p.id AND is_primary = 1 LIMIT 1) AS primary_image,
         COUNT(DISTINCT b.id) AS total_bookings,
         SUM(CASE WHEN b.status = 'confirmed' THEN 1 ELSE 0 END) AS active_bookings
       FROM properties p
       LEFT JOIN bookings b ON b.property_id = p.id
       WHERE p.admin_id = ?
       GROUP BY p.id
       ORDER BY p.created_at DESC`,
      [req.admin.id]
    );
    res.json({ success: true, data: properties });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/properties/:id  (Public — Single)
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
         p.*,
         a.full_name AS admin_name, a.phone AS admin_phone,
         GROUP_CONCAT(DISTINCT am.name SEPARATOR '|') AS amenities
       FROM properties p
       JOIN admins a ON a.id = p.admin_id
       LEFT JOIN property_amenities pa ON pa.property_id = p.id
       LEFT JOIN amenities am          ON am.id = pa.amenity_id
       WHERE p.id = ? AND p.is_active = 1
       GROUP BY p.id`,
      [req.params.id]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, message: 'Property not found' });

    const [images]  = await pool.query('SELECT * FROM property_images WHERE property_id = ? ORDER BY sort_order', [req.params.id]);
    const [rooms]   = await pool.query('SELECT * FROM rooms WHERE property_id = ? AND is_active = 1', [req.params.id]);
    const [reviews] = await pool.query(
      `SELECT r.*, u.full_name, u.profile_pic
       FROM reviews r JOIN users u ON u.id = r.user_id
       WHERE r.property_id = ? AND r.is_approved = 1
       ORDER BY r.created_at DESC LIMIT 10`,
      [req.params.id]
    );

    await pool.query('UPDATE properties SET views_count = views_count + 1 WHERE id = ?', [req.params.id]);

    const property = rows[0];
    res.json({
      success: true,
      data: {
        ...property,
        amenities: property.amenities ? property.amenities.split('|') : [],
        images, rooms, reviews
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/properties  (Admin — Create)
router.post('/', authAdmin, async (req, res) => {
  const {
    name, description, property_type, gender_allowed,
    address, area, city, state, pincode,
    latitude, longitude, total_rooms,
    monthly_rent, security_deposit, amenity_ids
  } = req.body;

  if (!name || !property_type || !address || !monthly_rent)
    return res.status(400).json({ success: false, message: 'Required fields missing' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.query(
      `INSERT INTO properties
         (admin_id, name, description, property_type, gender_allowed,
          address, area, city, state, pincode, latitude, longitude,
          total_rooms, available_rooms, monthly_rent, security_deposit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.admin.id, name, description || null, property_type, gender_allowed || 'both',
        address, area || '', city || 'Mumbai', state || 'Maharashtra', pincode || '',
        latitude || null, longitude || null,
        total_rooms || 1, total_rooms || 1, monthly_rent, security_deposit || 0
      ]
    );

    const propId = result.insertId;

    if (amenity_ids && amenity_ids.length) {
      const amenRows = amenity_ids.map(aid => [propId, aid]);
      await conn.query('INSERT INTO property_amenities (property_id, amenity_id) VALUES ?', [amenRows]);
    }

    await conn.commit();
    res.status(201).json({
      success:     true,
      message:     'Property created! It will be visible after verification.',
      property_id: propId
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

// PUT /api/properties/:id  (Admin — Update)
router.put('/:id', authAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id FROM properties WHERE id = ? AND admin_id = ?',
      [req.params.id, req.admin.id]
    );
    if (!rows.length)
      return res.status(403).json({ success: false, message: 'Property not found or access denied' });

    const {
      name, description, property_type, gender_allowed,
      address, area, city, pincode,
      monthly_rent, security_deposit, total_rooms, amenity_ids
    } = req.body;

    await pool.query(
      `UPDATE properties SET
         name             = COALESCE(?, name),
         description      = COALESCE(?, description),
         property_type    = COALESCE(?, property_type),
         gender_allowed   = COALESCE(?, gender_allowed),
         address          = COALESCE(?, address),
         area             = COALESCE(?, area),
         city             = COALESCE(?, city),
         pincode          = COALESCE(?, pincode),
         monthly_rent     = COALESCE(?, monthly_rent),
         security_deposit = COALESCE(?, security_deposit),
         total_rooms      = COALESCE(?, total_rooms)
       WHERE id = ?`,
      [
        name, description, property_type, gender_allowed,
        address, area, city, pincode,
        monthly_rent, security_deposit, total_rooms,
        req.params.id
      ]
    );

    if (amenity_ids) {
      await pool.query('DELETE FROM property_amenities WHERE property_id = ?', [req.params.id]);
      if (amenity_ids.length) {
        const amenRows = amenity_ids.map(aid => [req.params.id, aid]);
        await pool.query('INSERT INTO property_amenities (property_id, amenity_id) VALUES ?', [amenRows]);
      }
    }

    res.json({ success: true, message: 'Property updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/properties/:id  (Admin — Soft Delete)
router.delete('/:id', authAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id FROM properties WHERE id = ? AND admin_id = ?',
      [req.params.id, req.admin.id]
    );
    if (!rows.length)
      return res.status(403).json({ success: false, message: 'Property not found or access denied' });

    await pool.query('UPDATE properties SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Property removed successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
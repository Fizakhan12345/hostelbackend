const express = require('express');
const pool = require('../config/db');
const { optionalAuth } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/properties ─────────────────────────────────────
// List + filter + search. Powers the "View All Properties" page.
// Query params: city, gender (male|female|both), type (hostel|pg|apartment|room),
// minPrice, maxPrice, q (search text), page, limit, sort (price_asc|price_desc|rating)
router.get('/', async (req, res, next) => {
  try {
    const {
      city, gender, type, minPrice, maxPrice, q,
      page = 1, limit = 12, sort = 'featured',
    } = req.query;

    const where = ['p.is_active = 1'];
    const params = {};

    if (city) { where.push('p.city = :city'); params.city = city; }
    if (gender && gender !== 'all') { where.push("(p.gender_allowed = :gender OR p.gender_allowed = 'both')"); params.gender = gender; }
    if (type && type !== 'all') { where.push('p.property_type = :type'); params.type = type; }
    if (minPrice) { where.push('p.monthly_rent >= :minPrice'); params.minPrice = Number(minPrice); }
    if (maxPrice) { where.push('p.monthly_rent <= :maxPrice'); params.maxPrice = Number(maxPrice); }
    if (q) {
      where.push('(p.name LIKE :q OR p.area LIKE :q OR p.city LIKE :q)');
      params.q = `%${q}%`;
    }

    const sortMap = {
      price_asc: 'p.monthly_rent ASC',
      price_desc: 'p.monthly_rent DESC',
      rating: 'p.avg_rating DESC',
      featured: 'p.is_featured DESC, p.avg_rating DESC',
    };
    const orderBy = sortMap[sort] || sortMap.featured;

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(50, Math.max(1, Number(limit)));
    const offset = (pageNum - 1) * limitNum;

    const whereSql = where.join(' AND ');

    const [rows] = await pool.query(
      `SELECT
         p.id, p.name, p.property_type, p.gender_allowed, p.area, p.city, p.state,
         p.monthly_rent, p.avg_rating, p.total_reviews, p.is_verified, p.is_featured,
         (SELECT image_url FROM property_images pi WHERE pi.property_id = p.id
            ORDER BY pi.is_primary DESC, pi.sort_order ASC LIMIT 1) AS image,
         (SELECT GROUP_CONCAT(a.name SEPARATOR ',') FROM property_amenities pa
            JOIN amenities a ON a.id = pa.amenity_id WHERE pa.property_id = p.id) AS amenities
       FROM properties p
       WHERE ${whereSql}
       ORDER BY ${orderBy}
       LIMIT :limitNum OFFSET :offset`,
      { ...params, limitNum, offset }
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM properties p WHERE ${whereSql}`,
      params
    );

    const data = rows.map((r) => ({
      ...r,
      amenities: r.amenities ? r.amenities.split(',') : [],
    }));

    res.json({
      success: true,
      data,
      pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/properties/:id ─────────────────────────────────
// Full detail page: images, amenities, rooms, latest approved reviews,
// owner contact (for booking emails), and whether the current user
// (if logged in) has favorited it.
router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    const [[property]] = await pool.query(
      `SELECT p.*, a.full_name AS owner_name, a.email AS owner_email, a.phone AS owner_phone
       FROM properties p
       JOIN admins a ON a.id = p.admin_id
       WHERE p.id = :id AND p.is_active = 1`,
      { id }
    );

    if (!property) {
      return res.status(404).json({ success: false, message: 'Property not found.' });
    }

    const [images] = await pool.query(
      `SELECT id, image_url, is_primary FROM property_images
       WHERE property_id = :id ORDER BY is_primary DESC, sort_order ASC`,
      { id }
    );

    const [amenities] = await pool.query(
      `SELECT a.id, a.name, a.category FROM property_amenities pa
       JOIN amenities a ON a.id = pa.amenity_id WHERE pa.property_id = :id`,
      { id }
    );

    const [rooms] = await pool.query(
      `SELECT id, room_type, capacity, available, price_per_bed, daily_rate
       FROM rooms WHERE property_id = :id AND is_active = 1`,
      { id }
    );

    const [reviews] = await pool.query(
      `SELECT r.id, r.rating, r.title, r.comment, r.created_at, u.full_name
       FROM reviews r JOIN users u ON u.id = r.user_id
       WHERE r.property_id = :id AND r.is_approved = 1
       ORDER BY r.created_at DESC LIMIT 10`,
      { id }
    );

    let isFavorited = false;
    if (req.user) {
      const [[fav]] = await pool.query(
        'SELECT 1 AS x FROM favorites WHERE user_id = :uid AND property_id = :id',
        { uid: req.user.id, id }
      );
      isFavorited = !!fav;
    }

    // Fire-and-forget view counter — never blocks the response.
    pool.query('UPDATE properties SET views_count = views_count + 1 WHERE id = :id', { id }).catch(() => {});

    // Don't leak the owner's contact directly to the client — it's only
    // used server-side when a booking enquiry is created.
    const { owner_email, owner_phone, ...publicProperty } = property;

    res.json({
      success: true,
      data: {
        ...publicProperty,
        images,
        amenities,
        rooms,
        reviews,
        is_favorited: isFavorited,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

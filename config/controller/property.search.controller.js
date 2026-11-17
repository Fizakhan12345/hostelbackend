// config/controller/property-search.controller.js
const db = require('../db'); // same pattern as cities.controller.js

/**
 * GET /api/properties/search
 * Powers the Find Hostel page's Monthly Rent / Daily Rent tabs.
 *
 * Query params:
 *   rentType      'monthly' (default) | 'daily'
 *   citySlug      e.g. 'mumbai' — matches cities.slug
 *   propertyType  'hostel' | 'pg' | 'apartment' | 'room'
 *   genderAllowed 'male' | 'female'
 *   minPrice      number — filters against the relevant room price column
 *   maxPrice      number
 *   sort          'newest' (default) | 'price_low' | 'price_high' | 'rating'
 *   page          default 1
 *   limit         default 12
 *
 * For rentType=daily, only properties with rent_type IN ('daily','both')
 * AND at least one room with a non-null daily_rate are returned.
 * For rentType=monthly, only properties with rent_type IN ('monthly','both')
 * are returned (price_per_bed is always set, so no extra null check needed).
 */
async function searchProperties(req, res) {
  try {
    const {
      rentType = 'monthly',
      citySlug,
      propertyType,
      genderAllowed,
      minPrice,
      maxPrice,
      sort = 'newest',
      page = 1,
      limit = 12,
    } = req.query;

    const isDaily = rentType === 'daily';
    const priceColumn = isDaily ? 'r.daily_rate' : 'r.price_per_bed';

    const where = ['p.is_active = 1', 'r.is_active = 1'];
    const params = [];

    if (isDaily) {
      where.push("p.rent_type IN ('daily','both')");
      where.push('r.daily_rate IS NOT NULL');
    } else {
      where.push("p.rent_type IN ('monthly','both')");
    }

    if (citySlug) {
      where.push('p.city_id = (SELECT id FROM cities WHERE slug = ? LIMIT 1)');
      params.push(citySlug);
    }
    if (propertyType) {
      where.push('p.property_type = ?');
      params.push(propertyType);
    }
    if (genderAllowed) {
      where.push("(p.gender_allowed = ? OR p.gender_allowed = 'both')");
      params.push(genderAllowed);
    }
    if (minPrice) {
      where.push(`${priceColumn} >= ?`);
      params.push(Number(minPrice));
    }
    if (maxPrice) {
      where.push(`${priceColumn} <= ?`);
      params.push(Number(maxPrice));
    }

    const sortMap = {
      newest: 'p.created_at DESC',
      price_low: 'starting_price ASC',
      price_high: 'starting_price DESC',
      rating: 'p.avg_rating DESC',
    };
    const orderBy = sortMap[sort] || sortMap.newest;

    const offset = (Number(page) - 1) * Number(limit);

    const dataSql = `
      SELECT
        p.id, p.name, p.property_type, p.gender_allowed, p.rent_type,
        p.area, p.city, p.avg_rating, p.total_reviews, p.is_verified,
        MIN(${priceColumn}) AS starting_price,
        (SELECT image_url FROM property_images
          WHERE property_id = p.id
          ORDER BY is_primary DESC, sort_order ASC LIMIT 1) AS primary_image
      FROM properties p
      JOIN rooms r ON r.property_id = p.id
      WHERE ${where.join(' AND ')}
      GROUP BY p.id
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `;

    const [properties] = await db.query(dataSql, [...params, Number(limit), offset]);

    // Count distinct matching properties for pagination
    const countSql = `
      SELECT COUNT(DISTINCT p.id) AS total
      FROM properties p
      JOIN rooms r ON r.property_id = p.id
      WHERE ${where.join(' AND ')}
    `;
    const [[{ total }]] = await db.query(countSql, params);

    res.json({
      success: true,
      rentType: isDaily ? 'daily' : 'monthly',
      priceUnit: isDaily ? 'day' : 'month',
      properties,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    console.error('searchProperties error:', err);
    res.status(500).json({ success: false, message: 'Search failed' });
  }
}

module.exports = { searchProperties };
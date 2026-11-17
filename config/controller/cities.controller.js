const db = require('../db');

/**
 * GET /api/cities
 * Used for: navbar "Cities" dropdown + homepage "Popular" chips.
 * Query params:
 *   featured=1   -> only featured cities (for the homepage chips)
 */
async function listCities(req, res) {
  try {
    const { featured } = req.query;

    let sql = `
      SELECT id, name, slug, state, thumb_image_url, banner_image_url,
             short_description, is_featured, sort_order, property_count
      FROM city_property_counts
    `;
    const params = [];

    if (featured === '1') {
      sql += ' WHERE is_featured = 1';
    }

    sql += ' ORDER BY sort_order ASC, name ASC';

    const [rows] = await db.query(sql, params);
    res.json({ success: true, cities: rows });
  } catch (err) {
    console.error('listCities error:', err);
    res.status(500).json({ success: false, message: 'Failed to load cities' });
  }
}

/**
 * GET /api/cities/:slug
 * City landing page — city info + paginated list of properties in it.
 * Used for: /cities/:slug dynamic route in Angular.
 * Query params: page, limit, propertyType, genderAllowed, minRent, maxRent, sort
 */
async function getCityBySlug(req, res) {
  try {
    const { slug } = req.params;
    const {
      page = 1,
      limit = 12,
      propertyType,
      genderAllowed,
      minRent,
      maxRent,
      sort = 'newest',
    } = req.query;

    const [cityRows] = await db.query(
      `SELECT id, name, slug, state, banner_image_url, thumb_image_url,
              short_description, property_count
       FROM city_property_counts WHERE slug = ?`,
      [slug]
    );

    if (cityRows.length === 0) {
      return res.status(404).json({ success: false, message: 'City not found' });
    }
    const city = cityRows[0];

    const where = ['p.city_id = ?', 'p.is_active = 1'];
    const params = [city.id];

    if (propertyType) {
      where.push('p.property_type = ?');
      params.push(propertyType);
    }
    if (genderAllowed) {
      where.push('(p.gender_allowed = ? OR p.gender_allowed = "both")');
      params.push(genderAllowed);
    }
    if (minRent) {
      where.push('p.monthly_rent >= ?');
      params.push(Number(minRent));
    }
    if (maxRent) {
      where.push('p.monthly_rent <= ?');
      params.push(Number(maxRent));
    }

    const sortMap = {
      newest: 'p.created_at DESC',
      rent_low: 'p.monthly_rent ASC',
      rent_high: 'p.monthly_rent DESC',
      rating: 'p.avg_rating DESC',
    };
    const orderBy = sortMap[sort] || sortMap.newest;

    const offset = (Number(page) - 1) * Number(limit);

    const [properties] = await db.query(
      `SELECT p.id, p.name, p.property_type, p.gender_allowed, p.area, p.city,
              p.monthly_rent, p.security_deposit, p.avg_rating, p.total_reviews,
              p.is_verified, p.is_featured,
              (SELECT image_url FROM property_images
                WHERE property_id = p.id
                ORDER BY is_primary DESC, sort_order ASC LIMIT 1) AS primary_image
       FROM properties p
       WHERE ${where.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM properties p WHERE ${where.join(' AND ')}`,
      params
    );

    res.json({
      success: true,
      city,
      properties,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    console.error('getCityBySlug error:', err);
    res.status(500).json({ success: false, message: 'Failed to load city' });
  }
}

module.exports = { listCities, getCityBySlug };
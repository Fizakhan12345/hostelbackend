// routes/home.js — public listing data, mounted at /api/home
//
//   GET /api/home/featured?limit=6     home page cards (approved first, hidden excluded)
//   GET /api/home/properties           every live listing, for the Properties page
//   GET /api/home/cities               cities with how many listings each has
//
// Reads your real columns at runtime, so it works with your existing tables.

const express = require('express');
const pool = require('../config/db');

const router = express.Router();

// ── helpers ───────────────────────────────────────────────
const colCache = {};
async function columns(table) {
  if (!colCache[table]) {
    try {
      const [cols] = await pool.query(`SHOW COLUMNS FROM \`${table}\``);
      colCache[table] = cols.map((c) => c.Field);
    } catch (_) {
      colCache[table] = [];
    }
  }
  return colCache[table];
}

async function safeQuery(sql, params) {
  try {
    const [rows] = await pool.query(sql, params);
    return rows;
  } catch (_) {
    return [];
  }
}

function pretty(v) {
  if (!v) return '';
  const s = String(v).replace(/[_-]/g, ' ');
  if (s.toLowerCase() === 'pg') return 'PG';
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function genderLabel(v) {
  const g = String(v || '').toLowerCase();
  if (/female|girl|women|ladies/.test(g)) return 'Girls';
  if (/male|boy|men|gents/.test(g)) return 'Boys';
  if (/unisex|co.?ed|any|both|all/.test(g)) return 'Unisex';
  return pretty(v);
}

const FACILITY_LABELS = {
  wifi: 'WiFi', ac: 'AC', power_backup: 'Power backup', laundry: 'Laundry', housekeeping: 'Housekeeping',
  gym: 'Gym', parking: 'Parking', cctv: 'CCTV', security_guard: 'Security', attached_bathroom: 'Attached bath',
  hot_water: 'Hot water', ro_water: 'RO water', lift: 'Lift', tv: 'TV', study_table: 'Study table',
  wardrobe: 'Wardrobe', fridge: 'Fridge', biometric: 'Biometric entry',
};

function parseJson(v) {
  if (!v) return null;
  try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; }
}

/** Live listings, approved first, newest next. */
async function loadProperties(limit) {
  const pc = await columns('properties');
  const cc = await columns('cities');
  const where = pc.includes('is_active') ? 'WHERE p.is_active = 1' : '';
  const order = [
    pc.includes('is_verified') ? 'p.is_verified DESC' : null,
    pc.includes('created_at') ? 'p.created_at DESC' : 'p.id DESC',
  ].filter(Boolean).join(', ');
  const cityJoin = !pc.includes('city') && pc.includes('city_id') && cc.length;
  const cityName = cc.includes('name') ? 'name' : 'city_name';
  const ownerCol = pc.includes('admin_id') ? 'admin_id' : pc.includes('owner_id') ? 'owner_id' : null;
  const ownerJoin = ownerCol && (await columns('admins')).length;

  const rows = await safeQuery(
    `SELECT p.*
            ${cityJoin ? `, c.\`${cityName}\` AS joined_city` : ''}
            ${ownerJoin ? ', a.full_name AS owner_name, a.profile_pic AS owner_pic' : ''}
       FROM properties p
       ${cityJoin ? 'LEFT JOIN cities c ON c.id = p.city_id' : ''}
       ${ownerJoin ? `LEFT JOIN admins a ON a.id = p.\`${ownerCol}\`` : ''}
       ${where}
      ORDER BY ${order}
      LIMIT ${limit}`
  );
  // admins table may have no profile_pic column → retry without it
  if (!rows.length && ownerJoin) {
    return safeQuery(
      `SELECT p.* ${cityJoin ? `, c.\`${cityName}\` AS joined_city` : ''}, a.full_name AS owner_name
         FROM properties p
         ${cityJoin ? 'LEFT JOIN cities c ON c.id = p.city_id' : ''}
         LEFT JOIN admins a ON a.id = p.\`${ownerCol}\`
         ${where} ORDER BY ${order} LIMIT ${limit}`
    );
  }
  return rows;
}

/** Turns raw rows into the card objects both pages use. */
async function toCards(props) {
  if (!props.length) return [];
  const pc = await columns('properties');
  const ids = props.map((p) => p.id);

  // photos (cover first)
  const gallery = new Map();
  const push = (pid, url, cover) => {
    if (!url) return;
    const list = gallery.get(pid) || [];
    if (list.includes(url)) return;
    cover ? list.unshift(url) : list.push(url);
    gallery.set(pid, list);
  };
  for (const r of await safeQuery('SELECT * FROM property_images WHERE property_id IN (:ids)', { ids })) {
    push(r.property_id, r.image_url || r.url || r.path, !!r.is_primary);
  }
  for (const r of await safeQuery('SELECT property_id, url, is_cover FROM property_photos WHERE property_id IN (:ids) ORDER BY sort_order', { ids })) {
    push(r.property_id, r.url, false);
  }

  // rooms
  const rooms = new Map();
  const roomsTable = (await columns('rooms')).length ? 'rooms' : (await columns('property_rooms')).length ? 'property_rooms' : null;
  if (roomsTable) {
    const rc = await columns(roomsTable);
    const priceCol = ['price_per_bed', 'price', 'rent', 'monthly_rent'].find((c) => rc.includes(c));
    const availCol = ['available', 'available_beds', 'beds_available'].find((c) => rc.includes(c));
    const typeCol = ['room_type', 'type', 'name'].find((c) => rc.includes(c));
    for (const r of await safeQuery(`SELECT * FROM \`${roomsTable}\` WHERE property_id IN (:ids)`, { ids })) {
      const cur = rooms.get(r.property_id) || { count: 0, beds: 0, min: 0, types: [], ac: false };
      cur.count += 1;
      cur.beds += Number(availCol ? r[availCol] : 0) || 0;
      const price = Number(priceCol ? r[priceCol] : 0) || 0;
      if (price && (!cur.min || price < cur.min)) cur.min = price;
      if (typeCol && r[typeCol]) cur.types.push(pretty(r[typeCol]));
      if (Number(r.is_ac) === 1) cur.ac = true;
      rooms.set(r.property_id, cur);
    }
  }

  // amenities table
  const amen = new Map();
  const add = (pid, name) => {
    const list = amen.get(pid) || [];
    if (name && !list.includes(name)) list.push(name);
    amen.set(pid, list);
  };
  for (const r of await safeQuery(
    'SELECT pa.property_id, a.name FROM property_amenities pa JOIN amenities a ON a.id = pa.amenity_id WHERE pa.property_id IN (:ids)', { ids }
  )) add(r.property_id, r.name);

  // owner portal details: food, facilities, nearby
  const details = new Map();
  for (const d of await safeQuery('SELECT * FROM property_details WHERE property_id IN (:ids)', { ids })) {
    const food = parseJson(d.food) || null;
    const fac = parseJson(d.facilities) || {};
    if (food && food.available) add(d.property_id, 'Meals');
    for (const [k, label] of Object.entries(FACILITY_LABELS)) if (fac[k] === true) add(d.property_id, label);
    details.set(d.property_id, {
      food,
      ac: fac.ac === true,
      nearby: d.nearby ? String(d.nearby).split(/[·\n|]/)[0].trim() : null,
    });
  }

  // ratings from reviews if the property row doesn't carry them
  const ratings = new Map();
  if (!pc.includes('avg_rating')) {
    for (const r of await safeQuery(
      'SELECT property_id, AVG(rating) AS avg, COUNT(*) AS n FROM reviews WHERE property_id IN (:ids) GROUP BY property_id', { ids }
    )) ratings.set(r.property_id, { avg: Number(r.avg), n: Number(r.n) });
  }

  return props.map((p) => {
    const rm = rooms.get(p.id) || { count: 0, beds: 0, min: 0, types: [], ac: false };
    const det = details.get(p.id) || {};
    const rating = pc.includes('avg_rating') ? Number(p.avg_rating) || 0 : ratings.get(p.id)?.avg || 0;
    const reviews = pc.includes('total_reviews') ? Number(p.total_reviews) || 0 : ratings.get(p.id)?.n || 0;
    const photos = gallery.get(p.id) || [];
    const food = det.food;
    return {
      id: p.id,
      name: p.name || p.title || `Property #${p.id}`,
      location: p.area || p.locality || '',
      city: p.city || p.joined_city || '',
      address: p.address || null,
      price: Number(p.monthly_rent) || rm.min || 0,
      deposit: Number(p.security_deposit) || 0,
      image: photos[0] || null,
      gallery: photos,
      rating: Math.round(rating * 10) / 10,
      reviews,
      type: pretty(p.property_type),
      gender: genderLabel(p.gender_allowed),
      description: p.description || '',
      amenities: amen.get(p.id) || [],
      distance: det.nearby || p.landmark || null,
      verified: Number(p.is_verified) === 1,
      featured: Number(p.is_featured) === 1,
      created_at: p.created_at || null,
      room_count: rm.count,
      room_types: [...new Set(rm.types)],
      beds_available: rm.beds,
      has_ac: rm.ac || det.ac === true,
      food: food ? { available: !!food.available, type: food.type || null, included: food.included !== false } : null,
      owner_name: p.owner_name || null,
      owner_image: p.owner_pic || null,
    };
  });
}

// ── GET /featured ─────────────────────────────────────────
router.get('/featured', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 6, 1), 24);
    res.json({ success: true, properties: await toCards(await loadProperties(limit)) });
  } catch (err) {
    next(err);
  }
});

// ── GET /properties ───────────────────────────────────────
router.get('/properties', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    res.json({ success: true, properties: await toCards(await loadProperties(limit)) });
  } catch (err) {
    next(err);
  }
});

// ── GET /cities ───────────────────────────────────────────
router.get('/cities', async (req, res, next) => {
  try {
    const pc = await columns('properties');
    const active = pc.includes('is_active') ? 'AND p.is_active = 1' : '';
    let rows = [];

    if (pc.includes('city')) {
      rows = await safeQuery(
        `SELECT p.city AS name, COUNT(*) AS count FROM properties p
          WHERE p.city IS NOT NULL AND p.city <> '' ${active}
          GROUP BY p.city ORDER BY count DESC LIMIT 12`
      );
    } else if (pc.includes('city_id')) {
      const cityName = (await columns('cities')).includes('name') ? 'name' : 'city_name';
      rows = await safeQuery(
        `SELECT c.\`${cityName}\` AS name, COUNT(*) AS count FROM properties p
           JOIN cities c ON c.id = p.city_id
          WHERE 1 = 1 ${active}
          GROUP BY c.\`${cityName}\` ORDER BY count DESC LIMIT 12`
      );
    }

    res.json({ success: true, cities: rows.map((r) => ({ name: r.name, count: Number(r.count) })) });
  } catch (err) {
    next(err);
  }
});

// ── GET /city/:slug ───────────────────────────────────────
// City page: city info + its listings, with filters, sort and pages.
//   ?type=pg&gender=female&sort=newest|rent_low|rent_high|rating&page=1&limit=12
function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

router.get('/city/:slug', async (req, res, next) => {
  try {
    const slug = slugify(req.params.slug);
    const pc = await columns('properties');
    const cc = await columns('cities');

    // 1. find the city (cities table first, then plain city names on properties)
    let city = null;
    if (cc.length) {
      const nameCol = cc.includes('name') ? 'name' : cc.includes('city_name') ? 'city_name' : null;
      const rows = await safeQuery('SELECT * FROM cities');
      const row = rows.find((c) => (c.slug && slugify(c.slug) === slug) || (nameCol && slugify(c[nameCol]) === slug));
      if (row) {
        city = {
          id: row.id,
          name: row[nameCol] || row.name,
          slug: row.slug || slugify(row[nameCol]),
          state: row.state || null,
          banner_image_url: row.banner_image_url || row.banner_image || row.image_url || row.image || null,
          short_description: row.short_description || row.tagline || row.description || null,
        };
      }
    }
    if (!city && pc.includes('city')) {
      const rows = await safeQuery('SELECT DISTINCT city FROM properties WHERE city IS NOT NULL');
      const m = rows.find((r) => slugify(r.city) === slug);
      if (m) city = { id: null, name: m.city, slug, state: null, banner_image_url: null, short_description: null };
    }
    if (!city) return res.status(404).json({ success: false, message: 'City not found.' });

    // 2. which listings belong to this city
    const params = { cname: String(city.name).toLowerCase() };
    const match = [];
    if (pc.includes('city_id') && city.id) { match.push('p.city_id = :cid'); params.cid = city.id; }
    if (pc.includes('city')) match.push('LOWER(TRIM(p.city)) = :cname');
    if (!match.length) return res.json({ success: true, city, properties: [], pagination: { page: 1, limit: 12, total: 0, totalPages: 0 }, facets: { types: [], genders: [] }, stats: { total: 0, verified: 0, from_price: 0 } });

    const base = [`(${match.join(' OR ')})`];
    if (pc.includes('is_active')) base.push('p.is_active = 1');

    // facets & stats are for the whole city (before type/gender filters)
    const baseWhere = `WHERE ${base.join(' AND ')}`;
    const [types, genders, statRow] = await Promise.all([
      pc.includes('property_type') ? safeQuery(`SELECT DISTINCT p.property_type AS v FROM properties p ${baseWhere}`, params) : [],
      pc.includes('gender_allowed') ? safeQuery(`SELECT DISTINCT p.gender_allowed AS v FROM properties p ${baseWhere}`, params) : [],
      safeQuery(
        `SELECT COUNT(*) AS total
                ${pc.includes('is_verified') ? ', SUM(p.is_verified = 1) AS verified' : ''}
                ${pc.includes('monthly_rent') ? ', MIN(NULLIF(p.monthly_rent, 0)) AS from_price' : ''}
           FROM properties p ${baseWhere}`, params),
    ]);

    // 3. filters
    const where = [...base];
    if (req.query.type && pc.includes('property_type')) { where.push('p.property_type = :type'); params.type = String(req.query.type); }
    if (req.query.gender && pc.includes('gender_allowed')) { where.push('p.gender_allowed = :gender'); params.gender = String(req.query.gender); }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const sort = String(req.query.sort || 'newest');
    const order =
      sort === 'rent_low' && pc.includes('monthly_rent') ? 'NULLIF(p.monthly_rent, 0) IS NULL, p.monthly_rent ASC' :
      sort === 'rent_high' && pc.includes('monthly_rent') ? 'p.monthly_rent DESC' :
      sort === 'rating' && pc.includes('avg_rating') ? 'p.avg_rating DESC' :
      pc.includes('created_at') ? 'p.created_at DESC' : 'p.id DESC';
    const verifiedFirst = pc.includes('is_verified') && sort === 'newest' ? 'p.is_verified DESC, ' : '';

    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 48);
    const [{ total = 0 } = {}] = await safeQuery(`SELECT COUNT(*) AS total FROM properties p ${whereSql}`, params);
    const totalPages = Math.max(1, Math.ceil(Number(total) / limit));
    const page = Math.min(Math.max(Number(req.query.page) || 1, 1), totalPages);

    const rows = await safeQuery(
      `SELECT p.* FROM properties p ${whereSql} ORDER BY ${verifiedFirst}${order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params
    );

    const cards = await toCards(rows);
    const s = statRow[0] || {};
    res.json({
      success: true,
      city,
      properties: cards.map((c) => ({ ...c, city: c.city || city.name })),
      pagination: { page, limit, total: Number(total), totalPages: Number(total) ? totalPages : 0 },
      facets: {
        types: types.map((r) => r.v).filter(Boolean),
        genders: genders.map((r) => r.v).filter(Boolean),
      },
      stats: {
        total: Number(s.total) || 0,
        verified: Number(s.verified) || 0,
        from_price: Number(s.from_price) || (cards.some((c) => c.price) ? Math.min(...cards.map((c) => c.price).filter(Boolean)) : 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════
//  FIND HOSTEL — search across all cities
//   GET /api/home/search/options  → cities, types, genders for the filters
//   GET /api/home/search?rentType=monthly|daily&city=<slug>&type=&gender=&min=&max=&q=&sort=&page=&limit=
// ═══════════════════════════════════════════

const DAILY_PROPERTY_COLS = ['daily_rent', 'price_per_day', 'daily_price', 'per_day_rent'];
const DAILY_ROOM_COLS = ['price_per_day', 'daily_price', 'daily_rent', 'per_day_price'];

async function cityList() {
  const cc = await columns('cities');
  const pc = await columns('properties');
  const active = pc.includes('is_active') ? 'AND p.is_active = 1' : '';
  const out = [];

  if (cc.length) {
    const nameCol = cc.includes('name') ? 'name' : cc.includes('city_name') ? 'city_name' : null;
    if (nameCol) {
      const rows = await safeQuery('SELECT * FROM cities');
      for (const c of rows) {
        const name = c[nameCol];
        if (!name) continue;
        let count = 0;
        const conds = [];
        const params = { cname: String(name).toLowerCase().trim() };
        if (pc.includes('city_id')) { conds.push('p.city_id = :cid'); params.cid = c.id; }
        if (pc.includes('city')) conds.push('LOWER(TRIM(p.city)) = :cname');
        if (conds.length) {
          const [r] = await safeQuery(`SELECT COUNT(*) AS n FROM properties p WHERE (${conds.join(' OR ')}) ${active}`, params);
          count = Number(r?.n) || 0;
        }
        out.push({ id: c.id, name, slug: c.slug ? slugify(c.slug) : slugify(name), count });
      }
    }
  }
  // cities typed on properties that aren't in the cities table
  if (pc.includes('city')) {
    const rows = await safeQuery(
      `SELECT p.city AS name, COUNT(*) AS n FROM properties p WHERE p.city IS NOT NULL AND p.city <> '' ${active} GROUP BY p.city`
    );
    for (const r of rows) {
      const slug = slugify(r.name);
      if (!out.some((c) => c.slug === slug)) out.push({ id: null, name: r.name, slug, count: Number(r.n) || 0 });
    }
  }
  return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

router.get('/search/options', async (req, res, next) => {
  try {
    const pc = await columns('properties');
    const active = pc.includes('is_active') ? 'WHERE p.is_active = 1' : '';
    const [cities, types, genders] = await Promise.all([
      cityList(),
      pc.includes('property_type') ? safeQuery(`SELECT DISTINCT p.property_type AS v FROM properties p ${active}`) : [],
      pc.includes('gender_allowed') ? safeQuery(`SELECT DISTINCT p.gender_allowed AS v FROM properties p ${active}`) : [],
    ]);
    const roomsTable = (await columns('rooms')).length ? 'rooms' : (await columns('property_rooms')).length ? 'property_rooms' : null;
    const rc = roomsTable ? await columns(roomsTable) : [];
    res.json({
      success: true,
      cities,
      types: types.map((r) => r.v).filter(Boolean),
      genders: genders.map((r) => r.v).filter(Boolean),
      dailySupported: DAILY_PROPERTY_COLS.some((c) => pc.includes(c)) || DAILY_ROOM_COLS.some((c) => rc.includes(c)),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/search', async (req, res, next) => {
  try {
    const pc = await columns('properties');
    const params = {};
    const where = [];
    if (pc.includes('is_active')) where.push('p.is_active = 1');

    // city
    let city = null;
    if (req.query.city) {
      const slug = slugify(req.query.city);
      city = (await cityList()).find((c) => c.slug === slug) || null;
      if (!city) return res.json({ success: true, city: null, priceUnit: 'month', properties: [], pagination: { page: 1, limit: 12, total: 0, totalPages: 0 } });
      const conds = [];
      params.cname = String(city.name).toLowerCase().trim();
      if (pc.includes('city_id') && city.id) { conds.push('p.city_id = :cid'); params.cid = city.id; }
      if (pc.includes('city')) conds.push('LOWER(TRIM(p.city)) = :cname');
      if (conds.length) where.push(`(${conds.join(' OR ')})`);
    }

    // type / gender
    if (req.query.type && pc.includes('property_type')) { where.push('p.property_type = :type'); params.type = String(req.query.type); }
    if (req.query.gender && pc.includes('gender_allowed')) { where.push('p.gender_allowed = :gender'); params.gender = String(req.query.gender); }

    // free text: name / area / city / address
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q) {
      const textCols = ['name', 'area', 'locality', 'city', 'address', 'landmark'].filter((c) => pc.includes(c));
      q.split(/[\s,]+/).filter(Boolean).slice(0, 5).forEach((word, i) => {
        params[`q${i}`] = `%${word}%`;
        where.push(`(${textCols.map((c) => `LOWER(p.\`${c}\`) LIKE :q${i}`).join(' OR ')})`);
      });
    }

    // price column: monthly or daily
    const rentType = req.query.rentType === 'daily' ? 'daily' : 'monthly';
    let priceExpr = null;
    if (rentType === 'monthly') {
      if (pc.includes('monthly_rent')) priceExpr = 'NULLIF(p.monthly_rent, 0)';
    } else {
      const dp = DAILY_PROPERTY_COLS.find((c) => pc.includes(c));
      const roomsTable = (await columns('rooms')).length ? 'rooms' : (await columns('property_rooms')).length ? 'property_rooms' : null;
      const rc = roomsTable ? await columns(roomsTable) : [];
      const roomDaily = DAILY_ROOM_COLS.find((c) => rc.includes(c));
      if (dp) priceExpr = `NULLIF(p.\`${dp}\`, 0)`;
      else if (roomDaily) priceExpr = `(SELECT MIN(NULLIF(r.\`${roomDaily}\`, 0)) FROM \`${roomsTable}\` r WHERE r.property_id = p.id)`;
      if (!priceExpr) {
        // no daily prices anywhere in your tables yet
        return res.json({ success: true, city, priceUnit: 'day', dailySupported: false, properties: [], pagination: { page: 1, limit: 12, total: 0, totalPages: 0 } });
      }
      where.push(`${priceExpr} IS NOT NULL`); // daily tab only shows places that set a daily price
    }

    const min = Number(req.query.min);
    const max = Number(req.query.max);
    if (priceExpr && Number.isFinite(min) && min > 0) { where.push(`${priceExpr} >= :min`); params.min = min; }
    if (priceExpr && Number.isFinite(max) && max > 0) { where.push(`${priceExpr} <= :max`); params.max = max; }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sort = String(req.query.sort || 'newest');
    const order =
      sort === 'price_low' && priceExpr ? `${priceExpr} IS NULL, ${priceExpr} ASC` :
      sort === 'price_high' && priceExpr ? `${priceExpr} DESC` :
      sort === 'rating' && pc.includes('avg_rating') ? 'p.avg_rating DESC' :
      `${pc.includes('is_verified') ? 'p.is_verified DESC, ' : ''}${pc.includes('created_at') ? 'p.created_at DESC' : 'p.id DESC'}`;

    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 48);
    const [{ total = 0 } = {}] = await safeQuery(`SELECT COUNT(*) AS total FROM properties p ${whereSql}`, params);
    const totalPages = Math.max(1, Math.ceil(Number(total) / limit));
    const page = Math.min(Math.max(Number(req.query.page) || 1, 1), totalPages);

    const rows = await safeQuery(
      `SELECT p.*${priceExpr ? `, ${priceExpr} AS search_price` : ''}
         FROM properties p ${whereSql}
        ORDER BY ${order}
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params
    );
    const cards = await toCards(rows);

    res.json({
      success: true,
      city,
      priceUnit: rentType === 'daily' ? 'day' : 'month',
      properties: cards.map((c, i) => ({
        ...c,
        // price shown on the card matches the tab (daily or monthly)
        price: Number(rows[i].search_price) || (rentType === 'monthly' ? c.price : 0),
      })),
      pagination: { page, limit, total: Number(total), totalPages: Number(total) ? totalPages : 0 },
    });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════
// SEO: sitemap.xml and robots.txt
//   GET /api/home/sitemap.xml   every public page + every live city and listing
//   GET /api/home/robots.txt    tells search engines what to crawl
// The Angular server forwards /sitemap.xml and /robots.txt here, so they
// appear at the site root (https://your-domain/sitemap.xml).
// Set SITE_URL=https://www.your-domain.com in .env for production.
// ══════════════════════════════════════════════════════════
function siteUrl(req) {
  const fromEnv = String(process.env.SITE_URL || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/[^\s/]+$/i.test(fromEnv)) return fromEnv;
  const fromQuery = String(req.query.origin || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(fromQuery)) return fromQuery;
  return `${req.protocol}://${req.get('host')}`;
}

const xmlEscape = (s) =>
  String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

function isoDate(v) {
  const d = v ? new Date(v) : null;
  return d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

// Public pages of the Angular app. Private areas (owner, super admin,
// profile, bookings…) are left out on purpose.
const STATIC_PAGES = [
  { path: '/', changefreq: 'daily', priority: '1.0' },
  { path: '/find-hostel', changefreq: 'daily', priority: '0.9' },
  { path: '/properties', changefreq: 'daily', priority: '0.9' },
  { path: '/cities', changefreq: 'weekly', priority: '0.8' },
  { path: '/services', changefreq: 'monthly', priority: '0.5' },
  { path: '/contact', changefreq: 'monthly', priority: '0.5' },
  { path: '/register-your-hostel', changefreq: 'monthly', priority: '0.6' },
];

let sitemapCache = { at: 0, base: '', xml: '' };

router.get('/sitemap.xml', async (req, res, next) => {
  try {
    const base = siteUrl(req);
    // rebuild at most every 30 minutes
    if (sitemapCache.xml && sitemapCache.base === base && Date.now() - sitemapCache.at < 30 * 60 * 1000) {
      return res.type('application/xml').send(sitemapCache.xml);
    }

    const today = new Date().toISOString().slice(0, 10);
    const urls = STATIC_PAGES.map((p) => ({ loc: base + p.path, lastmod: today, changefreq: p.changefreq, priority: p.priority }));

    for (const c of await cityList()) {
      if (!c.slug || !c.count) continue; // only cities that have stays
      urls.push({ loc: `${base}/cities/${c.slug}`, lastmod: today, changefreq: 'daily', priority: '0.8' });
    }

    // uploaded photos are served by this API, not by the website
    const apiBase = String(process.env.API_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const props = await loadProperties(45000); // sitemap limit is 50,000 URLs
    const cards = await toCards(props);
    props.forEach((p, i) => {
      const img = cards[i]?.image;
      urls.push({
        loc: `${base}/properties/${p.id}`,
        lastmod: isoDate(p.updated_at) || isoDate(p.created_at) || today,
        changefreq: 'weekly',
        priority: Number(p.is_verified) === 1 ? '0.8' : '0.7',
        image: img ? (/^https?:/i.test(img) ? img : apiBase + (img.startsWith('/') ? '' : '/') + img) : null,
        title: cards[i]?.name || null,
      });
    });

    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n' +
      urls
        .map(
          (u) =>
            `  <url>\n    <loc>${xmlEscape(u.loc)}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n` +
            `    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n` +
            (u.image
              ? `    <image:image>\n      <image:loc>${xmlEscape(u.image)}</image:loc>\n` +
                (u.title ? `      <image:title>${xmlEscape(u.title)}</image:title>\n` : '') +
                '    </image:image>\n'
              : '') +
            '  </url>'
        )
        .join('\n') +
      '\n</urlset>\n';

    sitemapCache = { at: Date.now(), base, xml };
    res.set('Cache-Control', 'public, max-age=1800').type('application/xml').send(xml);
  } catch (err) {
    next(err);
  }
});

router.get('/robots.txt', (req, res) => {
  const base = siteUrl(req);
  res.type('text/plain').send(
    [
      'User-agent: *',
      'Allow: /',
      '',
      '# Private areas — no value in search results',
      'Disallow: /owner/',
      'Disallow: /super-admin',
      'Disallow: /profile',
      'Disallow: /bookings',
      'Disallow: /favorites',
      'Disallow: /settings',
      'Disallow: /login',
      'Disallow: /register$',
      'Disallow: /api/',
      '',
      `Sitemap: ${base}/sitemap.xml`,
      '',
    ].join('\n')
  );
});

module.exports = router;

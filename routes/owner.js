// routes/owner.js  — mounted at /api/owner
//
// Property OWNERS (rows in your `admins` table):
//   POST /register                         sign up → approved instantly → returns token
//   GET  /public/properties/:id/extras     food / facilities / rules for the detail page (no login)
//   ── everything below needs the owner token (same token /api/admin/auth/login returns) ──
//   GET  /me                               profile + plan + usage
//   GET  /meta                             cities, amenities, dropdown options, plans
//   GET  /properties                       my listings
//   POST /properties                       add a listing (multipart: data=<json>, images=<up to 15 files>,
//                                          images_meta=<json [{category, caption}] in the same order>)
//                                          every photo → property_photos row with its own doc_id
//   GET  /enquiries                        bookings made on my listings
//   GET  /subscriptions                    my plan payments
//   POST /subscription/order               start a Razorpay payment for a plan
//   POST /subscription/verify              confirm the Razorpay payment, activate the plan
//
// .env:
//   JWT_ADMIN_SECRET=...                (already used by auth.admin.js)
//   RAZORPAY_KEY_ID=rzp_test_xxx
//   RAZORPAY_KEY_SECRET=xxx
//   FREE_LISTING_LIMIT=5                (optional, default 5)

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const pool = require('../config/db');

const router = express.Router();
const secret = () => process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET;

// ═══════════════════════════════════════════
//  PLANS
// ═══════════════════════════════════════════
function plans() {
  return {
    free:     { code: 'free',     name: 'Starter',  price: 0,    listings: Number(process.env.FREE_LISTING_LIMIT) || 5, days: null },
    pro:      { code: 'pro',      name: 'Pro',      price: Number(process.env.PLAN_PRO_PRICE) || 499,       listings: 25,   days: 30 },
    business: { code: 'business', name: 'Business', price: Number(process.env.PLAN_BUSINESS_PRICE) || 1499, listings: 1000, days: 30 },
  };
}

// ═══════════════════════════════════════════
//  SCHEMA HELPERS (work with your real columns)
// ═══════════════════════════════════════════
let tableSet = null;
async function tables(refresh = false) {
  if (!tableSet || refresh) {
    const [rows] = await pool.query('SHOW TABLES');
    tableSet = new Set(rows.map((r) => Object.values(r)[0]));
  }
  return tableSet;
}
const colCache = {};
async function columns(table) {
  if (!colCache[table]) {
    const [cols] = await pool.query(`SHOW COLUMNS FROM \`${table}\``);
    colCache[table] = cols;
  }
  return colCache[table];
}
async function firstTable(candidates) {
  const all = await tables();
  return candidates.find((t) => all.has(t)) || null;
}
function enumOptions(col) {
  if (!col || !/^enum\(/i.test(col.Type)) return null;
  return [...col.Type.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
}
function pickEnum(options, wanted) {
  if (!options || !options.length) return wanted;
  const w = String(wanted || '').toLowerCase().replace(/[\s_-]/g, '');
  return (
    options.find((o) => o.toLowerCase().replace(/[\s_-]/g, '') === w) ||
    options.find((o) => w && (o.toLowerCase().includes(w) || w.includes(o.toLowerCase()))) ||
    options[0]
  );
}
function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}
function isAuto(col) {
  return /auto_increment|default_generated|on update/i.test(col.Extra) || ['created_at', 'updated_at', 'deleted_at'].includes(col.Field);
}

/**
 * Build an INSERT from wanted values, using only columns that exist.
 * `map` = { logicalKey: [candidate column names] }, `values` = { logicalKey: value }.
 * Required columns that we have no value for get a safe default.
 */
async function buildInsert(table, map, values) {
  const cols = await columns(table);
  const byName = Object.fromEntries(cols.map((c) => [c.Field, c]));
  const data = {};

  for (const [key, candidates] of Object.entries(map)) {
    const v = values[key];
    if (v === undefined || v === null || v === '') continue;
    const colName = candidates.find((c) => byName[c] && !(c in data));
    if (!colName) continue;
    const opts = enumOptions(byName[colName]);
    data[colName] = opts ? pickEnum(opts, v) : v;
  }

  for (const c of cols) {
    if (c.Field in data || isAuto(c) || c.Null === 'YES' || c.Default !== null) continue;
    const t = c.Type.toLowerCase();
    if (c.Field === 'slug') data.slug = `${slugify(values.name || 'listing')}-${crypto.randomBytes(3).toString('hex')}`;
    else if (enumOptions(c)) data[c.Field] = enumOptions(c)[0];
    else if (/int|decimal|float|double|numeric|bit/.test(t)) data[c.Field] = 0;
    else if (/date|time/.test(t)) data[c.Field] = new Date();
    else data[c.Field] = '';
  }

  const keys = Object.keys(data);
  const params = {};
  keys.forEach((k, i) => (params[`v${i}`] = data[k]));
  return {
    sql: `INSERT INTO \`${table}\` (${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (${keys.map((_, i) => `:v${i}`).join(', ')})`,
    params,
  };
}

// ═══════════════════════════════════════════
//  OWN TABLES (created once if missing)
// ═══════════════════════════════════════════
let ownTablesReady = false;
async function ensureOwnTables() {
  if (ownTablesReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS owner_subscriptions (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      admin_id            INT NOT NULL,
      plan_code           VARCHAR(20) NOT NULL,
      amount_paise        INT NOT NULL,
      currency            VARCHAR(5) NOT NULL DEFAULT 'INR',
      status              VARCHAR(20) NOT NULL DEFAULT 'created',
      razorpay_order_id   VARCHAR(64) NOT NULL,
      razorpay_payment_id VARCHAR(64) NULL,
      starts_at           DATETIME NULL,
      ends_at             DATETIME NULL,
      created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_order (razorpay_order_id),
      KEY idx_admin (admin_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS property_details (
      property_id INT PRIMARY KEY,
      food        TEXT NULL,
      facilities  TEXT NULL,
      rules       TEXT NULL,
      nearby      TEXT NULL,
      updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS property_photos (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      doc_id        CHAR(36) NOT NULL,
      property_id   INT NOT NULL,
      admin_id      INT NOT NULL,
      category      VARCHAR(20) NOT NULL DEFAULT 'other',
      caption       VARCHAR(150) NULL,
      file_name     VARCHAR(80) NOT NULL,
      original_name VARCHAR(255) NULL,
      url           VARCHAR(500) NOT NULL,
      mime_type     VARCHAR(40) NULL,
      size_bytes    INT NULL,
      is_cover      TINYINT(1) NOT NULL DEFAULT 0,
      sort_order    INT NOT NULL DEFAULT 0,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_doc (doc_id),
      KEY idx_property (property_id)
    )`);
  ownTablesReady = true;
}

function parseJson(v, fallback) {
  if (v == null) return fallback;
  try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return fallback; }
}

// ═══════════════════════════════════════════
//  PUBLIC
// ═══════════════════════════════════════════
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many sign-up attempts. Try again in 15 minutes.' },
});

router.post('/register', registerLimiter, async (req, res, next) => {
  try {
    const { full_name, email, phone, password } = req.body || {};
    if (!full_name || !email || !phone || !password) {
      return res.status(400).json({ success: false, message: 'Name, email, phone and password are required.' });
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
    if (!/^[0-9+\s-]{10,15}$/.test(phone)) return res.status(400).json({ success: false, message: 'Enter a valid phone number.' });
    if (String(password).length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
    if (!secret()) return res.status(500).json({ success: false, message: 'JWT_ADMIN_SECRET is missing in .env.' });

    const [exist] = await pool.query('SELECT id FROM admins WHERE email = :email OR phone = :phone', { email, phone });
    if (exist.length) return res.status(409).json({ success: false, message: 'An owner account with this email or phone already exists. Log in instead.' });

    const cols = (await columns('admins')).map((c) => c.Field);
    const data = { full_name, email, phone, password_hash: await bcrypt.hash(password, 12) };
    if (cols.includes('is_active')) data.is_active = 1;
    if (cols.includes('is_approved')) data.is_approved = 1;   // owners can list right away

    const keys = Object.keys(data);
    const [result] = await pool.query(
      `INSERT INTO admins (${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (${keys.map((k) => `:${k}`).join(', ')})`,
      data
    );

    // same token shape as /api/admin/auth/login
    const token = jwt.sign({ id: result.insertId, email, role: 'admin' }, secret(), { expiresIn: '7d' });
    res.status(201).json({
      success: true,
      message: 'Account created.',
      token,
      admin: { id: result.insertId, full_name, email, phone },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/public/properties/:id/extras', async (req, res, next) => {
  try {
    await ensureOwnTables();
    const id = Number(req.params.id) || 0;
    const [[row]] = await pool.query('SELECT * FROM property_details WHERE property_id = :id', { id });
    const [photos] = await pool.query(
      `SELECT doc_id, category, caption, url, is_cover, sort_order
         FROM property_photos WHERE property_id = :id ORDER BY sort_order`,
      { id }
    );
    res.json({
      success: true,
      extras: row || photos.length
        ? {
            food: parseJson(row?.food, null),
            facilities: parseJson(row?.facilities, null),
            rules: parseJson(row?.rules, null),
            nearby: row?.nearby || null,
            photos,
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════
//  OWNER AUTH
// ═══════════════════════════════════════════
async function requireOwner(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: 'Please log in as an owner.' });

  let payload;
  try {
    payload = jwt.verify(token, secret());
  } catch (_) {
    return res.status(401).json({ success: false, message: 'Your session has expired. Log in again.' });
  }
  if (!['admin', 'owner'].includes(payload.role) || !payload.id) {
    return res.status(403).json({ success: false, message: 'Owner account required.' });
  }

  try {
    const [[owner]] = await pool.query('SELECT * FROM admins WHERE id = :id', { id: payload.id });
    if (!owner) return res.status(401).json({ success: false, message: 'Owner account not found.' });
    if (owner.is_active === 0) return res.status(403).json({ success: false, message: 'This owner account is inactive.' });
    const { password_hash, ...safe } = owner;
    req.owner = safe;
    next();
  } catch (err) {
    next(err);
  }
}

router.use(requireOwner);

// ═══════════════════════════════════════════
//  PLAN / USAGE
// ═══════════════════════════════════════════
async function activePlan(ownerId) {
  await ensureOwnTables();
  const p = plans();
  const [[sub]] = await pool.query(
    `SELECT * FROM owner_subscriptions
      WHERE admin_id = :id AND status = 'paid' AND ends_at > NOW()
      ORDER BY ends_at DESC LIMIT 1`,
    { id: ownerId }
  );
  if (sub && p[sub.plan_code]) return { ...p[sub.plan_code], ends_at: sub.ends_at };
  return { ...p.free, ends_at: null };
}

async function listingCount(ownerId) {
  const [[r]] = await pool.query('SELECT COUNT(*) AS n FROM properties WHERE admin_id = :id', { id: ownerId });
  return Number(r.n);
}

router.get('/me', async (req, res, next) => {
  try {
    const [plan, used] = await Promise.all([activePlan(req.owner.id), listingCount(req.owner.id)]);
    res.json({ success: true, owner: req.owner, plan, usage: { listings: used, limit: plan.listings, remaining: Math.max(0, plan.listings - used) } });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════
//  META (form options)
// ═══════════════════════════════════════════
router.get('/meta', async (req, res, next) => {
  try {
    const all = await tables();

    // cities
    let cities = [];
    if (all.has('cities')) {
      const cc = (await columns('cities')).map((c) => c.Field);
      const label = ['name', 'city_name', 'title'].find((c) => cc.includes(c)) || 'id';
      const [rows] = await pool.query(`SELECT * FROM cities`);
      cities = rows
        .map((r) => ({ id: r.id, name: String(r[label] ?? r.id), state: r.state || null }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    // amenities
    let amenities = [];
    if (all.has('amenities')) {
      const [rows] = await pool.query('SELECT * FROM amenities');
      amenities = rows.map((r) => ({ id: r.id, name: r.name || r.title || `Amenity ${r.id}`, icon: r.icon || null }));
    }

    const pc = await columns('properties');
    const roomsTable = await firstTable(['rooms', 'property_rooms']);
    const rc = roomsTable ? await columns(roomsTable) : [];
    const find = (cols, names) => cols.find((c) => names.includes(c.Field));

    res.json({
      success: true,
      cities,
      amenities,
      usesCityId: pc.some((c) => c.Field === 'city_id'),
      options: {
        property_type: enumOptions(find(pc, ['property_type', 'type'])) || ['pg', 'hostel', 'co-living'],
        gender_allowed: enumOptions(find(pc, ['gender_allowed', 'gender', 'gender_type'])) || ['male', 'female', 'unisex'],
        room_type: enumOptions(find(rc, ['room_type', 'type'])) || null,
      },
      plans: Object.values(plans()),
      razorpayConfigured: !!razorpayAuth(),
      upiConfigured: !!upiConfig(),
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════
//  MY PROPERTIES
// ═══════════════════════════════════════════
router.get('/properties', async (req, res, next) => {
  try {
    const [props] = await pool.query('SELECT * FROM properties WHERE admin_id = :id ORDER BY id DESC', { id: req.owner.id });
    const ids = props.map((p) => p.id);
    const imgs = new Map();
    const rooms = new Map();
    const enquiries = new Map();

    if (ids.length) {
      try {
        const [rows] = await pool.query('SELECT * FROM property_images WHERE property_id IN (:ids)', { ids });
        for (const r of rows) if (!imgs.has(r.property_id) || r.is_primary) imgs.set(r.property_id, r.image_url || r.url || r.path);
      } catch (_) {}
      const roomsTable = await firstTable(['rooms', 'property_rooms']);
      if (roomsTable) {
        try {
          const [rows] = await pool.query(`SELECT * FROM \`${roomsTable}\` WHERE property_id IN (:ids)`, { ids });
          for (const r of rows) {
            const cur = rooms.get(r.property_id) || { rooms: 0, beds_available: 0 };
            cur.rooms += 1;
            cur.beds_available += Number(r.available ?? r.available_beds ?? 0) || 0;
            rooms.set(r.property_id, cur);
          }
        } catch (_) {}
      }
      try {
        const [rows] = await pool.query('SELECT property_id, COUNT(*) AS n FROM bookings WHERE property_id IN (:ids) GROUP BY property_id', { ids });
        for (const r of rows) enquiries.set(r.property_id, Number(r.n));
      } catch (_) {}
    }

    res.json({
      success: true,
      properties: props.map((p) => ({
        ...p,
        cover_image: imgs.get(p.id) || null,
        room_count: rooms.get(p.id)?.rooms || 0,
        beds_available: rooms.get(p.id)?.beds_available || 0,
        enquiry_count: enquiries.get(p.id) || 0,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// uploads (same folder server.js serves at /uploads)
const MAX_PHOTOS = 15;
const PHOTO_CATEGORIES = ['room', 'amenities', 'washroom', 'food', 'building', 'other'];
const uploadDir = path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      // the photo's document ID is also its file name: <doc_id>.jpg
      const docId = crypto.randomUUID();
      file.docId = docId;
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, `${docId}${ext}`);
    },
  }),
  limits: { fileSize: Number(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024, files: MAX_PHOTOS },
  fileFilter: (req, file, cb) => {
    const ok = /image\/(jpeg|jpg|png|webp)/.test(file.mimetype);
    cb(ok ? null : new Error('Only JPG, PNG or WEBP photos are allowed.'), ok);
  },
});

const PROPERTY_MAP = {
  name: ['name', 'title', 'property_name'],
  description: ['description', 'about'],
  property_type: ['property_type', 'type'],
  gender_allowed: ['gender_allowed', 'gender', 'gender_type'],
  address: ['address', 'full_address', 'address_line'],
  area: ['area', 'locality'],
  city: ['city', 'city_name'],
  city_id: ['city_id'],
  state: ['state'],
  pincode: ['pincode', 'pin_code', 'zip', 'postal_code'],
  landmark: ['landmark'],
  monthly_rent: ['monthly_rent', 'rent', 'price', 'starting_price'],
  security_deposit: ['security_deposit', 'deposit'],
  total_rooms: ['total_rooms'],
  available_rooms: ['available_rooms'],
  admin_id: ['admin_id', 'owner_id'],
  is_active: ['is_active'],
  slug: ['slug'],
};
const ROOM_MAP = {
  property_id: ['property_id'],
  room_type: ['room_type', 'type', 'name'],
  capacity: ['capacity', 'sharing', 'occupancy'],
  price_per_bed: ['price_per_bed', 'price', 'rent', 'monthly_rent'],
  total_beds: ['total_beds', 'beds'],
  available: ['available', 'available_beds', 'beds_available'],
  is_ac: ['is_ac', 'ac'],
};
const IMAGE_MAP = {
  property_id: ['property_id'],
  image_url: ['image_url', 'url', 'path', 'image'],
  is_primary: ['is_primary', 'is_cover'],
  sort_order: ['sort_order', 'position', 'display_order'],
};

function cleanupFiles(files) {
  for (const f of files || []) fs.unlink(f.path, () => {});
}

router.post('/properties', (req, res, next) => {
  upload.array('images', MAX_PHOTOS)(req, res, (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `You can upload up to ${MAX_PHOTOS} photos.` :
        err.code === 'LIMIT_FILE_SIZE' ? 'Each photo must be 5 MB or smaller.' :
        err.message;
      cleanupFiles(req.files);
      return res.status(400).json({ success: false, message });
    }
    createProperty(req, res, next);
  });
});

async function createProperty(req, res, next) {
  const files = req.files || [];
  let conn;
  try {
    // ── plan limit ──
    const [plan, used] = await Promise.all([activePlan(req.owner.id), listingCount(req.owner.id)]);
    if (used >= plan.listings) {
      cleanupFiles(files);
      return res.status(402).json({
        success: false,
        code: 'LIMIT_REACHED',
        message: `Your ${plan.name} plan allows ${plan.listings} listings. Upgrade to add more.`,
      });
    }

    const d = parseJson(req.body.data, null);
    if (!d) { cleanupFiles(files); return res.status(400).json({ success: false, message: 'Listing details are missing.' }); }

    const rooms = Array.isArray(d.rooms) ? d.rooms.filter((r) => r && r.room_type && Number(r.price_per_bed) > 0) : [];
    const errors = [];
    if (!d.name || String(d.name).trim().length < 3) errors.push('Property name');
    if (!d.address) errors.push('Address');
    if (!d.city && !d.city_id) errors.push('City');
    if (!rooms.length) errors.push('At least one room with a price');
    if (errors.length) { cleanupFiles(files); return res.status(400).json({ success: false, message: `Please fill: ${errors.join(', ')}.` }); }

    // city name / id
    let cityName = d.city || null;
    if (d.city_id && !cityName) {
      try {
        const [[c]] = await pool.query('SELECT * FROM cities WHERE id = :id', { id: d.city_id });
        cityName = c ? c.name || c.city_name : null;
      } catch (_) {}
    }

    const prices = rooms.map((r) => Number(r.price_per_bed));
    const values = {
      name: String(d.name).trim(),
      description: d.description || null,
      property_type: d.property_type,
      gender_allowed: d.gender_allowed,
      address: d.address,
      area: d.area,
      city: cityName,
      city_id: d.city_id || null,
      state: d.state,
      pincode: d.pincode,
      landmark: d.landmark,
      monthly_rent: Number(d.monthly_rent) || Math.min(...prices),
      security_deposit: Number(d.security_deposit) || 0,
      total_rooms: rooms.length,
      available_rooms: rooms.filter((r) => Number(r.available) > 0).length,
      admin_id: req.owner.id,
      is_active: 1,
      slug: `${slugify(d.name)}-${crypto.randomBytes(3).toString('hex')}`,
    };

    // amenities link table — make sure it exists BEFORE the transaction
    // (CREATE TABLE inside a transaction would commit it early)
    const amenityIds = (Array.isArray(d.amenity_ids) ? d.amenity_ids : []).map(Number).filter(Boolean);
    let junction = null;
    if (amenityIds.length) {
      junction = await firstTable(['property_amenities', 'properties_amenities', 'amenity_property']);
      if (!junction) {
        await pool.query(`CREATE TABLE IF NOT EXISTS property_amenities (
          property_id INT NOT NULL, amenity_id INT NOT NULL, PRIMARY KEY (property_id, amenity_id))`);
        junction = 'property_amenities';
        await tables(true);
      }
    }
    await ensureOwnTables();

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const pIns = await buildInsert('properties', PROPERTY_MAP, values);
    const [pRes] = await conn.query(pIns.sql, pIns.params);
    const propertyId = pRes.insertId;

    // rooms
    const roomsTable = await firstTable(['rooms', 'property_rooms']);
    if (roomsTable) {
      for (const r of rooms) {
        const ins = await buildInsert(roomsTable, ROOM_MAP, {
          property_id: propertyId,
          room_type: r.room_type,
          capacity: Number(r.capacity) || 1,
          price_per_bed: Number(r.price_per_bed),
          total_beds: Number(r.total_beds) || Number(r.capacity) || 1,
          available: Number(r.available ?? r.total_beds) || 0,
          is_ac: r.is_ac ? 1 : 0,
        });
        await conn.query(ins.sql, ins.params);
      }
    }

    // photos → property_photos (doc_id, category, …) + your existing property_images (for the detail page)
    const photoMeta = parseJson(req.body.images_meta, []);
    const hasImagesTable = (await tables()).has('property_images');
    const savedPhotos = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const meta = Array.isArray(photoMeta) ? photoMeta[i] || {} : {};
      const category = PHOTO_CATEGORIES.includes(meta.category) ? meta.category : 'other';
      const caption = meta.caption ? String(meta.caption).slice(0, 150) : null;
      const url = `${req.protocol}://${req.get('host')}/uploads/${f.filename}`;

      const [pr] = await conn.query(
        `INSERT INTO property_photos
           (doc_id, property_id, admin_id, category, caption, file_name, original_name, url, mime_type, size_bytes, is_cover, sort_order)
         VALUES (:doc, :pid, :aid, :cat, :cap, :fname, :orig, :url, :mime, :size, :cover, :sort)`,
        {
          doc: f.docId, pid: propertyId, aid: req.owner.id, cat: category, cap: caption,
          fname: f.filename, orig: String(f.originalname || '').slice(0, 255), url,
          mime: f.mimetype, size: f.size, cover: i === 0 ? 1 : 0, sort: i,
        }
      );
      savedPhotos.push({ id: pr.insertId, doc_id: f.docId, category, url });

      if (hasImagesTable) {
        const ins = await buildInsert('property_images', IMAGE_MAP, { property_id: propertyId, image_url: url, is_primary: i === 0 ? 1 : 0, sort_order: i });
        await conn.query(ins.sql, ins.params);
      }
    }

    // amenities
    if (junction) {
      for (const aid of amenityIds) {
        await conn.query(`INSERT IGNORE INTO \`${junction}\` (property_id, amenity_id) VALUES (:p, :a)`, { p: propertyId, a: aid });
      }
    }

    // food / facilities / rules
    await conn.query(
      `INSERT INTO property_details (property_id, food, facilities, rules, nearby)
       VALUES (:id, :food, :facilities, :rules, :nearby)`,
      {
        id: propertyId,
        food: JSON.stringify(d.food || {}),
        facilities: JSON.stringify(d.facilities || {}),
        rules: JSON.stringify(d.rules || {}),
        nearby: d.nearby || null,
      }
    );

    await conn.commit();
    res.status(201).json({ success: true, message: 'Listing published.', property_id: propertyId, photos: savedPhotos });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    cleanupFiles(files);
    if (err && err.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(400).json({ success: false, message: 'The selected city or amenity no longer exists. Refresh and try again.' });
    }
    next(err);
  } finally {
    if (conn) conn.release();
  }
}

// ═══════════════════════════════════════════
//  ENQUIRIES (bookings on my listings)
// ═══════════════════════════════════════════
// Free plan: only the first FREE_ENQUIRY_LIMIT enquiries (default 5) show the
// tenant's contact details. Later ones are sent WITHOUT those details, so they
// can't be uncovered in the browser. Any paid plan unlocks everything.
const TENANT_FIELDS = [
  'full_name', 'name', 'tenant_name', 'guest_name',
  'phone', 'mobile', 'contact', 'contact_number', 'guest_phone', 'whatsapp',
  'email', 'guest_email',
  'address', 'current_address', 'message', 'notes', 'user_id',
];
const NAME_FIELDS = ['full_name', 'name', 'tenant_name', 'guest_name'];

function lockEnquiry(b) {
  const out = { ...b, locked: true };
  const realName = NAME_FIELDS.map((k) => b[k]).find(Boolean);
  for (const k of TENANT_FIELDS) if (k in out) out[k] = null;
  // first letter only, so the owner knows a real person is waiting
  out.full_name = realName ? `${String(realName).trim().charAt(0).toUpperCase()}••••` : 'Tenant';
  return out;
}

router.get('/enquiries', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT b.*, p.name AS property_name
         FROM bookings b
         JOIN properties p ON p.id = b.property_id
        WHERE p.admin_id = :id`,
      { id: req.owner.id }
    );

    // oldest first decides which ones are free to view
    const byAge = [...rows].sort((a, b) =>
      a.created_at && b.created_at ? new Date(a.created_at) - new Date(b.created_at) : a.id - b.id
    );
    const plan = await activePlan(req.owner.id);
    const freeLimit = Number(process.env.FREE_ENQUIRY_LIMIT) || 5;
    const unlockedIds = new Set(plan.code === 'free' ? byAge.slice(0, freeLimit).map((r) => r.id) : byAge.map((r) => r.id));

    const enquiries = byAge
      .map((b) => (unlockedIds.has(b.id) ? { ...b, locked: false } : lockEnquiry(b)))
      .reverse(); // newest first for display

    res.json({
      success: true,
      enquiries,
      summary: {
        plan: plan.code,
        total: rows.length,
        unlocked: unlockedIds.size,
        locked: rows.length - unlockedIds.size,
        free_limit: plan.code === 'free' ? freeLimit : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════
//  SUBSCRIPTION (Razorpay)
// ═══════════════════════════════════════════
function razorpayAuth() {
  // trim: a stray space or quotes copied into .env cause "Authentication failed"
  const key = (process.env.RAZORPAY_KEY_ID || '').trim().replace(/^["']|["']$/g, '');
  const sec = (process.env.RAZORPAY_KEY_SECRET || '').trim().replace(/^["']|["']$/g, '');
  if (!key || !sec || /x{4,}/i.test(key) || /x{4,}/i.test(sec)) return null; // empty or still the placeholder
  return { key, sec, header: 'Basic ' + Buffer.from(`${key}:${sec}`).toString('base64') };
}

router.get('/subscriptions', async (req, res, next) => {
  try {
    await ensureOwnTables();
    const [rows] = await pool.query(
      `SELECT id, plan_code, amount_paise, currency, status, razorpay_order_id, razorpay_payment_id, starts_at, ends_at, created_at
         FROM owner_subscriptions
        WHERE admin_id = :id AND status IN ('paid', 'pending', 'rejected')
        ORDER BY id DESC`,
      { id: req.owner.id }
    );
    res.json({
      success: true,
      subscriptions: rows.map((r) => ({
        ...r,
        method: String(r.razorpay_order_id || '').startsWith('UPI-') ? 'upi' : 'razorpay',
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════
//  SUBSCRIPTION (direct UPI — no gateway fees)
//  Owner pays your UPI ID, then sends the 12-digit UTR.
//  You confirm it in the super admin panel → plan becomes active.
//  .env: PAYMENT_UPI_ID=yourname@okhdfcbank   PAYMENT_UPI_NAME=HostelKhojo
// ═══════════════════════════════════════════
function upiConfig() {
  const id = (process.env.PAYMENT_UPI_ID || '').trim().replace(/^["']|["']$/g, '');
  if (!/^[\w.\-]{2,256}@[a-zA-Z][\w.\-]{1,64}$/.test(id)) return null; // missing or not a valid UPI ID
  return { id, name: (process.env.PAYMENT_UPI_NAME || 'HostelKhojo').trim().replace(/^["']|["']$/g, '') };
}

router.get('/subscription/upi', async (req, res, next) => {
  try {
    const plan = plans()[req.query.plan];
    if (!plan || !plan.price) return res.status(400).json({ success: false, message: 'Choose a paid plan.' });
    const upi = upiConfig();
    if (!upi) return res.status(500).json({ success: false, message: 'UPI payments are not set up yet. Add PAYMENT_UPI_ID to .env.' });

    // reference the owner should see in your bank statement
    const note = `HK${req.owner.id} ${plan.name} plan`;
    const link =
      // pa keeps its "@" as-is (validated above) — some UPI apps don't decode %40
      `upi://pay?pa=${upi.id}&pn=${encodeURIComponent(upi.name)}` +
      `&am=${plan.price.toFixed(2)}&cu=INR&tn=${encodeURIComponent(note)}`;

    // QR image (needs `npm i qrcode` in the backend; works without it too)
    let qr = null;
    try {
      qr = await require('qrcode').toDataURL(link, { width: 280, margin: 1 });
    } catch (_) {
      /* qrcode package not installed — the page shows the UPI ID and app button instead */
    }

    res.json({ success: true, plan, upi_id: upi.id, payee: upi.name, amount: plan.price, note, link, qr });
  } catch (err) {
    next(err);
  }
});

router.post('/subscription/upi', async (req, res, next) => {
  try {
    const plan = plans()[req.body?.plan];
    if (!plan || !plan.price) return res.status(400).json({ success: false, message: 'Choose a paid plan.' });
    if (!upiConfig()) return res.status(500).json({ success: false, message: 'UPI payments are not set up yet.' });

    const utr = String(req.body?.utr || '').replace(/\s+/g, '');
    if (!/^\d{12}$/.test(utr)) {
      return res.status(400).json({ success: false, message: 'Enter the 12-digit UTR / UPI reference number from your payment app.' });
    }

    await ensureOwnTables();
    const [[used]] = await pool.query(
      `SELECT id FROM owner_subscriptions WHERE razorpay_payment_id = :utr OR razorpay_order_id = :oid LIMIT 1`,
      { utr, oid: `UPI-${utr}` }
    );
    if (used) return res.status(409).json({ success: false, message: 'This UTR has already been submitted.' });

    const [[pending]] = await pool.query(
      `SELECT id FROM owner_subscriptions WHERE admin_id = :a AND status = 'pending' LIMIT 1`,
      { a: req.owner.id }
    );
    if (pending) {
      return res.status(409).json({ success: false, message: 'You already have a payment waiting for confirmation. We’ll activate it shortly.' });
    }

    await pool.query(
      `INSERT INTO owner_subscriptions (admin_id, plan_code, amount_paise, currency, status, razorpay_order_id, razorpay_payment_id)
       VALUES (:a, :plan, :amount, 'INR', 'pending', :oid, :utr)`,
      { a: req.owner.id, plan: plan.code, amount: plan.price * 100, oid: `UPI-${utr}`, utr }
    );

    res.status(201).json({ success: true, message: 'Payment submitted. Your plan will be activated once we confirm it.' });
  } catch (err) {
    next(err);
  }
});

router.post('/subscription/order', async (req, res, next) => {
  try {
    const plan = plans()[req.body?.plan];
    if (!plan || !plan.price) return res.status(400).json({ success: false, message: 'Choose a paid plan.' });

    const rz = razorpayAuth();
    if (!rz) return res.status(500).json({ success: false, message: 'Payments are not set up yet. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to .env.' });

    await ensureOwnTables();
    const amount = plan.price * 100;
    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: rz.header },
      body: JSON.stringify({
        amount,
        currency: 'INR',
        receipt: `own_${req.owner.id}_${Date.now()}`.slice(0, 40),
        notes: { owner_id: String(req.owner.id), plan: plan.code },
      }),
    });
    const order = await r.json();
    if (!r.ok) {
      const desc = order?.error?.description || '';
      console.error('Razorpay order failed:', r.status, desc);
      return res.status(502).json({
        success: false,
        message: /authentication/i.test(desc)
          ? 'Card payments aren’t available right now. Please pay by UPI instead.'   // wrong Razorpay keys in .env
          : desc || 'Could not start the payment.',
      });
    }

    await pool.query(
      `INSERT INTO owner_subscriptions (admin_id, plan_code, amount_paise, currency, status, razorpay_order_id)
       VALUES (:admin, :plan, :amount, 'INR', 'created', :order)`,
      { admin: req.owner.id, plan: plan.code, amount, order: order.id }
    );

    res.json({
      success: true,
      key_id: rz.key,
      order_id: order.id,
      amount,
      currency: 'INR',
      plan,
      prefill: { name: req.owner.full_name, email: req.owner.email, contact: req.owner.phone },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/subscription/verify', async (req, res, next) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Payment details are missing.' });
    }
    const rz = razorpayAuth();
    if (!rz) return res.status(500).json({ success: false, message: 'Payments are not set up.' });

    await ensureOwnTables();
    const [[sub]] = await pool.query(
      'SELECT * FROM owner_subscriptions WHERE razorpay_order_id = :o AND admin_id = :a',
      { o: razorpay_order_id, a: req.owner.id }
    );
    if (!sub) return res.status(404).json({ success: false, message: 'Payment not found.' });
    if (sub.status === 'paid') return res.json({ success: true, message: 'Plan already active.' });

    // 1. signature check
    const expected = crypto.createHmac('sha256', rz.sec).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(razorpay_signature));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      await pool.query(`UPDATE owner_subscriptions SET status = 'failed' WHERE id = :id`, { id: sub.id });
      return res.status(400).json({ success: false, message: 'Payment could not be verified.' });
    }

    // 2. ask Razorpay that the payment really is for this order and amount
    const pr = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(razorpay_payment_id)}`, {
      headers: { Authorization: rz.header },
    });
    const payment = await pr.json();
    if (!pr.ok || payment.order_id !== razorpay_order_id || Number(payment.amount) !== Number(sub.amount_paise) ||
        !['captured', 'authorized'].includes(payment.status)) {
      return res.status(400).json({ success: false, message: 'Payment is not complete yet.' });
    }

    // 3. activate (extend if the same plan is still running)
    const plan = plans()[sub.plan_code];
    const [[current]] = await pool.query(
      `SELECT ends_at FROM owner_subscriptions
        WHERE admin_id = :a AND status = 'paid' AND plan_code = :p AND ends_at > NOW()
        ORDER BY ends_at DESC LIMIT 1`,
      { a: req.owner.id, p: sub.plan_code }
    );
    const start = current ? new Date(current.ends_at) : new Date();
    const end = new Date(start.getTime() + (plan?.days || 30) * 24 * 60 * 60 * 1000);

    await pool.query(
      `UPDATE owner_subscriptions
          SET status = 'paid', razorpay_payment_id = :pid, starts_at = :start, ends_at = :end
        WHERE id = :id`,
      { pid: razorpay_payment_id, start, end, id: sub.id }
    );

    res.json({ success: true, message: `${plan?.name || 'Plan'} is active.`, ends_at: end });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

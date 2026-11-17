// routes/super-admin.js  — mounted at /api/super-admin
//
// ONE super admin, credentials come from .env (never from the database):
//   SUPER_ADMIN_EMAIL=...
//   SUPER_ADMIN_PASSWORD=...
//   SUPER_ADMIN_NAME=...            (optional, shown in the panel)
//
//   POST  /login
//   GET   /stats
//   GET   /users                    PATCH /users/:id/status
//   GET   /schema/:resource         (rooms | cities)  → form fields + dropdown options
//   GET   /data/:resource           (rooms | cities | payments)
//   POST  /data/:resource           (rooms | cities)  → create
//
// The rooms / cities / payments endpoints read your real table columns at runtime,
// so they work whatever your exact column names are.

const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const pool = require('../config/db');

const router = express.Router();

const secret = () => process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET;

// ═══════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many login attempts. Try again in 15 minutes.' },
});

router.post('/login', loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const cfgEmail = process.env.SUPER_ADMIN_EMAIL;
  const cfgPassword = process.env.SUPER_ADMIN_PASSWORD;

  if (!cfgEmail || !cfgPassword || !secret()) {
    return res.status(500).json({
      success: false,
      message: 'Super admin is not configured. Add SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD to .env and restart.',
    });
  }
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required.' });
  }

  const emailOk = safeEqual(String(email).trim().toLowerCase(), cfgEmail.trim().toLowerCase());
  const passOk = safeEqual(password, cfgPassword);
  if (!(emailOk && passOk)) {
    return res.status(401).json({ success: false, message: 'Invalid credentials.' });
  }

  const token = jwt.sign({ role: 'superadmin', type: 'superadmin', email: cfgEmail }, secret(), { expiresIn: '12h' });
  res.json({
    success: true,
    token,
    admin: { name: process.env.SUPER_ADMIN_NAME || 'Super Admin', email: cfgEmail, role: 'superadmin' },
  });
});

function requireSuperAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: 'Super admin login required.' });

  try {
    const payload = jwt.verify(token, secret());
    if (payload.role !== 'superadmin') {
      return res.status(403).json({ success: false, message: 'Super admin only.' });
    }
    req.superAdmin = payload;
    next();
  } catch (_) {
    return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
  }
}

// Everything below needs the super admin token
router.use(requireSuperAdmin);

// ═══════════════════════════════════════════
//  SCHEMA HELPERS
// ═══════════════════════════════════════════

const RESOURCES = {
  rooms:    { candidates: ['rooms', 'property_rooms'], creatable: true },
  cities:   { candidates: ['cities'], creatable: true },
  payments: { candidates: ['payments', 'transactions', 'payment_transactions'], creatable: false },
};

// foreign-key columns that get a dropdown in forms
const REFS = {
  property_id: 'properties',
  city_id: 'cities',
  admin_id: 'admins',
  user_id: 'users',
};

let tableSet = null;
async function tables() {
  if (!tableSet) {
    const [rows] = await pool.query('SHOW TABLES');
    tableSet = new Set(rows.map((r) => Object.values(r)[0]));
  }
  return tableSet;
}

const columnCache = {};
async function getColumns(table) {
  if (!columnCache[table]) {
    const [cols] = await pool.query(`SHOW COLUMNS FROM \`${table}\``);
    columnCache[table] = cols;
  }
  return columnCache[table];
}

async function resolve(resource) {
  const def = RESOURCES[resource];
  if (!def) return null;
  const all = await tables();
  const table = def.candidates.find((t) => all.has(t));
  return table ? { table, ...def } : null;
}

function humanize(name) {
  return name.replace(/_id$/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function toField(col) {
  const type = col.Type.toLowerCase();
  let kind = 'text';
  let options = null;

  if (/^tinyint\(1\)/.test(type) || type === 'boolean' || type === 'bool') kind = 'boolean';
  else if (/^enum\(/.test(type)) {
    kind = 'select';
    options = [...col.Type.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  } else if (/int|decimal|float|double|numeric/.test(type)) kind = 'number';
  else if (type === 'date') kind = 'date';
  else if (/datetime|timestamp/.test(type)) kind = 'datetime';
  else if (/text|json/.test(type)) kind = 'textarea';

  const auto =
    /auto_increment/i.test(col.Extra) ||
    /default_generated|on update/i.test(col.Extra) ||
    ['created_at', 'updated_at', 'deleted_at'].includes(col.Field);

  return {
    name: col.Field,
    label: humanize(col.Field),
    kind,
    options,
    ref: REFS[col.Field] ? col.Field : null,
    required: col.Null === 'NO' && col.Default === null && !auto && kind !== 'boolean',
    default: col.Default,
    auto,
  };
}

async function lookup(table) {
  const all = await tables();
  if (!all.has(table)) return [];
  const cols = (await getColumns(table)).map((c) => c.Field);
  const labelCol = ['name', 'title', 'city_name', 'full_name', 'email'].find((c) => cols.includes(c)) || 'id';
  const withCity = table === 'properties' && cols.includes('city');
  const [rows] = await pool.query(
    `SELECT id, \`${labelCol}\` AS label${withCity ? ', city' : ''} FROM \`${table}\` LIMIT 2000`
  );
  return rows
    .map((r) => ({ id: r.id, label: r.city ? `${r.label} (${r.city})` : String(r.label ?? r.id) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function newestFirst(rows) {
  return [...rows].sort((a, b) => {
    if (a.created_at && b.created_at) return new Date(b.created_at) - new Date(a.created_at);
    return Number(b.id || 0) - Number(a.id || 0);
  });
}

// Never send card numbers / CVV / secrets to the browser
const MASK_LAST4 = /^(card_?number|card_?no|account_?number|acc_?no)$/i;
const HIDE = /(cvv|cvc|pin|secret|password|signature|otp|token)/i;
function redact(row) {
  const out = { ...row };
  for (const key of Object.keys(out)) {
    if (out[key] == null || out[key] === '') continue;
    if (MASK_LAST4.test(key)) out[key] = '•••• ' + String(out[key]).slice(-4);
    else if (HIDE.test(key)) out[key] = '[hidden]';
  }
  return out;
}

async function count(table) {
  try {
    const [[r]] = await pool.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
    return Number(r.n);
  } catch (_) {
    return null;
  }
}

async function tryQueries(queries) {
  let lastErr;
  for (const q of queries) {
    try {
      const [rows] = await pool.query(q);
      return rows;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// ═══════════════════════════════════════════
//  STATS
// ═══════════════════════════════════════════

router.get('/stats', async (req, res, next) => {
  try {
    const [rooms, cities, payments] = await Promise.all([resolve('rooms'), resolve('cities'), resolve('payments')]);
    const [users, admins, properties, bookings, roomCount, cityCount, paymentCount] = await Promise.all([
      count('users'),
      count('admins'),
      count('properties'),
      count('bookings'),
      rooms ? count(rooms.table) : null,
      cities ? count(cities.table) : null,
      payments ? count(payments.table) : null,
    ]);
    let pendingListings = null;
    try {
      const [[r]] = await pool.query('SELECT COUNT(*) AS n FROM properties WHERE is_verified = 0 OR is_verified IS NULL');
      pendingListings = Number(r.n);
    } catch (_) {
      /* no is_verified column */
    }
    let pendingPayments = null;
    try {
      const [[r]] = await pool.query(`SELECT COUNT(*) AS n FROM owner_subscriptions WHERE status = 'pending'`);
      pendingPayments = Number(r.n);
    } catch (_) {
      /* table not created yet */
    }
    res.json({
      success: true,
      stats: { users, admins, properties, bookings, rooms: roomCount, cities: cityCount, payments: paymentCount, pendingListings, pendingPayments },
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════
//  USERS
// ═══════════════════════════════════════════

function safeUser(u) {
  const { password_hash, otp_code, otp_expires, reset_token, reset_expires, ...safe } = u;
  return safe;
}

async function countBy(table, ids) {
  const map = new Map();
  if (!ids.length) return map;
  try {
    const [rows] = await pool.query(
      `SELECT user_id, COUNT(*) AS total FROM \`${table}\` WHERE user_id IN (:ids) GROUP BY user_id`,
      { ids }
    );
    for (const r of rows) map.set(Number(r.user_id), Number(r.total));
  } catch (_) {
    /* table or column missing */
  }
  return map;
}

router.get('/users', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM users');
    const users = newestFirst(rows);
    const ids = users.map((u) => Number(u.id));
    const [bookings, favorites] = await Promise.all([countBy('bookings', ids), countBy('favorites', ids)]);
    res.json({
      success: true,
      users: users.map((u) => ({
        ...safeUser(u),
        bookings_count: bookings.get(Number(u.id)) || 0,
        favorites_count: favorites.get(Number(u.id)) || 0,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/users/:id/status', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ success: false, message: 'Invalid user id.' });
    const active = req.body?.is_active ? 1 : 0;
    const [r] = await pool.query('UPDATE users SET is_active = :active WHERE id = :id', { active, id });
    if (!r.affectedRows) return res.status(404).json({ success: false, message: 'User not found.' });
    res.json({ success: true, id, is_active: active });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════
//  SCHEMA (form fields for rooms / cities)
// ═══════════════════════════════════════════

router.get('/schema/:resource', async (req, res, next) => {
  try {
    const r = await resolve(req.params.resource);
    if (!r) return res.status(404).json({ success: false, message: `No table found for "${req.params.resource}".` });

    const fields = (await getColumns(r.table)).map(toField).filter((f) => !f.auto);
    const lookups = {};
    for (const f of fields) {
      if (f.ref) lookups[f.ref] = await lookup(REFS[f.ref]);
    }
    res.json({ success: true, table: r.table, creatable: r.creatable, fields, lookups });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════
//  DATA: list
// ═══════════════════════════════════════════

router.get('/data/:resource', async (req, res, next) => {
  try {
    const resource = req.params.resource;
    const r = await resolve(resource);
    if (!r) return res.status(404).json({ success: false, message: `No table found for "${resource}".` });
    const t = `\`${r.table}\``;

    let rows;
    if (resource === 'rooms') {
      rows = await tryQueries([
        `SELECT r.*, p.name AS property_name, p.city AS property_city FROM ${t} r LEFT JOIN properties p ON p.id = r.property_id`,
        `SELECT r.*, p.name AS property_name FROM ${t} r LEFT JOIN properties p ON p.id = r.property_id`,
        `SELECT * FROM ${t}`,
      ]);
    } else if (resource === 'payments') {
      rows = await tryQueries([
        `SELECT pay.*, u.full_name AS user_name, u.email AS user_email, u.phone AS user_phone,
                b.booking_ref AS booking_reference, p.name AS property_name
           FROM ${t} pay
           LEFT JOIN bookings b   ON b.id = pay.booking_id
           LEFT JOIN users u      ON u.id = COALESCE(pay.user_id, b.user_id)
           LEFT JOIN properties p ON p.id = b.property_id`,
        `SELECT pay.*, u.full_name AS user_name, u.email AS user_email, u.phone AS user_phone, p.name AS property_name
           FROM ${t} pay
           LEFT JOIN bookings b   ON b.id = pay.booking_id
           LEFT JOIN users u      ON u.id = b.user_id
           LEFT JOIN properties p ON p.id = b.property_id`,
        `SELECT pay.*, u.full_name AS user_name, u.email AS user_email, u.phone AS user_phone
           FROM ${t} pay LEFT JOIN users u ON u.id = pay.user_id`,
        `SELECT * FROM ${t}`,
      ]);
      rows = rows.map(redact);
    } else {
      rows = await pool.query(`SELECT * FROM ${t}`).then(([x]) => x);
    }

    res.json({ success: true, table: r.table, count: rows.length, rows: newestFirst(rows) });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════
//  DATA: create (rooms / cities)
// ═══════════════════════════════════════════

router.post('/data/:resource', async (req, res, next) => {
  try {
    const r = await resolve(req.params.resource);
    if (!r) return res.status(404).json({ success: false, message: `No table found for "${req.params.resource}".` });
    if (!r.creatable) return res.status(405).json({ success: false, message: 'This list is read-only.' });

    const body = { ...(req.body || {}) };
    const fields = (await getColumns(r.table)).map(toField).filter((f) => !f.auto);
    const names = fields.map((f) => f.name);

    // auto-fill slug from the name if left empty
    if (names.includes('slug') && !body.slug) {
      const source = body.name || body.city_name || body.title;
      if (source) body.slug = slugify(source);
    }

    const data = {};
    const errors = [];
    for (const f of fields) {
      let v = body[f.name];
      if (v === undefined || v === null || v === '') {
        if (f.required) errors.push(`${f.label} is required`);
        continue;
      }
      if (f.kind === 'number') {
        v = Number(v);
        if (!Number.isFinite(v)) { errors.push(`${f.label} must be a number`); continue; }
      } else if (f.kind === 'boolean') {
        v = v === true || v === 'true' || v === 1 || v === '1' ? 1 : 0;
      } else if (f.kind === 'select') {
        if (!f.options.includes(String(v))) { errors.push(`${f.label} has an invalid value`); continue; }
      } else if (f.kind === 'datetime') {
        v = String(v).replace('T', ' ');
      } else {
        v = String(v).trim();
      }
      data[f.name] = v;
    }

    if (errors.length) return res.status(400).json({ success: false, message: errors.join(' · ') });
    if (!Object.keys(data).length) return res.status(400).json({ success: false, message: 'Nothing to save.' });

    const keys = Object.keys(data);
    const params = {};
    keys.forEach((k, i) => (params[`v${i}`] = data[k]));

    const [result] = await pool.query(
      `INSERT INTO \`${r.table}\` (${keys.map((k) => `\`${k}\``).join(', ')})
       VALUES (${keys.map((_, i) => `:v${i}`).join(', ')})`,
      params
    );

    let row = { id: result.insertId, ...data };
    try {
      const [[fresh]] = await pool.query(`SELECT * FROM \`${r.table}\` WHERE id = :id`, { id: result.insertId });
      if (fresh) row = fresh;
    } catch (_) {
      /* table has no id column */
    }

    res.status(201).json({ success: true, message: 'Saved.', row });
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'That entry already exists.' });
    }
    if (err && err.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(400).json({ success: false, message: 'A selected linked item does not exist.' });
    }
    next(err);
  }
});

// ═══════════════════════════════════════════
//  LISTINGS — review & approve properties
// ═══════════════════════════════════════════

router.get('/properties', async (req, res, next) => {
  try {
    const cols = (await getColumns('properties')).map((c) => c.Field);
    const ownerCol = cols.includes('admin_id') ? 'admin_id' : cols.includes('owner_id') ? 'owner_id' : null;

    const rows = await tryQueries([
      ownerCol
        ? `SELECT p.*, a.full_name AS owner_name, a.email AS owner_email, a.phone AS owner_phone
             FROM properties p LEFT JOIN admins a ON a.id = p.\`${ownerCol}\``
        : 'SELECT * FROM properties',
      'SELECT * FROM properties',
    ]);

    const ids = rows.map((p) => p.id);
    const covers = new Map();
    const photoCounts = new Map();
    const roomCounts = new Map();

    if (ids.length) {
      try {
        const [imgs] = await pool.query('SELECT * FROM property_images WHERE property_id IN (:ids)', { ids });
        for (const i of imgs) {
          if (!covers.has(i.property_id) || i.is_primary) covers.set(i.property_id, i.image_url || i.url || i.path);
          photoCounts.set(i.property_id, (photoCounts.get(i.property_id) || 0) + 1);
        }
      } catch (_) {}
      const roomsRes = await resolve('rooms');
      if (roomsRes) {
        try {
          const [rs] = await pool.query(
            `SELECT property_id, COUNT(*) AS n FROM \`${roomsRes.table}\` WHERE property_id IN (:ids) GROUP BY property_id`,
            { ids }
          );
          for (const r of rs) roomCounts.set(r.property_id, Number(r.n));
        } catch (_) {}
      }
    }

    res.json({
      success: true,
      canVerify: cols.includes('is_verified'),
      canHide: cols.includes('is_active'),
      properties: newestFirst(rows).map((p) => ({
        id: p.id,
        name: p.name || p.title || `Property #${p.id}`,
        area: p.area || p.locality || null,
        city: p.city || p.city_name || null,
        property_type: p.property_type || null,
        gender_allowed: p.gender_allowed || null,
        monthly_rent: p.monthly_rent ?? p.rent ?? null,
        created_at: p.created_at || null,
        is_verified: Number(p.is_verified) === 1,
        is_active: p.is_active === undefined ? true : Number(p.is_active) === 1,
        owner_name: p.owner_name || null,
        owner_email: p.owner_email || null,
        owner_phone: p.owner_phone || null,
        cover_image: covers.get(p.id) || null,
        photo_count: photoCounts.get(p.id) || 0,
        room_count: roomCounts.get(p.id) || 0,
      })),
    });
  } catch (err) {
    next(err);
  }
});

async function setPropertyFlag(req, res, next, column, label) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ success: false, message: 'Invalid listing id.' });

    const cols = (await getColumns('properties')).map((c) => c.Field);
    if (!cols.includes(column)) {
      return res.status(400).json({ success: false, message: `Your properties table has no ${column} column.` });
    }

    const value = req.body?.value ? 1 : 0;
    const [r] = await pool.query(`UPDATE properties SET \`${column}\` = :value WHERE id = :id`, { value, id });
    if (!r.affectedRows) return res.status(404).json({ success: false, message: 'Listing not found.' });

    res.json({ success: true, id, [column]: value, message: `${label}.` });
  } catch (err) {
    next(err);
  }
}

// { value: true } → approve, { value: false } → back to awaiting verification
router.patch('/properties/:id/verify', (req, res, next) =>
  setPropertyFlag(req, res, next, 'is_verified', req.body?.value ? 'Listing approved' : 'Approval removed')
);

// { value: false } → hide from tenants, { value: true } → show again
router.patch('/properties/:id/active', (req, res, next) =>
  setPropertyFlag(req, res, next, 'is_active', req.body?.value ? 'Listing is visible again' : 'Listing hidden')
);

// ═══════════════════════════════════════════
//  PLAN PAYMENTS — owners' subscription payments
//  UPI payments arrive as 'pending' until you confirm the money reached your bank.
// ═══════════════════════════════════════════
const PLAN_NAMES = { pro: 'Pro', business: 'Business' };
const PLAN_DAYS = 30;

router.get('/subscriptions', async (req, res, next) => {
  try {
    const rows = await tryQueries([
      `SELECT s.*, a.full_name AS owner_name, a.email AS owner_email, a.phone AS owner_phone
         FROM owner_subscriptions s LEFT JOIN admins a ON a.id = s.admin_id
        WHERE s.status IN ('pending', 'paid', 'rejected')
        ORDER BY (s.status = 'pending') DESC, s.id DESC`,
    ]).catch(() => []);

    res.json({
      success: true,
      subscriptions: rows.map((s) => ({
        id: s.id,
        owner_id: s.admin_id,
        owner_name: s.owner_name || `Owner #${s.admin_id}`,
        owner_email: s.owner_email || null,
        owner_phone: s.owner_phone || null,
        plan: s.plan_code,
        plan_name: PLAN_NAMES[s.plan_code] || s.plan_code,
        amount: Number(s.amount_paise) / 100,
        method: String(s.razorpay_order_id || '').startsWith('UPI-') ? 'upi' : 'razorpay',
        reference: s.razorpay_payment_id || null,
        status: s.status,
        starts_at: s.starts_at,
        ends_at: s.ends_at,
        created_at: s.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// { action: 'approve' } → plan active for 30 days (added on top of a running plan)
// { action: 'reject' }  → marked rejected, plan not activated
router.patch('/subscriptions/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const action = req.body?.action;
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ success: false, message: 'Invalid payment id.' });
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ success: false, message: 'Action must be approve or reject.' });

    const [[sub]] = await pool.query('SELECT * FROM owner_subscriptions WHERE id = :id', { id });
    if (!sub) return res.status(404).json({ success: false, message: 'Payment not found.' });
    if (sub.status !== 'pending') {
      return res.status(409).json({ success: false, message: `This payment is already ${sub.status}.` });
    }

    if (action === 'reject') {
      await pool.query(`UPDATE owner_subscriptions SET status = 'rejected' WHERE id = :id`, { id });
      return res.json({ success: true, id, status: 'rejected', message: 'Payment rejected.' });
    }

    const [[current]] = await pool.query(
      `SELECT ends_at FROM owner_subscriptions
        WHERE admin_id = :a AND status = 'paid' AND plan_code = :p AND ends_at > NOW()
        ORDER BY ends_at DESC LIMIT 1`,
      { a: sub.admin_id, p: sub.plan_code }
    );
    const start = current ? new Date(current.ends_at) : new Date();
    const end = new Date(start.getTime() + PLAN_DAYS * 24 * 60 * 60 * 1000);

    await pool.query(
      `UPDATE owner_subscriptions SET status = 'paid', starts_at = :start, ends_at = :end WHERE id = :id`,
      { start, end, id }
    );
    res.json({ success: true, id, status: 'paid', starts_at: start, ends_at: end, message: 'Plan activated.' });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════
//  OWNERS — who gets how many enquiries
// ═══════════════════════════════════════════

async function ownerColumn() {
  const cols = (await getColumns('properties')).map((c) => c.Field);
  return cols.includes('admin_id') ? 'admin_id' : cols.includes('owner_id') ? 'owner_id' : null;
}

async function bookingHasCreatedAt() {
  try {
    return (await getColumns('bookings')).some((c) => c.Field === 'created_at');
  } catch (_) {
    return false;
  }
}

router.get('/owners', async (req, res, next) => {
  try {
    const oc = await ownerColumn();
    if (!oc) return res.status(400).json({ success: false, message: 'Your properties table has no admin_id column.' });

    const [owners] = await pool.query(
      `SELECT a.*, COUNT(p.id) AS listings
         FROM admins a
         LEFT JOIN properties p ON p.\`${oc}\` = a.id
        GROUP BY a.id`
    );

    // enquiries per owner (bookings on that owner's properties)
    const hasDate = await bookingHasCreatedAt();
    const counts = new Map();
    const rows = await tryQueries([
      hasDate
        ? `SELECT p.\`${oc}\` AS owner_id,
                  COUNT(*) AS total,
                  SUM(b.created_at >= NOW() - INTERVAL 30 DAY) AS last30,
                  SUM(b.created_at >= NOW() - INTERVAL 7 DAY)  AS last7,
                  MAX(b.created_at) AS latest
             FROM bookings b JOIN properties p ON p.id = b.property_id
            GROUP BY p.\`${oc}\``
        : `SELECT p.\`${oc}\` AS owner_id, COUNT(*) AS total
             FROM bookings b JOIN properties p ON p.id = b.property_id
            GROUP BY p.\`${oc}\``,
    ]).catch(() => []);
    for (const r of rows) {
      counts.set(Number(r.owner_id), {
        total: Number(r.total) || 0,
        last30: r.last30 == null ? null : Number(r.last30),
        last7: r.last7 == null ? null : Number(r.last7),
        latest: r.latest || null,
      });
    }

    // status breakdown (new / confirmed / cancelled …)
    const statuses = new Map();
    const sRows = await tryQueries([
      `SELECT p.\`${oc}\` AS owner_id, COALESCE(b.status, 'new') AS status, COUNT(*) AS n
         FROM bookings b JOIN properties p ON p.id = b.property_id
        GROUP BY p.\`${oc}\`, COALESCE(b.status, 'new')`,
    ]).catch(() => []);
    for (const r of sRows) {
      const m = statuses.get(Number(r.owner_id)) || {};
      m[String(r.status).toLowerCase()] = Number(r.n);
      statuses.set(Number(r.owner_id), m);
    }

    // active paid plan
    const plans = new Map();
    const pRows = await tryQueries([
      `SELECT admin_id, plan_code, MAX(ends_at) AS ends_at
         FROM owner_subscriptions
        WHERE status = 'paid' AND ends_at > NOW()
        GROUP BY admin_id, plan_code`,
    ]).catch(() => []);
    for (const r of pRows) plans.set(Number(r.admin_id), { code: r.plan_code, ends_at: r.ends_at });

    const list = owners.map((o) => {
      const c = counts.get(Number(o.id)) || { total: 0, last30: hasDate ? 0 : null, last7: hasDate ? 0 : null, latest: null };
      return {
        id: o.id,
        full_name: o.full_name || o.name || `Owner #${o.id}`,
        email: o.email || null,
        phone: o.phone || null,
        is_active: o.is_active === undefined ? true : Number(o.is_active) === 1,
        joined_at: o.created_at || null,
        listings: Number(o.listings) || 0,
        enquiries: c.total,
        enquiries_30d: c.last30,
        enquiries_7d: c.last7,
        last_enquiry_at: c.latest,
        by_status: statuses.get(Number(o.id)) || {},
        plan: plans.get(Number(o.id))?.code || 'free',
        plan_ends_at: plans.get(Number(o.id))?.ends_at || null,
      };
    });

    list.sort((a, b) => b.enquiries - a.enquiries || b.listings - a.listings);
    res.json({ success: true, hasDates: hasDate, owners: list });
  } catch (err) {
    next(err);
  }
});

router.get('/owners/:id/enquiries', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ success: false, message: 'Invalid owner id.' });
    const oc = await ownerColumn();
    if (!oc) return res.status(400).json({ success: false, message: 'Your properties table has no admin_id column.' });

    const [rows] = await pool.query(
      `SELECT b.*, p.name AS property_name
         FROM bookings b JOIN properties p ON p.id = b.property_id
        WHERE p.\`${oc}\` = :id`,
      { id }
    );

    const pick = (o, keys) => {
      for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
      return null;
    };

    res.json({
      success: true,
      enquiries: newestFirst(rows).map((b) => ({
        id: b.id,
        ref: pick(b, ['booking_ref', 'booking_code', 'reference']) || `#${b.id}`,
        property_id: b.property_id,
        property_name: b.property_name,
        tenant_name: pick(b, ['full_name', 'name', 'tenant_name', 'guest_name']),
        tenant_phone: pick(b, ['phone', 'mobile', 'contact', 'guest_phone']),
        tenant_email: pick(b, ['email', 'guest_email']),
        move_in: pick(b, ['check_in_date', 'check_in', 'move_in_date', 'start_date']),
        months: pick(b, ['duration_months', 'duration', 'months']),
        status: String(pick(b, ['status', 'booking_status']) || 'new'),
        created_at: b.created_at || null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

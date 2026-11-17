// middleware/auth.js
const jwt  = require('jsonwebtoken');
const pool = require('../config/db');
function getTokenFromReq(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return null;
}

/**
 * requireAuth — blocks the request with 401 if no valid user JWT is present.
 * Use on routes that must not work for anonymous visitors (favorites, bookings/my).
 */
function requireAuth(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'Please log in to continue.' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.type !== 'user') {
      return res.status(401).json({ success: false, message: 'Invalid session. Please log in again.' });
    }
    req.user = payload; // { id, email, type }
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
  }
}

/**
 * optionalAuth — attaches req.user if a valid token is present, but never
 * blocks the request. Use on routes like property detail, where a logged-in
 * user should also get their `is_favorited` flag.
 */
function optionalAuth(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) return next();
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.type === 'user') req.user = payload;
  } catch (err) {
    // silently ignore bad/expired token on optional routes
  }
  next();
}

const authUser = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer '))
      return res.status(401).json({ success: false, message: 'No token provided' });

    const token   = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const [rows] = await pool.query(
      'SELECT id, full_name, email, phone, is_active FROM users WHERE id = ?',
      [decoded.id]
    );

    if (!rows.length || !rows[0].is_active)
      return res.status(401).json({ success: false, message: 'User not found or inactive' });

    req.user = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

const authAdmin = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer '))
      return res.status(401).json({ success: false, message: 'No token provided' });

    const token   = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_ADMIN_SECRET);

    const [rows] = await pool.query(
      'SELECT id, full_name, email, is_approved, is_active FROM admins WHERE id = ?',
      [decoded.id]
    );

    if (!rows.length || !rows[0].is_active)
      return res.status(401).json({ success: false, message: 'Admin not found or inactive' });

    if (!rows[0].is_approved)
      return res.status(403).json({ success: false, message: 'Admin account pending approval' });

    req.admin = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

module.exports = { requireAuth, optionalAuth, authUser, authAdmin };
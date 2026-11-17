// middleware/requireAdmin.js
// Allows the request only if it carries a valid ADMIN token.
// A normal user token (type: 'user') is always rejected.
const jwt = require('jsonwebtoken');

const ADMIN_ROLES = ['admin', 'superadmin', 'super_admin', 'owner'];

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, message: 'Admin login required.' });
  }

  let payload = null;
  // auth.admin.js signs admin tokens with JWT_ADMIN_SECRET
  const secrets = [process.env.JWT_ADMIN_SECRET, process.env.ADMIN_JWT_SECRET, process.env.JWT_SECRET].filter(Boolean);
  for (const secret of secrets) {
    try {
      payload = jwt.verify(token, secret);
      break;
    } catch (_) {
      /* try next secret */
    }
  }

  if (!payload) {
    return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
  }

  const isAdmin =
    payload.type === 'admin' ||
    ADMIN_ROLES.includes(String(payload.role || '').toLowerCase()) ||
    payload.isAdmin === true;

  if (!isAdmin) {
    return res.status(403).json({ success: false, message: 'Admins only.' });
  }

  req.admin = payload;
  next();
}

module.exports = { requireAdmin };
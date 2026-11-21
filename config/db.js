// config/db.js
// Local MySQL on your laptop, TiDB Cloud on the live site (Vercel).
const mysql = require('mysql2/promise');
require('dotenv').config();

const onVercel = !!process.env.VERCEL;

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  port:               Number(process.env.DB_PORT || 3306),
  user:               process.env.DB_USER     || 'root',
  password:           process.env.DB_PASSWORD || '',
  database:           process.env.DB_NAME     || 'hostel_booking_db',
  waitForConnections: true,
  // each running copy on Vercel opens its own connections, so keep it small there
  connectionLimit:    Number(process.env.DB_POOL_SIZE) || (onVercel ? 3 : 10),
  queueLimit:         0,
  namedPlaceholders:  true,
  charset:            'utf8mb4',
  enableKeepAlive:    true,
  connectTimeout:     20000, // the free TiDB plan can take a few seconds to wake up
  // TiDB Cloud needs an encrypted connection (DB_SSL=true); your local MySQL doesn't
  ssl: process.env.DB_SSL === 'true' ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined,
});



// Test connection on startup
(async () => {
  try {
    const conn = await pool.getConnection();
    console.log('✅ MySQL connected successfully');
    conn.release();
  } catch (err) {
    console.error('❌ MySQL connection failed:', err.message);
    // On your laptop: stop, so you notice straight away.
    // On Vercel: keep running — the next request will retry the connection.
    if (!onVercel) process.exit(1);
  }
})();

module.exports = pool;

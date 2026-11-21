// scripts/migrate-uploads-to-cloudinary.js
// One-time fix: photos saved while the site ran on your laptop have addresses like
// http://localhost:5000/uploads/abc.jpg in the database. This script uploads those
// files from your local "uploads" folder to Cloudinary and replaces the addresses
// in the LIVE database (TiDB) with the Cloudinary ones.
//
// 1. Create a file named .env.migrate next to package.json with:
//      DB_HOST=...tidbcloud.com
//      DB_PORT=4000
//      DB_USER=xxxx.root
//      DB_PASSWORD=...
//      DB_NAME=hostel_booking_db
//      DB_SSL=true
//      CLOUDINARY_URL=cloudinary://KEY:SECRET@CLOUD
//      UPLOAD_DIR=uploads
// 2. Preview (changes nothing):   node scripts/migrate-uploads-to-cloudinary.js
// 3. Do it:                        node scripts/migrate-uploads-to-cloudinary.js --apply
const path = require('path');
const fs = require('fs');

const envFile = path.join(__dirname, '..', '.env.migrate');
if (fs.existsSync(envFile)) require('dotenv').config({ path: envFile });

const APPLY = process.argv.includes('--apply');

// table → columns that can hold a photo address
const TARGETS = [
  { table: 'property_images', key: 'id', cols: ['image_url'] },
  { table: 'property_photos', key: 'id', cols: ['url'] },
  { table: 'users', key: 'id', cols: ['profile_pic'] },
  { table: 'admins', key: 'id', cols: ['profile_pic'] },
  { table: 'cities', key: 'id', cols: ['banner_image_url', 'thumb_image_url'] },
];

const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/uploads\//i;
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

async function run(pool, { apply = APPLY, log = console.log } = {}) {
  const storage = require('../services/storage');
  if (!storage.usingCloud()) throw new Error('CLOUDINARY_URL is missing. Add it to .env.migrate.');

  const uploadDir = storage.uploadDir;
  const [tableRows] = await pool.query('SHOW TABLES');
  const existing = new Set(tableRows.map((r) => Object.values(r)[0]));

  const done = new Map(); // same file used in several rows → upload once
  const summary = { found: 0, updated: 0, missing: [] };

  for (const t of TARGETS) {
    if (!existing.has(t.table)) continue;
    const [colRows] = await pool.query(`SHOW COLUMNS FROM \`${t.table}\``);
    const cols = t.cols.filter((c) => colRows.some((r) => r.Field === c));
    for (const col of cols) {
      const [rows] = await pool.query(
        `SELECT \`${t.key}\` AS k, \`${col}\` AS u FROM \`${t.table}\` WHERE \`${col}\` LIKE '%/uploads/%'`
      );
      for (const row of rows) {
        if (!LOCAL_URL.test(row.u || '')) continue;
        summary.found++;
        const fileName = decodeURIComponent(String(row.u).split('/uploads/').pop().split(/[?#]/)[0]);
        const filePath = path.join(uploadDir, fileName);

        if (!fs.existsSync(filePath)) {
          summary.missing.push(`${t.table}.${col} #${row.k}: ${fileName}`);
          continue;
        }

        let newUrl = done.get(fileName);
        if (!newUrl && apply) {
          const ext = path.extname(fileName).toLowerCase();
          const file = { buffer: fs.readFileSync(filePath), originalname: fileName, mimetype: MIME[ext] || 'image/jpeg' };
          const saved = await storage.saveImage(file, path.basename(fileName, ext), null);
          newUrl = saved.url;
          done.set(fileName, newUrl);
        }

        if (apply) {
          await pool.query(`UPDATE \`${t.table}\` SET \`${col}\` = :u WHERE \`${t.key}\` = :k`, { u: newUrl, k: row.k });
          summary.updated++;
          log(`✓ ${t.table}.${col} #${row.k} → ${newUrl}`);
        } else {
          log(`• would upload ${fileName}  (${t.table}.${col} #${row.k})`);
        }
      }
    }
  }
  return summary;
}

module.exports = { run };

if (require.main === module) {
  (async () => {
    const mysql = require('mysql2/promise');
    const pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'hostel_booking_db',
      namedPlaceholders: true,
      connectionLimit: 2,
      ssl: process.env.DB_SSL === 'true' ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined,
    });
    try {
      console.log(`Database: ${process.env.DB_HOST}  |  ${APPLY ? 'APPLYING CHANGES' : 'PREVIEW ONLY (add --apply to change things)'}\n`);
      const s = await run(pool);
      console.log(`\nLocal photo addresses found: ${s.found}`);
      if (APPLY) console.log(`Updated to Cloudinary: ${s.updated}`);
      if (s.missing.length) {
        console.log(`\n⚠ ${s.missing.length} file(s) not found in your uploads folder (left unchanged):`);
        s.missing.forEach((m) => console.log('  - ' + m));
      }
      if (!APPLY && s.found) console.log('\nLooks right? Run again with --apply');
    } catch (err) {
      console.error('✗ ' + err.message);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  })();
}

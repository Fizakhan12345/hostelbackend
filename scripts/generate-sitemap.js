// scripts/generate-sitemap.js
// Saves sitemap.xml and robots.txt into the Angular "public" folder,
// so they open at https://your-domain/sitemap.xml and /robots.txt.
//
// Run it from the hostelbackend folder (backend must be running):
//   node scripts/generate-sitemap.js
// Run it again whenever you add listings (or before each deploy).
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const SITE_URL = (process.env.SITE_URL || 'http://localhost:4200').replace(/\/+$/, '');
const API = (process.env.SEO_API_URL || `http://localhost:${process.env.PORT || 5000}/api`).replace(/\/+$/, '');
// Your folders: C:\Users\HP\Hostel\HostelBackend\hostelbackend  →  C:\Users\HP\Hostel\frontend\BelapurHostel\public
const PUBLIC_DIR = process.env.FRONTEND_PUBLIC_DIR || path.join(__dirname, '..', '..', '..', 'frontend', 'BelapurHostel', 'public');

async function save(name) {
  const res = await fetch(`${API}/home/${name}?origin=${encodeURIComponent(SITE_URL)}`);
  if (!res.ok) throw new Error(`${name}: backend answered ${res.status}`);
  const body = await res.text();
  fs.writeFileSync(path.join(PUBLIC_DIR, name), body, 'utf8');
  return body;
}

(async () => {
  if (!fs.existsSync(PUBLIC_DIR)) {
    console.error(`✗ Can't find the Angular public folder:\n  ${PUBLIC_DIR}\n  Set FRONTEND_PUBLIC_DIR in .env to the full path of BelapurHostel\\public`);
    process.exit(1);
  }
  try {
    const xml = await save('sitemap.xml');
    await save('robots.txt');
    const count = (xml.match(/<url>/g) || []).length;
    console.log(`✓ sitemap.xml (${count} pages) and robots.txt saved to ${PUBLIC_DIR}`);
    console.log(`  Open ${SITE_URL}/sitemap.xml and ${SITE_URL}/robots.txt to check.`);
  } catch (err) {
    console.error('✗ ' + err.message + '\n  Is the backend running? Start it first, then run this again.');
    process.exit(1);
  }
})();

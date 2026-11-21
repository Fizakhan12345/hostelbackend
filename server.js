// server.js — Main Entry Point (works locally AND on Vercel)
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const citiesRoutes = require('./routes/cities.routes');
const adminCitiesRoutes = require('./routes/admin.cities.routes');
const app = express();

// Vercel sits behind a proxy: needed for correct IPs (rate limits) and https URLs
app.set('trust proxy', 1);

// ── Middleware ────────────────────────────────────────────
// Allow photos to be shown on the frontend's domain
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// Frontend addresses allowed to call this API.
// Add more in Vercel as FRONTEND_URLS=https://a.com,https://b.com
const allowedOrigins = [
  'http://localhost:4200',
  'http://localhost:4000',
  'https://belapur-hostel.vercel.app',
  'https://belapur-hostel-fiza.vercel.app',
  ...String(`${process.env.FRONTEND_URL || ''},${process.env.FRONTEND_URLS || ''}`)
    .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
];
app.use(cors({
  origin: (origin, cb) => {
    // no origin = server-to-server, curl, the Angular SSR server
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    // Vercel preview deployments of the frontend project
    if (/^https:\/\/belapur-hostel[a-z0-9-]*\.vercel\.app$/.test(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS: ' + origin));
  },
  credentials: true,
}));
app.use(morgan(process.env.VERCEL ? 'tiny' : 'dev'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Uploaded photos. On Vercel set UPLOAD_DIR=/tmp/uploads (temporary until photos move to Cloudinary)
const uploadDir = path.resolve(__dirname, process.env.UPLOAD_DIR || 'uploads');
app.use('/uploads', express.static(uploadDir));

// ── Route Imports ─────────────────────────────────────────
const userAuthRoutes = require('./routes/auth.user');
const adminAuthRoutes = require('./routes/auth.admin');
const propertyRoutes = require('./routes/properties');
const propertySearchRoutes = require('./routes/property.search.routes');
const bookingRoutes = require('./routes/bookings');
const paymentRoutes = require('./routes/payments');
const reviewRoutes = require('./routes/reviews');
const favRouter = reviewRoutes.favRouter;
const dashRouter = reviewRoutes.dashRouter;
const amenitiesRoutes = require('./routes/amenities');
const userListsRoutes = require('./routes/user.lists');      // saved hostels + my bookings
const superAdminRoutes = require('./routes/super-admin');    // super admin console
const ownerRoutes = require('./routes/owner');               // property owner portal
const homeRoutes = require('./routes/home');                 // home, cities, search, sitemap

// Booking limiter must run BEFORE the bookings routes
const bookingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many booking attempts. Please try again in a minute.' },
});
app.use('/api/bookings', (req, res, next) => (req.method === 'POST' ? bookingLimiter(req, res, next) : next()));

// ── Mount Routes ──────────────────────────────────────────
app.use('/api/auth', userAuthRoutes);
app.use('/api/admin/auth', adminAuthRoutes);

// /api/properties/search must stay ABOVE /api/properties/:id
app.use('/api/properties', propertySearchRoutes);
app.use('/api/properties', propertyRoutes);

app.use('/api/bookings', bookingRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/favorites', favRouter);
app.use('/api/dashboard', dashRouter);
app.use('/api/amenities', amenitiesRoutes);
app.use('/api/cities', citiesRoutes);
app.use('/api/admin/cities', adminCitiesRoutes);
app.use('/api/me', userListsRoutes);
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/owner', ownerRoutes);
app.use('/api/home', homeRoutes);

// ── Health Check (also tests the database) ────────────────
app.get('/api/health', async (req, res) => {
  let database = 'ok';
  try {
    await require('./config/db').query('SELECT 1');
  } catch (e) {
    database = 'error: ' + e.message;
  }
  res.json({
    success: true,
    message: '🏠 Hostel Booking API is running',
    version: '1.0.0',
    database,
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (req, res) => res.json({ success: true, message: 'HostelKhojo API. Try /api/health' }));

// ── 404 Handler ───────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

// ── Global Error Handler ──────────────────────────────────
app.use((err, req, res, next) => {
  if (String(err.message || '').startsWith('Not allowed by CORS')) {
    return res.status(403).json({ success: false, message: err.message });
  }
  console.error('❌ Error:', err.stack);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// ── Start Server ──────────────────────────────────────────
// On your computer: starts on port 5000.
// On Vercel: Vercel runs the exported app itself, so no listen().
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`📋 Health check: http://localhost:${PORT}/api/health\n`);
  });
}

module.exports = app;

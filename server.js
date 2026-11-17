// server.js — Main Entry Point
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

// ── Middleware ────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }   // lets <img> load from Angular
}));
app.use(cors({
  origin: [
    'http://localhost:4200',
    'https://belapur-hostel-fiza.vercel.app'
  ],
  credentials: true
}));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static uploads — same folder multer writes to
app.use('/uploads', express.static(path.join(__dirname, process.env.UPLOAD_DIR || 'uploads')));


// ── Route Imports ─────────────────────────────────────────
const userAuthRoutes = require('./routes/auth.user');
const adminAuthRoutes = require('./routes/auth.admin');
const propertyRoutes = require('./routes/properties');
const propertySearchRoutes = require('./routes/property.search.routes');   // ⬅ added — note the DOT, matches your actual filename
const bookingRoutes = require('./routes/bookings');
const paymentRoutes = require('./routes/payments');
const reviewRoutes = require('./routes/reviews');
const favRouter = reviewRoutes.favRouter;    // ✅ correct
const dashRouter = reviewRoutes.dashRouter;   // ✅ correct
const amenitiesRoutes = require('./routes/amenities');   // ⬅ added

// ── Mount Routes ──────────────────────────────────────────
app.use('/api/auth', userAuthRoutes);
app.use('/api/admin/auth', adminAuthRoutes);
// app.use('/api/admin/users', require('./routes/admin.users'));
app.use('/api/owner', require('./routes/owner'));
app.use('/api/super-admin', require('./routes/super-admin'));
app.use('/api/home', require('./routes/home'));
// IMPORTANT: propertySearchRoutes (GET /api/properties/search) MUST be
// mounted BEFORE propertyRoutes (which has GET /api/properties/:id),
// or a request to /search gets swallowed as if id="search".
app.use('/api/properties', propertySearchRoutes);   // ⬅ added, must stay above the next line
app.use('/api/properties', propertyRoutes);
app.use('/uploads', express.static(path.join(__dirname, process.env.UPLOAD_DIR || 'uploads')));

app.use('/api/bookings', bookingRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/favorites', favRouter);
app.use('/api/dashboard', dashRouter);
app.use('/api/amenities', amenitiesRoutes);   // ⬅ added


app.use('/api/cities', citiesRoutes);
app.use('/api/admin/cities', adminCitiesRoutes);
app.use('/api/me', require('./routes/user.lists'));

const bookingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  message: { success: false, message: 'Too many booking attempts. Please try again in a minute.' },
});
app.use('/api/bookings', (req, res, next) => (req.method === 'POST' ? bookingLimiter(req, res, next) : next()));

// ── Health Check ──────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: '🏠 Hostel Booking API is running',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// ── 404 Handler ───────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

// ── Global Error Handler ──────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.stack);
  res.status(500).json({ success: false, message: 'Internal server error' });
});


// ── Start Server ──────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/api/health\n`);
});
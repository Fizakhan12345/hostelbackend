require('dotenv').config();  // ← add this if missing
const mysql = require('mysql2/promise');

const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const morgan   = require('morgan');


const path     = require('path');

const app = express();

// ── Middleware ────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: [
    'http://localhost:4200',   // Angular dev
    'https://belapur-hostel-fiza.vercel.app'
  ],
  credentials: true
}));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files (uploaded images)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── Routes ────────────────────────────────────────────────
const userAuthRoutes  = require('./routes/auth.user');
const adminAuthRoutes = require('./routes/auth.admin');
const propertyRoutes  = require('./routes/properties');
const bookingRoutes   = require('./routes/bookings');
const paymentRoutes   = require('./routes/payments');
const reviewRoutes    = require('./routes/reviews');
const { favRouter, dashRouter } = require('./routes/reviews');

app.use('/api/auth',        userAuthRoutes);
app.use('/api/admin/auth',  adminAuthRoutes);
app.use('/api/properties',  propertyRoutes);
app.use('/api/bookings',    bookingRoutes);
app.use('/api/payments',    paymentRoutes);
app.use('/api/reviews',     reviewRoutes);
app.use('/api/favorites',   favRouter);
app.use('/api/dashboard',   dashRouter);

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
  console.log(`📋 API Docs: http://localhost:${PORT}/api/health\n`);
});
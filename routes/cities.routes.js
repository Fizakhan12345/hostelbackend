// routes/cities.routes.js
const express = require('express');
const router = express.Router();
const { listCities, getCityBySlug } = require('../config/controller/cities.controller');

// GET /api/cities?featured=1
router.get('/', listCities);

// GET /api/cities/:slug
router.get('/:slug', getCityBySlug);

module.exports = router;
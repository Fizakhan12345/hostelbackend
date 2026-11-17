// routes/property.search.routes.js
const express = require('express');
const router = express.Router();
const { searchProperties } = require('../config/controller/property.search.controller');

// GET /api/properties/search?rentType=monthly&citySlug=mumbai&...
router.get('/search', searchProperties);

module.exports = router;
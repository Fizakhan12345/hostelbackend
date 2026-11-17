// routes/admin.cities.routes.js
const express = require('express');
const router = express.Router();

// Matches middleware/auth.js -> module.exports = { authUser, authAdmin }
const { authAdmin } = require('../middleware/auth');

const {
  createCity,
  updateCity,
  deleteCity,
  listAllCitiesAdmin,
} = require('../config/controller/admin.cities.controller');

router.get('/', authAdmin, listAllCitiesAdmin);
router.post('/', authAdmin, createCity);
router.put('/:id', authAdmin, updateCity);
router.delete('/:id', authAdmin, deleteCity);

module.exports = router;
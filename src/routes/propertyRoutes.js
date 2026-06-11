const express = require('express');
const router = express.Router();

const { getProperties, getProperty } = require('../controllers/propertycontroller');

router.get('/', getProperties);
router.get('/:id', getProperty);

module.exports = router;
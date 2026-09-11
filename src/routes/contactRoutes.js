const express = require('express');
const createRateLimit = require('../middleware/rateLimit');
const { submitContactForm } = require('../controllers/contactController');

const router = express.Router();


const perIpLimit = createRateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10,
    keyGenerator: (req) => `contact:ip:${req.ip}`,
    message: 'Too many messages sent from this connection. Please try again in an hour.',
});

const perEmailLimit = createRateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 4,
    // Returning null skips the limiter  invalid/missing emails are rejected by
    // the controller's validation anyway.
    keyGenerator: (req) => {
        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        return email ? `contact:email:${email}` : null;
    },
    message: 'You have already sent us several messages. Please wait before sending another.',
});

// POST /api/contact
router.post('/', perIpLimit, perEmailLimit, submitContactForm);

module.exports = router;

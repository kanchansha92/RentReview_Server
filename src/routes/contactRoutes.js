const express = require('express');
const createRateLimit = require('../middleware/rateLimit');
const { submitContactForm } = require('../controllers/contactController');

const router = express.Router();

// The endpoint is unauthenticated and sends mail, so it is the obvious target
// for mail-bombing. Two limiters: one per IP, one per submitted email address
// (so a botnet cannot flood a single inbox from many addresses).
// NOTE: the limiter counts every request, including ones that fail validation,
// so the per-IP allowance is set high enough that a few typos plus a shared
// office/mobile NAT address still leave room for a genuine message.
const perIpLimit = createRateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10,
    keyGenerator: (req) => `contact:ip:${req.ip}`,
    message: 'Too many messages sent from this connection. Please try again in an hour.',
});

const perEmailLimit = createRateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 4,
    // Returning null skips the limiter — invalid/missing emails are rejected by
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

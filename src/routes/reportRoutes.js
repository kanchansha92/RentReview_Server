const express = require('express');
const router = express.Router();

const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const createRateLimit = require('../middleware/rateLimit');
const {
    submitReport,
    getReports,
    decideReport,
    restoreReview,
} = require('../controllers/reportController');

const perIpLimit = createRateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    keyGenerator: (req) => `report:ip:${req.ip}`,
    message: 'Too many reports from this connection. Please try again in an hour.',
});

const perEmailLimit = createRateLimit({
    windowMs: 60 * 60 * 1000,
    max: 6,
    keyGenerator: (req) => {
        const email = typeof req.body?.reporterEmail === 'string'
            ? req.body.reporterEmail.trim().toLowerCase()
            : '';
        // Returning null skips the limiter; a missing address is rejected by
        // validation anyway.
        return email ? `report:email:${email}` : null;
    },
    message: 'You have already sent us several reports. Please wait before sending another.',
});

router.post('/', perIpLimit, perEmailLimit, submitReport);

// ── Admin queue ──────────────────────────────────────────────────────────────
// A report carries the complainant's name and email  someone who is not a user
// of this site and never agreed to be one. Admin only.
router.get('/admin', protect, authorizeRoles('admin'), getReports);

// Three path segments, so this cannot be captured by '/admin/:id' below.
router.put('/admin/reviews/:id/restore', protect, authorizeRoles('admin'), restoreReview);

router.put('/admin/:id', protect, authorizeRoles('admin'), decideReport);

module.exports = router;

const express = require('express');
const router = express.Router();

const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const upload = require('../middleware/Upload');
const { preUploadCheck } = require('../middleware/validateReview');
const createRateLimit = require('../middleware/rateLimit');
const {
    createReview,
    getReviews,
    getReview,
    getPropertyReviews,
    getMyReviews,
    updateReview,
    deleteReview,
    getPendingVerifications,
    decidePendingVerification,
} = require('../controllers/reviewController');

// Review creation runs OCR (Tesseract) inline and accepts up to 11 files. Even
// with the concurrency cap in verifyId.js, an authenticated user looping this
// endpoint is the most expensive thing they can do to the server.
const createReviewLimiter = createRateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    keyGenerator: (req) => `review:create:${req.user?.id || req.ip}`,
    message: 'Too many review submissions. Please try again later.',
});

// ── Admin ─────────────────────────────────────────────────────────────────
// The ID-verification queue. Reviews whose OCR check didn't auto-verify sit here
// waiting on a human — without this route the `verified: false` records the
// submission flow writes are unreachable by anyone. This is also the only place
// `verification` (idNumber / idProof, `select: false` on the schema) is ever
// read back, so it must be admin-gated. Declared BEFORE '/:id' or Express would
// match 'pending-verifications' as a review id.
router.get(
    '/admin/pending-verifications',
    protect,
    authorizeRoles('admin'),
    getPendingVerifications
);

// Record a decision and close the item. Without this the queue had no exit: an
// admin could read the pending pile but never act on it, so nothing ever left.
// Approving or rejecting both destroy the ID document — see the handler.
// Three path segments, so this cannot be captured by the '/:id' routes below.
router.put(
    '/admin/:id/verification',
    protect,
    authorizeRoles('admin'),
    decidePendingVerification
);

// ── Public reads ──────────────────────────────────────────────────────────
router.get('/', getReviews);
router.get('/me', protect, getMyReviews);            // must be BEFORE '/:id'
router.get('/property/:propertyId', getPropertyReviews);
router.get('/:id', getReview);

// ── Create (protected, accepts multipart/form-data with files) ─────────────
// preUploadCheck runs BEFORE upload.fields so obviously-bad requests never reach
// Cloudinary; the body-dependent checks can't run until multer has parsed the
// multipart payload, so they live at the top of createReview and every non-201
// exit there calls cleanupUploads(). Multer errors (fileFilter / LIMIT_FILE_SIZE)
// are deliberately NOT caught here — they carry a status and are handled by the
// global error handler in index.js.
router.post(
    '/',
    protect,
    createReviewLimiter,
    preUploadCheck,
    upload.fields([
        { name: 'idProof', maxCount: 1 },
        { name: 'photos', maxCount: 10 },
    ]),
    createReview
);

// ── Update / delete own review (protected) ─────────────────────────────────
router.put('/:id', protect, updateReview);
router.delete('/:id', protect, deleteReview);


module.exports = router;

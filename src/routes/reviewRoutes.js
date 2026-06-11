// const express = require('express');
// const router = express.Router();

// const { protect } = require('../middleware/authMiddleware');
// const upload = require('../middleware/Upload');
// const {
//     createReview,
//     getReviews,
//     getReview,
//     getPropertyReviews,
//     getMyReviews,
//     updateReview,
//     deleteReview,
// } = require('../controllers/reviewcontroller');

// // ── Public reads ──────────────────────────────────────────────────────────
// router.get('/', getReviews);
// router.get('/me', protect, getMyReviews);            // must be BEFORE '/:id'
// router.get('/property/:propertyId', getPropertyReviews);
// router.get('/:id', getReview);

// // ── Create (protected, accepts multipart/form-data with files) ─────────────
// router.post(
//     '/',
//     protect,
//     upload.fields([
//         { name: 'idProof', maxCount: 1 },
//         { name: 'photos', maxCount: 10 },
//     ]),
//     createReview
// );

// // ── Update / delete own review (protected) ─────────────────────────────────
// router.put('/:id', protect, updateReview);
// router.delete('/:id', protect, deleteReview);

// module.exports = router;







const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/authMiddleware');
const upload = require('../middleware/Upload');
const {
    createReview,
    getReviews,
    getReview,
    getPropertyReviews,
    getMyReviews,
    updateReview,
    deleteReview,
} = require('../controllers/reviewcontroller');

// ── Public reads ──────────────────────────────────────────────────────────
router.get('/', getReviews);
router.get('/me', protect, getMyReviews);            // must be BEFORE '/:id'
router.get('/property/:propertyId', getPropertyReviews);
router.get('/:id', getReview);

// ── Create (protected, accepts multipart/form-data with files) ─────────────
router.post(
    '/',
    protect,
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
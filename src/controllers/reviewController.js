// const mongoose = require('mongoose');
// const Review = require('../models/Review');
// const Property = require('../models/Property');
// const { geocodeAddress } = require('../utils/Geocode');
// // const { geocodeAddress } = require('../utils/geocode');

// // ─── Helpers ─────────────────────────────────────────────────────────────
// // Accept either a newline-separated string (from a textarea) or an array.
// const toLines = (val) => {
//     if (Array.isArray(val)) return val.map((s) => String(s).trim()).filter(Boolean);
//     if (typeof val === 'string') return val.split('\n').map((s) => s.trim()).filter(Boolean);
//     return [];
// };

// // Recalculate a property's average rating + review count.
// const recalcProperty = async (propertyId) => {
//     const stats = await Review.aggregate([
//         { $match: { property: new mongoose.Types.ObjectId(propertyId) } },
//         { $group: { _id: '$property', avg: { $avg: '$rating' }, count: { $sum: 1 } } },
//     ]);
//     const avg = stats[0]?.avg || 0;
//     const count = stats[0]?.count || 0;
//     await Property.findByIdAndUpdate(propertyId, {
//         rating: Math.round(avg * 10) / 10,
//         reviewsCount: count,
//     });
// };

// // @desc    Create a review (finds/creates the property, recalcs aggregate)
// // @route   POST /api/reviews
// // @access  Private
// const createReview = async (req, res) => {
//     try {
//         const {
//             streetAddress, city, state, zipCode,
//             rating, name, reviewTitle, review,
//             pros, cons, idType, idNumber,
//             type, price,
//         } = req.body;

//         // ── Validation ──────────────────────────────────────────────────────
//         if (!streetAddress?.trim() || !city?.trim() || !state?.trim()) {
//             return res.status(400).json({ message: 'Street address, city, and state are required.' });
//         }
//         const numericRating = Number(rating);
//         if (!numericRating || numericRating < 1 || numericRating > 5) {
//             return res.status(400).json({ message: 'Please select a rating between 1 and 5.' });
//         }
//         if (!name?.trim()) return res.status(400).json({ message: 'Your name is required.' });
//         if (!reviewTitle?.trim()) return res.status(400).json({ message: 'Review title is required.' });
//         if (!review?.trim()) return res.status(400).json({ message: 'Review text is required.' });

//         // ── Find or create the property ──────────────────────────────────────
//         const addressQuery = {
//             streetAddress: streetAddress.trim(),
//             city: city.trim(),
//             state: state.trim(),
//         };

//         let property = await Property.findOne(addressQuery);
//         if (!property) {
//             const coords = await geocodeAddress(
//                 `${streetAddress.trim()}, ${city.trim()}, ${state.trim()} ${zipCode?.trim() || ''}`
//             );
//             property = await Property.create({
//                 ...addressQuery,
//                 title: streetAddress.trim(),
//                 zipCode: zipCode?.trim() || '',
//                 location: `${city.trim()}, ${state.trim()}`,
//                 type: type || 'Other',
//                 price: price ? Number(price) : null,
//                 coords,
//             });
//         }

//         // ── One review per user per property ─────────────────────────────────
//         const existing = await Review.findOne({ property: property._id, user: req.user.id });
//         if (existing) {
//             return res.status(409).json({ message: 'You have already reviewed this property.' });
//         }

//         // ── Files (from multer; optional) ────────────────────────────────────
//         const photos = (req.files?.photos || []).map((f) => `/uploads/${f.filename}`);
//         const idProof = req.files?.idProof?.[0] ? `/uploads/${req.files.idProof[0].filename}` : '';

//         // ── Create the review ────────────────────────────────────────────────
//         const newReview = await Review.create({
//             property: property._id,
//             user: req.user.id,
//             reviewerName: name.trim(),
//             rating: numericRating,
//             title: reviewTitle.trim(),
//             body: review.trim(),
//             pros: toLines(pros),
//             cons: toLines(cons),
//             photos,
//             verification: {
//                 idType: idType || '',
//                 idNumber: idNumber || '',
//                 idProof,
//                 verified: false,
//             },
//         });

//         await recalcProperty(property._id);

//         // Re-fetch without the private verification block
//         const safeReview = await Review.findById(newReview._id);

//         res.status(201).json({
//             success: true,
//             message: 'Review submitted successfully!',
//             review: safeReview,
//             propertyId: property._id,
//         });
//     } catch (error) {
//         if (error.code === 11000) {
//             return res.status(409).json({ message: 'You have already reviewed this property.' });
//         }
//         console.error('Create review error:', error.message);
//         res.status(500).json({ message: 'Server error. Please try again later.' });
//     }
// };

// // @desc    Get all reviews (optional ?property= ?rating= ?sort=)
// // @route   GET /api/reviews
// // @access  Public
// const getReviews = async (req, res) => {
//     try {
//         const { property, rating, sort } = req.query;
//         const filter = {};
//         if (property) filter.property = property;
//         if (rating) filter.rating = Number(rating);

//         const sortOption =
//             sort === 'oldest' ? { createdAt: 1 }
//                 : sort === 'highest' ? { rating: -1, createdAt: -1 }
//                     : sort === 'lowest' ? { rating: 1, createdAt: -1 }
//                         : { createdAt: -1 }; // newest (default)

//         const reviews = await Review.find(filter)
//             .populate('property', 'title location type image')
//             .sort(sortOption);

//         res.json({ success: true, count: reviews.length, reviews });
//     } catch (error) {
//         console.error('Get reviews error:', error.message);
//         res.status(500).json({ message: 'Server error. Please try again later.' });
//     }
// };

// // @desc    Get a single review
// // @route   GET /api/reviews/:id
// // @access  Public
// const getReview = async (req, res) => {
//     try {
//         const review = await Review.findById(req.params.id)
//             .populate('property', 'title location type image');
//         if (!review) return res.status(404).json({ message: 'Review not found.' });
//         res.json({ success: true, review });
//     } catch (error) {
//         if (error.kind === 'ObjectId') {
//             return res.status(404).json({ message: 'Review not found.' });
//         }
//         console.error('Get review error:', error.message);
//         res.status(500).json({ message: 'Server error. Please try again later.' });
//     }
// };

// // @desc    Get all reviews for one property
// // @route   GET /api/reviews/property/:propertyId
// // @access  Public
// const getPropertyReviews = async (req, res) => {
//     try {
//         const reviews = await Review.find({ property: req.params.propertyId }).sort({ createdAt: -1 });
//         res.json({ success: true, count: reviews.length, reviews });
//     } catch (error) {
//         console.error('Get property reviews error:', error.message);
//         res.status(500).json({ message: 'Server error. Please try again later.' });
//     }
// };

// // @desc    Get the logged-in user's reviews
// // @route   GET /api/reviews/me
// // @access  Private
// const getMyReviews = async (req, res) => {
//     try {
//         const reviews = await Review.find({ user: req.user.id })
//             .populate('property', 'title location type image')
//             .sort({ createdAt: -1 });
//         res.json({ success: true, count: reviews.length, reviews });
//     } catch (error) {
//         console.error('Get my reviews error:', error.message);
//         res.status(500).json({ message: 'Server error. Please try again later.' });
//     }
// };

// // @desc    Update own review
// // @route   PUT /api/reviews/:id
// // @access  Private
// const updateReview = async (req, res) => {
//     try {
//         const review = await Review.findById(req.params.id);
//         if (!review) return res.status(404).json({ message: 'Review not found.' });
//         if (review.user.toString() !== req.user.id) {
//             return res.status(403).json({ message: 'You can only edit your own review.' });
//         }

//         const { rating, reviewTitle, review: body, pros, cons } = req.body;

//         if (rating !== undefined) {
//             const r = Number(rating);
//             if (!r || r < 1 || r > 5) {
//                 return res.status(400).json({ message: 'Rating must be between 1 and 5.' });
//             }
//             review.rating = r;
//         }
//         if (reviewTitle !== undefined) review.title = reviewTitle.trim();
//         if (body !== undefined) review.body = body.trim();
//         if (pros !== undefined) review.pros = toLines(pros);
//         if (cons !== undefined) review.cons = toLines(cons);

//         await review.save();
//         await recalcProperty(review.property);

//         const updated = await Review.findById(review._id);
//         res.json({ success: true, message: 'Review updated.', review: updated });
//     } catch (error) {
//         if (error.kind === 'ObjectId') {
//             return res.status(404).json({ message: 'Review not found.' });
//         }
//         console.error('Update review error:', error.message);
//         res.status(500).json({ message: 'Server error. Please try again later.' });
//     }
// };

// // @desc    Delete own review
// // @route   DELETE /api/reviews/:id
// // @access  Private
// const deleteReview = async (req, res) => {
//     try {
//         const review = await Review.findById(req.params.id);
//         if (!review) return res.status(404).json({ message: 'Review not found.' });
//         if (review.user.toString() !== req.user.id) {
//             return res.status(403).json({ message: 'You can only delete your own review.' });
//         }

//         const propertyId = review.property;
//         await review.deleteOne();
//         await recalcProperty(propertyId);

//         res.json({ success: true, message: 'Review deleted.' });
//     } catch (error) {
//         if (error.kind === 'ObjectId') {
//             return res.status(404).json({ message: 'Review not found.' });
//         }
//         console.error('Delete review error:', error.message);
//         res.status(500).json({ message: 'Server error. Please try again later.' });
//     }
// };

// module.exports = {
//     createReview,
//     getReviews,
//     getReview,
//     getPropertyReviews,
//     getMyReviews,
//     updateReview,
//     deleteReview,
// };






// const mongoose = require('mongoose');
// const Review = require('../models/Review');
// const Property = require('../models/Property');
// const { geocodeAddress } = require('../utils/geocode');

// // ─── Helpers ─────────────────────────────────────────────────────────────
// // Accept either a newline-separated string (from a textarea) or an array.
// const toLines = (val) => {
//     if (Array.isArray(val)) return val.map((s) => String(s).trim()).filter(Boolean);
//     if (typeof val === 'string') return val.split('\n').map((s) => s.trim()).filter(Boolean);
//     return [];
// };

// // Recalculate a property's average rating + review count.
// const recalcProperty = async (propertyId) => {
//     const stats = await Review.aggregate([
//         { $match: { property: new mongoose.Types.ObjectId(propertyId) } },
//         { $group: { _id: '$property', avg: { $avg: '$rating' }, count: { $sum: 1 } } },
//     ]);
//     const avg = stats[0]?.avg || 0;
//     const count = stats[0]?.count || 0;
//     await Property.findByIdAndUpdate(propertyId, {
//         rating: Math.round(avg * 10) / 10,
//         reviewsCount: count,
//     });
// };

// // @desc    Create a review (finds/creates the property, recalcs aggregate)
// // @route   POST /api/reviews
// // @access  Private
// const createReview = async (req, res) => {
//     try {
//         const {
//             streetAddress, city, state, zipCode,
//             rating, name, reviewTitle, review,
//             pros, cons, idType, idNumber,
//             type, price,
//         } = req.body;

//         // ── Validation ──────────────────────────────────────────────────────
//         if (!streetAddress?.trim() || !city?.trim() || !state?.trim()) {
//             return res.status(400).json({ message: 'Street address, city, and state are required.' });
//         }
//         const numericRating = Number(rating);
//         if (!numericRating || numericRating < 1 || numericRating > 5) {
//             return res.status(400).json({ message: 'Please select a rating between 1 and 5.' });
//         }
//         if (!name?.trim()) return res.status(400).json({ message: 'Your name is required.' });
//         if (!reviewTitle?.trim()) return res.status(400).json({ message: 'Review title is required.' });
//         if (!review?.trim()) return res.status(400).json({ message: 'Review text is required.' });

//         // ── Find or create the property ──────────────────────────────────────
//         const addressQuery = {
//             streetAddress: streetAddress.trim(),
//             city: city.trim(),
//             state: state.trim(),
//         };

//         let property = await Property.findOne(addressQuery);
//         // ── Files (from multer; optional) ────────────────────────────────────
//         // Parsed BEFORE the property is created so the first photo can become the
//         // property's card image.
//         const photos = (req.files?.photos || []).map((f) => f.path); // path is the full Cloudinary URL
//         const idProof = req.files?.idProof?.[0] ? req.files.idProof[0].path : '';

//         if (!property) {
//             const coords = await geocodeAddress(
//                 `${streetAddress.trim()}, ${city.trim()}, ${state.trim()} ${zipCode?.trim() || ''}`
//             );
//             property = await Property.create({
//                 ...addressQuery,
//                 title: streetAddress.trim(),
//                 zipCode: zipCode?.trim() || '',
//                 location: `${city.trim()}, ${state.trim()}`,
//                 type: type || 'Other',
//                 price: price ? Number(price) : null,
//                 image: photos[0] || '', // ← first uploaded photo becomes the card image
//                 coords,
//             });
//         } else if (!property.image && photos[0]) {
//             // Backfill: existing property has no image yet → use this review's photo
//             property.image = photos[0];
//             await property.save();
//         }

//         // ── One review per user per property ─────────────────────────────────
//         const existing = await Review.findOne({ property: property._id, user: req.user.id });
//         if (existing) {
//             return res.status(409).json({ message: 'You have already reviewed this property.' });
//         }

//         // ── Create the review ────────────────────────────────────────────────
//         const newReview = await Review.create({
//             property: property._id,
//             user: req.user.id,
//             reviewerName: name.trim(),
//             rating: numericRating,
//             title: reviewTitle.trim(),
//             body: review.trim(),
//             pros: toLines(pros),
//             cons: toLines(cons),
//             photos,
//             verification: {
//                 idType: idType || '',
//                 idNumber: idNumber || '',
//                 idProof,
//                 verified: false,
//             },
//         });

//         await recalcProperty(property._id);

//         // Re-fetch without the private verification block
//         const safeReview = await Review.findById(newReview._id);

//         res.status(201).json({
//             success: true,
//             message: 'Review submitted successfully!',
//             review: safeReview,
//             propertyId: property._id,
//         });
//     } catch (error) {
//         if (error.code === 11000) {
//             return res.status(409).json({ message: 'You have already reviewed this property.' });
//         }
//         console.error('Create review error:', error.message);
//         res.status(500).json({ message: 'Server error. Please try again later.' });
//     }
// };

// // @desc    Get all reviews (optional ?property= ?rating= ?sort=)
// // @route   GET /api/reviews
// // @access  Public
// const getReviews = async (req, res) => {
//     try {
//         const { property, rating, sort } = req.query;
//         const filter = {};
//         if (property) filter.property = property;
//         if (rating) filter.rating = Number(rating);

//         const sortOption =
//             sort === 'oldest' ? { createdAt: 1 }
//                 : sort === 'highest' ? { rating: -1, createdAt: -1 }
//                     : sort === 'lowest' ? { rating: 1, createdAt: -1 }
//                         : { createdAt: -1 }; // newest (default)

//         const reviews = await Review.find(filter)
//             .populate('property', 'title location type image')
//             .sort(sortOption);

//         res.json({ success: true, count: reviews.length, reviews });
//     } catch (error) {
//         console.error('Get reviews error:', error.message);
//         res.status(500).json({ message: 'Server error. Please try again later.' });
//     }
// };

// // @desc    Get a single review
// // @route   GET /api/reviews/:id
// // @access  Public
// const getReview = async (req, res) => {
//     try {
//         const review = await Review.findById(req.params.id)
//             .populate('property', 'title location type image');
//         if (!review) return res.status(404).json({ message: 'Review not found.' });
//         res.json({ success: true, review });
//     } catch (error) {
//         if (error.kind === 'ObjectId') {
//             return res.status(404).json({ message: 'Review not found.' });
//         }
//         console.error('Get review error:', error.message);
//         res.status(500).json({ message: 'Server error. Please try again later.' });
//     }
// };

// // @desc    Get all reviews for one property
// // @route   GET /api/reviews/property/:propertyId
// // @access  Public
// const getPropertyReviews = async (req, res) => {
//     try {
//         const reviews = await Review.find({ property: req.params.propertyId }).sort({ createdAt: -1 });
//         res.json({ success: true, count: reviews.length, reviews });
//     } catch (error) {
//         console.error('Get property reviews error:', error.message);
//         res.status(500).json({ message: 'Server error. Please try again later.' });
//     }
// };

// // @desc    Get the logged-in user's reviews
// // @route   GET /api/reviews/me
// // @access  Private
// const getMyReviews = async (req, res) => {
//     try {
//         const reviews = await Review.find({ user: req.user.id })
//             .populate('property', 'title location type image')
//             .sort({ createdAt: -1 });
//         res.json({ success: true, count: reviews.length, reviews });
//     } catch (error) {
//         console.error('Get my reviews error:', error.message);
//         res.status(500).json({ message: 'Server error. Please try again later.' });
//     }
// };

// // @desc    Update own review
// // @route   PUT /api/reviews/:id
// // @access  Private
// const updateReview = async (req, res) => {
//     try {
//         const review = await Review.findById(req.params.id);
//         if (!review) return res.status(404).json({ message: 'Review not found.' });
//         if (review.user.toString() !== req.user.id) {
//             return res.status(403).json({ message: 'You can only edit your own review.' });
//         }

//         const { rating, reviewTitle, review: body, pros, cons } = req.body;

//         if (rating !== undefined) {
//             const r = Number(rating);
//             if (!r || r < 1 || r > 5) {
//                 return res.status(400).json({ message: 'Rating must be between 1 and 5.' });
//             }
//             review.rating = r;
//         }
//         if (reviewTitle !== undefined) review.title = reviewTitle.trim();
//         if (body !== undefined) review.body = body.trim();
//         if (pros !== undefined) review.pros = toLines(pros);
//         if (cons !== undefined) review.cons = toLines(cons);

//         await review.save();
//         await recalcProperty(review.property);

//         const updated = await Review.findById(review._id);
//         res.json({ success: true, message: 'Review updated.', review: updated });
//     } catch (error) {
//         if (error.kind === 'ObjectId') {
//             return res.status(404).json({ message: 'Review not found.' });
//         }
//         console.error('Update review error:', error.message);
//         res.status(500).json({ message: 'Server error. Please try again later.' });
//     }
// };

// // @desc    Delete own review
// // @route   DELETE /api/reviews/:id
// // @access  Private
// const deleteReview = async (req, res) => {
//     try {
//         const review = await Review.findById(req.params.id);
//         if (!review) return res.status(404).json({ message: 'Review not found.' });
//         if (review.user.toString() !== req.user.id) {
//             return res.status(403).json({ message: 'You can only delete your own review.' });
//         }

//         const propertyId = review.property;
//         await review.deleteOne();
//         await recalcProperty(propertyId);

//         res.json({ success: true, message: 'Review deleted.' });
//     } catch (error) {
//         if (error.kind === 'ObjectId') {
//             return res.status(404).json({ message: 'Review not found.' });
//         }
//         console.error('Delete review error:', error.message);
//         res.status(500).json({ message: 'Server error. Please try again later.' });
//     }
// };

// module.exports = {
//     createReview,
//     getReviews,
//     getReview,
//     getPropertyReviews,
//     getMyReviews,
//     updateReview,
//     deleteReview,
// };








// const mongoose = require('mongoose');
// const Review = require('../models/Review');
// const Property = require('../models/Property');
// const { geocodeAddress } = require('../utils/geocode');

// // ─── Helpers ─────────────────────────────────────────────────────────────
// // Accept either a newline-separated string (from a textarea) or an array.
// const toLines = (val) => {
//     if (Array.isArray(val)) return val.map((s) => String(s).trim()).filter(Boolean);
//     if (typeof val === 'string') return val.split('\n').map((s) => s.trim()).filter(Boolean);
//     return [];
// };

// // Recalculate a property's average rating + review count.
// const recalcProperty = async (propertyId) => {
//     const stats = await Review.aggregate([
//         { $match: { property: new mongoose.Types.ObjectId(propertyId) } },
//         { $group: { _id: '$property', avg: { $avg: '$rating' }, count: { $sum: 1 } } },
//     ]);
//     const avg = stats[0]?.avg || 0;
//     const count = stats[0]?.count || 0;
//     await Property.findByIdAndUpdate(propertyId, {
//         rating: Math.round(avg * 10) / 10,
//         reviewsCount: count,
//     });
// };

// // @desc    Create a review (finds/creates the property, recalcs aggregate)
// // @route   POST /api/reviews
// // @access  Private
// const createReview = async (req, res) => {
//     try {
//         const {
//             streetAddress, city, state, zipCode,
//             rating, name, reviewTitle, review,
//             pros, cons, idType, idNumber,
//             type, price,
//         } = req.body;

//         // ── Validation ──────────────────────────────────────────────────────
//         if (!streetAddress?.trim() || !city?.trim() || !state?.trim()) {
//             return res.status(400).json({ message: 'Street address, city, and state are required.' });
//         }
//         const numericRating = Number(rating);
//         if (!numericRating || numericRating < 1 || numericRating > 5) {
//             return res.status(400).json({ message: 'Please select a rating between 1 and 5.' });
//         }
//         if (!name?.trim()) return res.status(400).json({ message: 'Your name is required.' });
//         if (!reviewTitle?.trim()) return res.status(400).json({ message: 'Review title is required.' });
//         if (!review?.trim()) return res.status(400).json({ message: 'Review text is required.' });

//         // ── Find or create the property ──────────────────────────────────────
//         const addressQuery = {
//             streetAddress: streetAddress.trim(),
//             city: city.trim(),
//             state: state.trim(),
//         };

//         let property = await Property.findOne(addressQuery);

//         // ── Files (from multer-storage-cloudinary; optional) ─────────────────
//         // After upload, `file.path` is the full Cloudinary URL.
//         const photos = (req.files?.photos || []).map((f) => f.path);
//         const idProof = req.files?.idProof?.[0] ? req.files.idProof[0].path : '';

//         // ── Coordinates ──────────────────────────────────────────────────────
//         // Prefer the exact lat/lng sent from the address picker (always present
//         // and accurate). Fall back to server-side geocoding of the typed address.
//         const fullAddress = `${streetAddress.trim()}, ${city.trim()}, ${state.trim()} ${zipCode?.trim() || ''}`;
//         const formCoords =
//             req.body.lat && req.body.lng
//                 ? { lat: Number(req.body.lat), lng: Number(req.body.lng) }
//                 : null;

//         if (!property) {
//             const coords =
//                 formCoords ||
//                 (await geocodeAddress(fullAddress, { city: city.trim(), state: state.trim() }));

//             property = await Property.create({
//                 ...addressQuery,
//                 title: streetAddress.trim(),
//                 zipCode: zipCode?.trim() || '',
//                 location: `${city.trim()}, ${state.trim()}`,
//                 type: type || 'Other',
//                 price: price ? Number(price) : null,
//                 image: photos[0] || '',     // first uploaded photo becomes the card image
//                 coords,                      // exact (picker) or geocoded
//             });
//         } else {
//             // Existing property — backfill anything it's still missing
//             let changed = false;

//             if (!property.image && photos[0]) {
//                 property.image = photos[0];
//                 changed = true;
//             }
//             if (!property.coords || property.coords.lat == null) {
//                 const coords =
//                     formCoords ||
//                     (await geocodeAddress(fullAddress, { city: city.trim(), state: state.trim() }));
//                 if (coords) {
//                     property.coords = coords;
//                     changed = true;
//                 }
//             }
//             if (changed) await property.save();
//         }

//         // ── One review per user per property ─────────────────────────────────
//         const existing = await Review.findOne({ property: property._id, user: req.user.id });
//         if (existing) {
//             return res.status(409).json({ message: 'You have already reviewed this property.' });
//         }

//         // ── Create the review ────────────────────────────────────────────────
//         const newReview = await Review.create({
//             property: property._id,
//             user: req.user.id,
//             reviewerName: name.trim(),
//             rating: numericRating,
//             title: reviewTitle.trim(),
//             body: review.trim(),
//             pros: toLines(pros),
//             cons: toLines(cons),
//             photos,
//             verification: {
//                 idType: idType || '',
//                 idNumber: idNumber || '',
//                 idProof,
//                 verified: false,
//             },
//         });

//         await recalcProperty(property._id);

//         // Re-fetch without the private verification block
//         const safeReview = await Review.findById(newReview._id);

//         res.status(201).json({
//             success: true,
//             message: 'Review submitted successfully!',
//             review: safeReview,
//             propertyId: property._id,
//         });
//     } catch (error) {
//         if (error.code === 11000) {
//             return res.status(409).json({ message: 'You have already reviewed this property.' });
//         }
//         console.error('Create review error:', error.message);
//         res.status(500).json({ message: 'Server error. Please try again later.' });
//     }
// };

// // @desc    Get all reviews (optional ?property= ?rating= ?sort=)
// // @route   GET /api/reviews
// // @access  Public
// const getReviews = async (req, res) => {
//     try {
//         const { property, rating, sort } = req.query;
//         const filter = {};
//         if (property) filter.property = property;
//         if (rating) filter.rating = Number(rating);

//         const sortOption =
//             sort === 'oldest' ? { createdAt: 1 }
//                 : sort === 'highest' ? { rating: -1, createdAt: -1 }
//                     : sort === 'lowest' ? { rating: 1, createdAt: -1 }
//                         : { createdAt: -1 }; // newest (default)

//         const reviews = await Review.find(filter)
//             .populate('property', 'title location type image')
//             .sort(sortOption);

//         res.json({ success: true, count: reviews.length, reviews });
//     } catch (error) {
//         console.error('Get reviews error:', error.message);
//         res.status(500).json({ message: 'Server error. Please try again later.' });
//     }
// };

// // @desc    Get a single review
// // @route   GET /api/reviews/:id
// // @access  Public
// const getReview = async (req, res) => {
//     try {
//         const review = await Review.findById(req.params.id)
//             .populate('property', 'title location type image');
//         if (!review) return res.status(404).json({ message: 'Review not found.' });
//         res.json({ success: true, review });
//     } catch (error) {
//         if (error.kind === 'ObjectId') {
//             return res.status(404).json({ message: 'Review not found.' });
//         }
//         console.error('Get review error:', error.message);
//         res.status(500).json({ message: 'Server error. Please try again later.' });
//     }
// };

// // @desc    Get all reviews for one property
// // @route   GET /api/reviews/property/:propertyId
// // @access  Public
// const getPropertyReviews = async (req, res) => {
//     try {
//         const reviews = await Review.find({ property: req.params.propertyId }).sort({ createdAt: -1 });
//         res.json({ success: true, count: reviews.length, reviews });
//     } catch (error) {
//         console.error('Get property reviews error:', error.message);
//         res.status(500).json({ message: 'Server error. Please try again later.' });
//     }
// };

// // @desc    Get the logged-in user's reviews
// // @route   GET /api/reviews/me
// // @access  Private
// const getMyReviews = async (req, res) => {
//     try {
//         const reviews = await Review.find({ user: req.user.id })
//             .populate('property', 'title location type image')
//             .sort({ createdAt: -1 });
//         res.json({ success: true, count: reviews.length, reviews });
//     } catch (error) {
//         console.error('Get my reviews error:', error.message);
//         res.status(500).json({ message: 'Server error. Please try again later.' });
//     }
// };

// // @desc    Update own review
// // @route   PUT /api/reviews/:id
// // @access  Private
// const updateReview = async (req, res) => {
//     try {
//         const review = await Review.findById(req.params.id);
//         if (!review) return res.status(404).json({ message: 'Review not found.' });
//         if (review.user.toString() !== req.user.id) {
//             return res.status(403).json({ message: 'You can only edit your own review.' });
//         }

//         const { rating, reviewTitle, review: body, pros, cons } = req.body;

//         if (rating !== undefined) {
//             const r = Number(rating);
//             if (!r || r < 1 || r > 5) {
//                 return res.status(400).json({ message: 'Rating must be between 1 and 5.' });
//             }
//             review.rating = r;
//         }
//         if (reviewTitle !== undefined) review.title = reviewTitle.trim();
//         if (body !== undefined) review.body = body.trim();
//         if (pros !== undefined) review.pros = toLines(pros);
//         if (cons !== undefined) review.cons = toLines(cons);

//         await review.save();
//         await recalcProperty(review.property);

//         const updated = await Review.findById(review._id);
//         res.json({ success: true, message: 'Review updated.', review: updated });
//     } catch (error) {
//         if (error.kind === 'ObjectId') {
//             return res.status(404).json({ message: 'Review not found.' });
//         }
//         console.error('Update review error:', error.message);
//         res.status(500).json({ message: 'Server error. Please try again later.' });
//     }
// };

// // @desc    Delete own review
// // @route   DELETE /api/reviews/:id
// // @access  Private
// const deleteReview = async (req, res) => {
//     try {
//         const review = await Review.findById(req.params.id);
//         if (!review) return res.status(404).json({ message: 'Review not found.' });
//         if (review.user.toString() !== req.user.id) {
//             return res.status(403).json({ message: 'You can only delete your own review.' });
//         }

//         const propertyId = review.property;
//         await review.deleteOne();
//         await recalcProperty(propertyId);

//         res.json({ success: true, message: 'Review deleted.' });
//     } catch (error) {
//         if (error.kind === 'ObjectId') {
//             return res.status(404).json({ message: 'Review not found.' });
//         }
//         console.error('Delete review error:', error.message);
//         res.status(500).json({ message: 'Server error. Please try again later.' });
//     }
// };

// module.exports = {
//     createReview,
//     getReviews,
//     getReview,
//     getPropertyReviews,
//     getMyReviews,
//     updateReview,
//     deleteReview,
// };










const mongoose = require('mongoose');
const Review = require('../models/Review');
const Property = require('../models/Property');
const { geocodeAddress } = require('../utils/geocode');
const { verifyIdProof } = require('../utils/verifyId');

// ─── Helpers ─────────────────────────────────────────────────────────────
const toLines = (val) => {
    if (Array.isArray(val)) return val.map((s) => String(s).trim()).filter(Boolean);
    if (typeof val === 'string') return val.split('\n').map((s) => s.trim()).filter(Boolean);
    return [];
};

// Server-side ID number format rules (mirror the frontend so it can't be bypassed)
const ID_RULES = {
    'Aadhaar Card': /^\d{12}$/,
    'PAN Card': /^[A-Z]{5}[0-9]{4}[A-Z]$/,
    'Driving License': /^[A-Z]{2}\d{8,15}$/,
    'Passport': /^[A-Z][0-9]{7}$/,
    'Voter ID': /^[A-Z]{3}[0-9]{7}$/,
};
const isValidIdNumber = (idType, idNumber) => {
    const rx = ID_RULES[idType];
    if (!rx) return false;
    const clean = String(idNumber || '').replace(/[\s-]/g, '').toUpperCase();
    return rx.test(clean);
};

// Recalculate a property's average rating + review count.
const recalcProperty = async (propertyId) => {
    const stats = await Review.aggregate([
        { $match: { property: new mongoose.Types.ObjectId(propertyId) } },
        { $group: { _id: '$property', avg: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);
    const avg = stats[0]?.avg || 0;
    const count = stats[0]?.count || 0;
    await Property.findByIdAndUpdate(propertyId, {
        rating: Math.round(avg * 10) / 10,
        reviewsCount: count,
    });
};

// @desc    Create a review (finds/creates the property, recalcs aggregate)
// @route   POST /api/reviews
// @access  Private
const createReview = async (req, res) => {
    try {
        const {
            streetAddress, city, state, zipCode,
            rating, name, reviewTitle, review,
            pros, cons, idType, idNumber,
            type, price,
        } = req.body;

        // ── Basic validation ─────────────────────────────────────────────────
        if (!streetAddress?.trim() || !city?.trim() || !state?.trim()) {
            return res.status(400).json({ message: 'Street address, city, and state are required.' });
        }
        const numericRating = Number(rating);
        if (!numericRating || numericRating < 1 || numericRating > 5) {
            return res.status(400).json({ message: 'Please select a rating between 1 and 5.' });
        }
        if (!name?.trim()) return res.status(400).json({ message: 'Your name is required.' });
        if (!reviewTitle?.trim()) return res.status(400).json({ message: 'Review title is required.' });
        if (!review?.trim()) return res.status(400).json({ message: 'Review text is required.' });

        // ── Files (from multer-storage-cloudinary; file.path is the Cloudinary URL) ──
        const photos = (req.files?.photos || []).map((f) => f.path);
        const idProofFile = req.files?.idProof?.[0];
        const idProof = idProofFile ? idProofFile.path : '';

        // ── Identity verification (MANDATORY) ─────────────────────────────────
        if (!idType) return res.status(400).json({ message: 'ID type is required.' });
        if (!idNumber?.trim()) return res.status(400).json({ message: 'ID number is required.' });
        if (!isValidIdNumber(idType, idNumber)) {
            return res.status(400).json({ message: `The ID number does not match the format for ${idType}.` });
        }
        if (!idProof) return res.status(400).json({ message: 'ID proof upload is required.' });

        // Automated OCR check — recognise random / mismatched uploads
        const idCheck = await verifyIdProof({
            imageUrl: idProof,
            mimetype: idProofFile?.mimetype,
            idType,
            idNumber,
        });
        if (!idCheck.ok) {
            return res.status(400).json({
                message: `The uploaded ID proof doesn't look like a valid ${idType} matching the number you entered. Please upload a clear photo of your ${idType}.`,
            });
        }

        // ── Find or create the property ──────────────────────────────────────
        const addressQuery = {
            streetAddress: streetAddress.trim(),
            city: city.trim(),
            state: state.trim(),
        };

        let property = await Property.findOne(addressQuery);

        // Coordinates: prefer the address picker's lat/lng, fall back to geocoding
        const fullAddress = `${streetAddress.trim()}, ${city.trim()}, ${state.trim()} ${zipCode?.trim() || ''}`;
        const formCoords =
            req.body.lat && req.body.lng
                ? { lat: Number(req.body.lat), lng: Number(req.body.lng) }
                : null;

        if (!property) {
            const coords =
                formCoords ||
                (await geocodeAddress(fullAddress, { city: city.trim(), state: state.trim() }));

            property = await Property.create({
                ...addressQuery,
                title: streetAddress.trim(),
                zipCode: zipCode?.trim() || '',
                location: `${city.trim()}, ${state.trim()}`,
                type: type || 'Other',
                price: price ? Number(price) : null,
                image: photos[0] || '',
                coords,
            });
        } else {
            let changed = false;
            if (!property.image && photos[0]) { property.image = photos[0]; changed = true; }
            if (!property.coords || property.coords.lat == null) {
                const coords =
                    formCoords ||
                    (await geocodeAddress(fullAddress, { city: city.trim(), state: state.trim() }));
                if (coords) { property.coords = coords; changed = true; }
            }
            if (changed) await property.save();
        }

        // ── One review per user per property ─────────────────────────────────
        const existing = await Review.findOne({ property: property._id, user: req.user.id });
        if (existing) {
            return res.status(409).json({ message: 'You have already reviewed this property.' });
        }

        // ── Create the review ────────────────────────────────────────────────
        const newReview = await Review.create({
            property: property._id,
            user: req.user.id,
            reviewerName: name.trim(),
            rating: numericRating,
            title: reviewTitle.trim(),
            body: review.trim(),
            pros: toLines(pros),
            cons: toLines(cons),
            photos,
            verification: {
                idType,
                idNumber: idNumber.trim(),
                idProof,
                // Auto-verified only when OCR found BOTH the number and a doc keyword.
                // Otherwise it stays false for a human to confirm later.
                verified: idCheck.autoVerified,
            },
        });

        await recalcProperty(property._id);

        const safeReview = await Review.findById(newReview._id);

        res.status(201).json({
            success: true,
            message: 'Review submitted successfully!',
            review: safeReview,
            propertyId: property._id,
            idVerified: idCheck.autoVerified, // true = passed auto-check; false = pending manual review
        });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({ message: 'You have already reviewed this property.' });
        }
        console.error('Create review error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

// @desc    Get all reviews (optional ?property= ?rating= ?sort=)
const getReviews = async (req, res) => {
    try {
        const { property, rating, sort } = req.query;
        const filter = {};
        if (property) filter.property = property;
        if (rating) filter.rating = Number(rating);

        const sortOption =
            sort === 'oldest' ? { createdAt: 1 }
                : sort === 'highest' ? { rating: -1, createdAt: -1 }
                    : sort === 'lowest' ? { rating: 1, createdAt: -1 }
                        : { createdAt: -1 };

        const reviews = await Review.find(filter)
            .populate('property', 'title location type image')
            .sort(sortOption);

        res.json({ success: true, count: reviews.length, reviews });
    } catch (error) {
        console.error('Get reviews error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

// @desc    Get a single review
const getReview = async (req, res) => {
    try {
        const review = await Review.findById(req.params.id)
            .populate('property', 'title location type image');
        if (!review) return res.status(404).json({ message: 'Review not found.' });
        res.json({ success: true, review });
    } catch (error) {
        if (error.kind === 'ObjectId') return res.status(404).json({ message: 'Review not found.' });
        console.error('Get review error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

// @desc    Get all reviews for one property
const getPropertyReviews = async (req, res) => {
    try {
        const reviews = await Review.find({ property: req.params.propertyId }).sort({ createdAt: -1 });
        res.json({ success: true, count: reviews.length, reviews });
    } catch (error) {
        console.error('Get property reviews error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

// @desc    Get the logged-in user's reviews
const getMyReviews = async (req, res) => {
    try {
        const reviews = await Review.find({ user: req.user.id })
            .populate('property', 'title location type image streetAddress city state')
            .sort({ createdAt: -1 });
        res.json({ success: true, count: reviews.length, reviews });
    } catch (error) {
        console.error('Get my reviews error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

// @desc    Update own review
const updateReview = async (req, res) => {
    try {
        const review = await Review.findById(req.params.id);
        if (!review) return res.status(404).json({ message: 'Review not found.' });
        if (review.user.toString() !== req.user.id) {
            return res.status(403).json({ message: 'You can only edit your own review.' });
        }

        const { rating, reviewTitle, review: body, pros, cons } = req.body;

        if (rating !== undefined) {
            const r = Number(rating);
            if (!r || r < 1 || r > 5) return res.status(400).json({ message: 'Rating must be between 1 and 5.' });
            review.rating = r;
        }
        if (reviewTitle !== undefined) review.title = reviewTitle.trim();
        if (body !== undefined) review.body = body.trim();
        if (pros !== undefined) review.pros = toLines(pros);
        if (cons !== undefined) review.cons = toLines(cons);

        await review.save();
        await recalcProperty(review.property);

        const updated = await Review.findById(review._id);
        res.json({ success: true, message: 'Review updated.', review: updated });
    } catch (error) {
        if (error.kind === 'ObjectId') return res.status(404).json({ message: 'Review not found.' });
        console.error('Update review error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

// @desc    Delete own review
const deleteReview = async (req, res) => {
    try {
        const review = await Review.findById(req.params.id);
        if (!review) return res.status(404).json({ message: 'Review not found.' });
        if (review.user.toString() !== req.user.id) {
            return res.status(403).json({ message: 'You can only delete your own review.' });
        }

        const propertyId = review.property;
        await review.deleteOne();
        await recalcProperty(propertyId);

        res.json({ success: true, message: 'Review deleted.' });
    } catch (error) {
        if (error.kind === 'ObjectId') return res.status(404).json({ message: 'Review not found.' });
        console.error('Delete review error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

module.exports = {
    createReview,
    getReviews,
    getReview,
    getPropertyReviews,
    getMyReviews,
    updateReview,
    deleteReview,
};

const mongoose = require('mongoose');
const Review = require('../models/Review');
const Property = require('../models/Property');
const { geocodeAddress } = require('../utils/geocode');
const { verifyIdProof } = require('../utils/verifyId');
// Reusable request validators + Cloudinary orphan cleanup live in the middleware
// module so this controller stays readable (ID_RULES / isValidIdNumber moved there).
const {
    validateReviewBody,
    cleanupUploads,
    isValidRating,
    isNonEmptyString,
} = require('../middleware/validateReview');
// ID proofs are uploaded to Cloudinary's `authenticated` namespace, so reading
// one back needs a signed URL and deleting one needs an explicit reference.
const {
    assetRefFromFile,
    signedAssetUrl,
    destroyAssets,
    collectReviewAssets,
    parseDeliveryUrl,
} = require('../utils/cloudinaryAssets');

// ─── Helpers ─────────────────────────────────────────────────────────────
// Neutralise regex metacharacters before compiling user input into a pattern.
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const toLines = (val) => {
    if (Array.isArray(val)) return val.map((s) => String(s).trim()).filter(Boolean);
    if (typeof val === 'string') return val.split('\n').map((s) => s.trim()).filter(Boolean);
    return [];
};

// ?page= / ?limit= for the list endpoints. limit is capped at 100 so one
// unauthenticated request can no longer pull the whole collection into memory.
const readPaging = (query = {}) => {
    const limit = Math.max(Math.min(Number(query.limit) || 20, 100), 1);
    const page = Math.max(Number(query.page) || 1, 1);
    return { page, limit, skip: (page - 1) * limit };
};

// Property.type is a schema enum — validate here so a bad value is a 400 rather
// than a raw Mongoose validation 500.
const PROPERTY_TYPES = Property.schema.path('type').enumValues;

// Recalculate a property's average rating + review count.
//
// When the last review of a property is deleted this writes {rating: 0,
// reviewsCount: 0} and the Property document stays. That is deliberate — the
// document is an ADDRESS RECORD holding geocoded coordinates that cost a
// Nominatim call to obtain, and a later review of the same address finds it by
// addressKey and reuses them. Deleting it here would also race with a
// concurrent create that already holds this _id.
//
// It is hidden from the browse grid and the map instead, by the
// `reviewsCount: { $gt: 0 }` filter in propertyController.
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

// ─── Background ID check ─────────────────────────────────────────────────────
// OCR used to run inside the request: download the proof from Cloudinary (10s
// timeout), load Tesseract's language data, recognise — all before the user got
// a response, and capped at 2 concurrent, so a third simultaneous submission
// simply waited with its connection held open.
//
// The result never gated anything (the policy is accept-as-pending, and the
// caller ignored `ok`), so none of it needed to be synchronous. The review is now
// persisted as `pending` and answered immediately; the check runs after the
// response and patches the document.
//
// If the process dies mid-check the review stays `pending`, which is exactly
// where an unchecked submission belongs — the manual queue.
const runIdCheckInBackground = ({ reviewId, imageUrl, mimetype, idType, idNumber }) => {
    setImmediate(async () => {
        let update;
        try {
            const idCheck = await verifyIdProof({ imageUrl, mimetype, idType, idNumber });
            update = {
                'verification.verified': idCheck.autoVerified,
                'verification.verifiedReason': idCheck.reason || '',
            };
        } catch (err) {
            console.error(`[id-verify] background check failed for review ${reviewId}:`, err.message);
            update = { 'verification.verifiedReason': 'ocr-error' };
        }

        try {
            // `reviewedAt: null` guards against a race with a human: if an admin
            // ruled on this submission while OCR was still running, their decision
            // wins and this write is a no-op.
            await Review.updateOne(
                { _id: reviewId, 'verification.reviewedAt': null },
                { $set: update }
            );
        } catch (err) {
            console.error(`[id-verify] could not record result for review ${reviewId}:`, err.message);
        }
    });
};

// @desc    Create a review (finds/creates the property, recalcs aggregate)
// @route   POST /api/reviews
// @access  Private
const createReview = async (req, res) => {
    // Hoisted so the catch block can finish the create after a Property-index race.
    let addressKey = null;
    let reviewPayload = null;
    // Signed URL for the ID proof. Hoisted for the same reason: the retry path
    // also has to start a background check, and the unsigned URL returns 401.
    let idCheckUrl = '';

    // Every non-201 exit goes through here: multer has already streamed the files
    // to Cloudinary by the time this handler runs, so bailing out without
    // destroying them leaves permanent orphans nothing references.
    const fail = async (status, message, extra = {}) => {
        await cleanupUploads(req);
        return res.status(status).json({ message, ...extra });
    };

    try {
        const {
            streetAddress, city, state, zipCode,
            rating, name, reviewTitle, review,
            pros, cons, idType, idNumber,
            type, price,
        } = req.body;

        // ── Cheap request-shape validation, FIRST ────────────────────────────
        // Runs before OCR / geocoding / any DB work so a blank title costs one
        // Cloudinary delete instead of a full Tesseract run.
        const bodyError = validateReviewBody(req.body);
        if (bodyError) return fail(400, bodyError);

        const numericRating = Number(rating);

        // ── Files (from multer-storage-cloudinary; file.path is the Cloudinary URL) ──
        // Alongside each URL we keep an explicit asset reference. The URL is not a
        // usable handle for deletion — `uploader.destroy` needs the resource type
        // and the delivery type, and neither survives the upload. Without these,
        // deleting a review would strand its photos and its ID proof in Cloudinary
        // forever. See utils/cloudinaryAssets.js.
        const photoFiles = req.files?.photos || [];
        const photos = photoFiles.map((f) => f.path);
        const photoAssets = photoFiles.map(assetRefFromFile).filter(Boolean);

        const idProofFile = req.files?.idProof?.[0];
        const idProof = idProofFile ? idProofFile.path : '';
        const idProofAsset = assetRefFromFile(idProofFile);

        if (!idProof) return fail(400, 'ID proof upload is required.');

        // ── Property type / price, validated before Mongoose sees them ───────
        if (type !== undefined && type !== null && type !== '' && !PROPERTY_TYPES.includes(type)) {
            return fail(400, `Property type must be one of: ${PROPERTY_TYPES.join(', ')}.`);
        }
        const propertyType = PROPERTY_TYPES.includes(type) ? type : 'Other';
        const numericPrice = Number.isFinite(Number(price)) && String(price ?? '').trim() !== ''
            ? Number(price)
            : null;

        // ── Automated OCR check ──────────────────────────────────────────────
        // Advisory ONLY — it never blocks a submission. OCR is unreliable on real
        // Indian IDs (Hindi+English text, glare, low contrast), so a genuine card
        // the reader misses must still get through. Anything that isn't a strong
        // match is stored with verified:false plus the reason, and goes to the
        // manual review queue. (The old `if (!idCheck.ok) return 400` branch was
        // provably dead — every return path in verifyIdProof sets ok:true — and
        // has been removed rather than left as a misleading no-op.)
        // The proof lives in the `authenticated` namespace, so the plain delivery
        // URL now 401s. The background check needs a signed one — without this
        // every submission would come back 'fetch-error' and silently land in the
        // pending pile, which looks exactly like OCR simply never working.
        idCheckUrl = signedAssetUrl(idProofAsset) || idProof;

        // ── Find or create the property ──────────────────────────────────────
        const addressQuery = {
            streetAddress: streetAddress.trim(),
            city: city.trim(),
            state: state.trim(),
        };

        // Normalised key — "123 Oak St/Austin/TX" and "123 oak st/austin/tx" are
        // the same building, so they must resolve to the same Property document,
        // otherwise the {property, user} unique index never fires.
        addressKey = Property.buildAddressKey(addressQuery.streetAddress, addressQuery.city, addressQuery.state);

        let property = await Property.findOne({ addressKey });
        if (!property) {
            // Legacy documents predate `addressKey`; fall back to the old exact
            // match and backfill the key so the next lookup finds it directly.
            property = await Property.findOne(addressQuery);
        }
        if (!property) {
            // Still nothing — but a legacy document stored as "123 Oak St" will
            // miss BOTH lookups when this submission says "123 oak st": no
            // addressKey to match, and the exact match is case-sensitive. That
            // gap is live for every un-backfilled document between deploy and the
            // manual migration, and it is exactly the duplicate this key was
            // introduced to prevent. Catch it with a case-insensitive scan over
            // the un-keyed documents only, so the cost stays bounded.
            const legacyCandidates = await Property.find({
                addressKey: { $in: [null, ''] },
                city: new RegExp(`^${escapeRegex(addressQuery.city)}$`, 'i'),
                state: new RegExp(`^${escapeRegex(addressQuery.state)}$`, 'i'),
            }).limit(50);

            property = legacyCandidates.find(
                (candidate) =>
                    Property.buildAddressKey(
                        candidate.streetAddress,
                        candidate.city,
                        candidate.state
                    ) === addressKey
            ) || null;
        }
        if (property && !property.addressKey) {
            property.addressKey = addressKey;
            await property.save();
        }

        // Coordinates: prefer the address picker's lat/lng, fall back to geocoding.
        // The form values are attacker-controlled, so accept them only when both
        // are finite and inside real WGS84 bounds — otherwise ignore and geocode.
        const fullAddress = `${streetAddress.trim()}, ${city.trim()}, ${state.trim()} ${zipCode?.trim() || ''}`;
        // The client always sends lat/lng, sending '' when the user typed the
        // address by hand instead of picking a suggestion. Number('') is 0, which
        // is finite and inside WGS84 bounds — so coercing first would silently
        // pin every hand-typed address to {0,0} off the coast of Africa and skip
        // geocoding entirely. Require a non-empty raw value before coercing.
        const hasRawCoord = (v) => v !== undefined && v !== null && String(v).trim() !== '';
        const formLat = Number(req.body.lat);
        const formLng = Number(req.body.lng);
        const formCoords =
            hasRawCoord(req.body.lat) && hasRawCoord(req.body.lng) &&
                Number.isFinite(formLat) && Number.isFinite(formLng) &&
                Math.abs(formLat) <= 90 && Math.abs(formLng) <= 180
                ? { lat: formLat, lng: formLng }
                : null;

        // ── One review per user per property ─────────────────────────────────
        // Checked BEFORE the property is created or mutated. If it ran after,
        // the 409 would go through fail() → cleanupUploads(), destroying the very
        // Cloudinary asset that had just been persisted as `property.image`.
        if (property) {
            const existing = await Review.findOne({ property: property._id, user: req.user.id });
            if (existing) {
                return fail(409, 'You have already reviewed this property.');
            }
        }

        if (!property) {
            const coords =
                formCoords ||
                (await geocodeAddress(fullAddress, { city: city.trim(), state: state.trim() }));

            try {
                property = await Property.create({
                    ...addressQuery,
                    addressKey,
                    title: streetAddress.trim(),
                    zipCode: zipCode?.trim() || '',
                    location: `${city.trim()}, ${state.trim()}`,
                    type: propertyType,
                    price: numericPrice,
                    // `image` is deliberately NOT set here. Any later failure in
                    // this handler runs cleanupUploads(), which destroys the
                    // uploaded assets — a property committed with a cover image
                    // pointing at a destroyed asset renders broken for everyone,
                    // forever. The cover is attached after Review.create succeeds.
                    coords,
                });
            } catch (err) {
                // Lost a race with a concurrent first review for the same address:
                // re-read the winning document and carry on instead of erroring.
                if (err.code !== 11000) throw err;
                property = await Property.findOne({ addressKey });
                if (!property) throw err;
            }
        } else {
            let changed = false;
            // Cover image is attached only after the review is safely persisted —
            // see the note in Property.create above.
            if (!property.coords || property.coords.lat == null) {
                const coords =
                    formCoords ||
                    (await geocodeAddress(fullAddress, { city: city.trim(), state: state.trim() }));
                // geocodeAddress ALWAYS returns an object ({lat:null,lng:null} on
                // failure), which is truthy — the old `if (coords)` meant every
                // later review of an unresolvable address re-geocoded and re-saved.
                if (coords && coords.lat != null) { property.coords = coords; changed = true; }
            }
            if (changed) await property.save();
        }

        // ── Create the review ────────────────────────────────────────────────
        reviewPayload = {
            property: property._id,
            user: req.user.id,
            reviewerName: name.trim(),
            rating: numericRating,
            title: reviewTitle.trim(),
            body: review.trim(),
            pros: toLines(pros),
            cons: toLines(cons),
            photos,
            photoAssets,
            verification: {
                idType,
                idNumber: idNumber.trim(),
                idProof,
                idProofAsset,
                // Starts pending. The background check (see runIdCheckInBackground)
                // flips this to true only when OCR reads BOTH the number and a
                // document keyword; anything else is left for a human.
                verified: false,
                verifiedReason: 'pending',
            },
        };

        const newReview = await Review.create(reviewPayload);

        // The review now owns these Cloudinary assets. Mark them committed so no
        // later failure (a VersionError on property.save, an aggregation blip in
        // recalcProperty) can run cleanupUploads and strip the photos off a review
        // that is already live and cannot be rolled back.
        req._uploadsCommitted = true;

        // Safe to adopt a cover image now: the review is committed, so no later
        // failure path can run cleanupUploads() and destroy this asset.
        if (!property.image && photos[0]) {
            property.image = photos[0];
            await property.save();
        }

        await recalcProperty(property._id);

        const safeReview = await Review.findById(newReview._id);

        res.status(201).json({
            success: true,
            message: 'Review submitted successfully!',
            review: safeReview,
            propertyId: property._id,
            // The automated check has not run yet — it starts below, after this
            // response is on the wire. Every submission begins as pending.
            idVerified: false,
            idCheckPending: true,
        });

        runIdCheckInBackground({
            reviewId: newReview._id,
            imageUrl: idCheckUrl,
            mimetype: idProofFile?.mimetype,
            idType,
            idNumber,
        });
    } catch (error) {
        if (error.code === 11000) {
            const keys = Object.keys(error.keyPattern || error.keyValue || {});
            // The review's own {property, user} index — a genuine duplicate review.
            if (keys.includes('user') && keys.includes('property')) {
                return fail(409, 'You have already reviewed this property.');
            }

            // Otherwise it came from the Property address index: someone created
            // this exact address a moment ago. Re-read the winner and finish the
            // create rather than telling this user they already wrote a review.
            if (addressKey && reviewPayload) {
                try {
                    const property = await Property.findOne({ addressKey });
                    if (property) {
                        reviewPayload.property = property._id;
                        const created = await Review.create(reviewPayload);
                        req._uploadsCommitted = true; // see the note at the primary Review.create
                        if (!property.image && reviewPayload.photos?.[0]) {
                            property.image = reviewPayload.photos[0];
                            await property.save();
                        }
                        await recalcProperty(property._id);
                        const safeReview = await Review.findById(created._id);
                        res.status(201).json({
                            success: true,
                            message: 'Review submitted successfully!',
                            review: safeReview,
                            propertyId: property._id,
                            idVerified: false,
                            idCheckPending: true,
                        });

                        runIdCheckInBackground({
                            reviewId: created._id,
                            imageUrl: idCheckUrl,
                            idType: reviewPayload.verification.idType,
                            idNumber: reviewPayload.verification.idNumber,
                        });
                        return;
                    }
                } catch (retryError) {
                    if (retryError.code === 11000) {
                        return fail(409, 'You have already reviewed this property.');
                    }
                    console.error('Create review retry error:', retryError.message);
                }
            }

            return fail(409, 'That property was just added by someone else. Please try again.');
        }
        if (error.name === 'ValidationError' || error.name === 'CastError') {
            return fail(400, 'Some of the submitted details are invalid. Please check the form and try again.');
        }
        console.error('Create review error:', error.message);
        await cleanupUploads(req);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

// @desc    Get all reviews (optional ?property= ?rating= ?sort=)
const getReviews = async (req, res) => {
    try {
        const { property, rating, sort } = req.query;
        const filter = {};
        // Validate before these reach Mongo. Passing them straight through means
        // ?property=abc or ?rating=xyz raises a CastError that the catch turns
        // into a 500 for what is plainly a bad request.
        if (property !== undefined) {
            if (typeof property !== 'string' || !mongoose.Types.ObjectId.isValid(property)) {
                return res.status(400).json({ message: 'Invalid property id.' });
            }
            filter.property = property;
        }
        if (rating !== undefined) {
            const numericRating = Number(rating);
            if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
                return res.status(400).json({ message: 'Rating filter must be a whole number from 1 to 5.' });
            }
            filter.rating = numericRating;
        }

        const sortOption =
            sort === 'oldest' ? { createdAt: 1 }
                : sort === 'highest' ? { rating: -1, createdAt: -1 }
                    : sort === 'lowest' ? { rating: 1, createdAt: -1 }
                        : { createdAt: -1 };

        const { page, limit, skip } = readPaging(req.query);

        const [reviews, total] = await Promise.all([
            Review.find(filter)
                .populate('property', 'title location type image')
                .sort(sortOption)
                .skip(skip)
                .limit(limit),
            Review.countDocuments(filter),
        ]);

        // `reviews` stays a top-level key — the frontend reads it directly.
        // page/limit/total/totalPages are pure additions.
        res.json({
            success: true,
            count: reviews.length,
            reviews,
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit) || 0,
        });
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
        const { page, limit, skip } = readPaging(req.query);
        const filter = { property: req.params.propertyId };

        const [reviews, total] = await Promise.all([
            Review.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
            Review.countDocuments(filter),
        ]);

        res.json({
            success: true,
            count: reviews.length,
            reviews,
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit) || 0,
        });
    } catch (error) {
        // A malformed :propertyId is a bad link, not a server fault.
        if (error.kind === 'ObjectId' || error.name === 'CastError') {
            return res.status(404).json({ message: 'Property not found.' });
        }
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
            // Whole numbers only — 4.7 used to pass the range check.
            if (!isValidRating(rating)) {
                return res.status(400).json({ message: 'Rating must be a whole number between 1 and 5.' });
            }
            review.rating = Number(rating);
        }
        // typeof guards: {"reviewTitle": 123} used to hit .trim() and 500.
        if (reviewTitle !== undefined) {
            if (!isNonEmptyString(reviewTitle)) {
                return res.status(400).json({ message: 'Review title must be a non-empty string.' });
            }
            if (reviewTitle.trim().length > 120) {
                return res.status(400).json({ message: 'Review title must be 120 characters or fewer.' });
            }
            review.title = reviewTitle.trim();
        }
        if (body !== undefined) {
            if (!isNonEmptyString(body)) {
                return res.status(400).json({ message: 'Review text must be a non-empty string.' });
            }
            if (body.trim().length > 5000) {
                return res.status(400).json({ message: 'Review text must be 5000 characters or fewer.' });
            }
            review.body = body.trim();
        }
        if (pros !== undefined) review.pros = toLines(pros);
        if (cons !== undefined) review.cons = toLines(cons);

        // validateModifiedOnly: reviews written before `title`/`body` gained their
        // maxlength can be longer than the new limits. Without this, editing only
        // the rating of an old 6000-character review fails validation on a field
        // the user never touched.
        await review.save({ validateModifiedOnly: true });
        await recalcProperty(review.property);

        const updated = await Review.findById(review._id);
        res.json({ success: true, message: 'Review updated.', review: updated });
    } catch (error) {
        if (error.kind === 'ObjectId') return res.status(404).json({ message: 'Review not found.' });
        if (error.name === 'ValidationError') {
            return res.status(400).json({ message: 'Some of the submitted details are invalid.' });
        }
        console.error('Update review error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

/**
 * A property's cover image is copied from the first photo of whichever review
 * happened to supply one. When that review is deleted its photos are destroyed,
 * so a cover still pointing at one would render as a broken image on the map,
 * the browse grid and the detail page — permanently, since nothing recomputes it.
 *
 * Re-point it at a surviving review's photo, or clear it. Called BEFORE the
 * assets are destroyed so no request can catch the property mid-repair.
 * Best-effort: a failure here must not fail the delete.
 */
const repairPropertyImage = async (propertyId, removedUrls) => {
    if (!Array.isArray(removedUrls) || removedUrls.length === 0) return;

    try {
        const property = await Property.findById(propertyId);
        if (!property || !property.image) return;
        if (!removedUrls.includes(property.image)) return;

        const replacement = await Review.findOne({
            property: propertyId,
            'photos.0': { $exists: true },
        })
            .sort({ createdAt: 1 })
            .select('photos');

        property.image = replacement?.photos?.[0] || '';
        await property.save();
    } catch (err) {
        console.error('[cleanup] could not repair property cover image:', err.message);
    }
};

// @desc    Delete own review
const deleteReview = async (req, res) => {
    try {
        // `verification` and `photoAssets` are `select: false`, so they have to be
        // asked for — they hold the only reliable handles on the Cloudinary assets.
        const review = await Review.findById(req.params.id).select('+verification +photoAssets');
        if (!review) return res.status(404).json({ message: 'Review not found.' });

        // Every review on this site is an unmoderated public claim about a named
        // landlord at a specific address. Owner-only deletion meant there was no
        // way to action a defamation or doxxing complaint except by editing Mongo
        // by hand. Admins can take one down; nobody can EDIT someone else's words
        // (see updateReview), because altering a review under its author's name
        // would misrepresent them.
        const isOwner = review.user.toString() === req.user.id;
        const isAdmin = req.user.role === 'admin';
        if (!isOwner && !isAdmin) {
            return res.status(403).json({ message: 'You can only delete your own review.' });
        }
        if (!isOwner) {
            console.warn(`[moderation] admin ${req.user.id} deleted review ${review._id} by user ${review.user}`);
        }

        const propertyId = review.property;
        // Read these off the document before it is gone.
        const photoUrls = Array.isArray(review.photos) ? [...review.photos] : [];
        const assets = collectReviewAssets(review);

        await review.deleteOne();
        await recalcProperty(propertyId);
        await repairPropertyImage(propertyId, photoUrls);

        // Destroy the photos AND the government ID proof. Deleting the document
        // without this left the ID document live in Cloudinary forever, which
        // makes an erasure request impossible to honour.
        //
        // Deliberately last, and deliberately best-effort: the review is already
        // gone and cannot be rolled back, so a Cloudinary outage must not turn a
        // successful delete into a 500 that invites the user to retry. Failures
        // are logged with their public_id for a manual sweep.
        const { failed } = await destroyAssets(assets);
        if (failed > 0) {
            console.error(
                `[cleanup] review ${req.params.id}: ${failed} of ${assets.length} Cloudinary assets survived deletion`
            );
        }

        res.json({ success: true, message: 'Review deleted.' });
    } catch (error) {
        if (error.kind === 'ObjectId') return res.status(404).json({ message: 'Review not found.' });
        console.error('Delete review error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

// @desc    Reviews whose ID proof did not auto-verify, oldest first
// @route   GET /api/reviews/admin/pending-verifications
// @access  Admin only (protect + authorizeRoles('admin'))
//
// The ID check is advisory by design: nothing is ever hard-rejected at submission
// time, so `verification.verified === false` means "a human still has to look at
// this". This is the only endpoint that selects `verification` back in — it holds
// the ID number and the proof image, which are `select: false` on the schema and
// must never reach a normal user.
const getPendingVerifications = async (req, res) => {
    try {
        const { page, limit, skip } = readPaging(req.query);
        // Unverified AND not yet ruled on. A rejected review stays
        // `verified: false` forever, so without the second clause every decision a
        // human made would reappear in the queue on the next page load.
        const filter = {
            'verification.verified': false,
            'verification.reviewedAt': null,
        };

        const [reviews, total] = await Promise.all([
            Review.find(filter)
                .select('+verification')
                .populate('property', 'title streetAddress city state')
                .populate('user', 'name email')
                .sort({ createdAt: 1 })
                .skip(skip)
                .limit(limit),
            Review.countDocuments(filter),
        ]);

        // The stored `idProof` URL points into Cloudinary's `authenticated`
        // namespace and returns 401 on its own — that is the whole point. Swap in
        // a signed URL so the reviewer can actually open the document, and drop
        // the raw asset reference, which is internal plumbing.
        const signedReviews = reviews.map((review) => {
            const plain = review.toObject();
            if (plain.verification) {
                plain.verification.idProof =
                    signedAssetUrl(plain.verification.idProofAsset) || plain.verification.idProof;
                delete plain.verification.idProofAsset;
            }
            delete plain.photoAssets;
            return plain;
        });

        res.json({
            success: true,
            count: signedReviews.length,
            reviews: signedReviews,
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit) || 0,
        });
    } catch (error) {
        console.error('Get pending verifications error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

// @desc    Record a human decision on a pending ID proof
// @route   PUT /api/reviews/admin/:id/verification
// @access  Admin only (protect + authorizeRoles('admin'))
//
// Reading the queue was previously the only thing an admin could do, so the
// pending pile had no exit. Approving or rejecting both close the item.
//
// Either decision DESTROYS the ID document and masks the stored number. The
// proof exists to answer one question — is this person who they say they are —
// and once a human has answered it, continuing to hold a government ID is
// storage without a purpose. `idType` and the last four characters are kept so a
// later dispute can be matched without retaining the identifier itself.
const decidePendingVerification = async (req, res) => {
    try {
        const { decision } = req.body;
        if (decision !== 'approve' && decision !== 'reject') {
            return res.status(400).json({ message: "Decision must be either 'approve' or 'reject'." });
        }

        const review = await Review.findById(req.params.id).select('+verification');
        if (!review) return res.status(404).json({ message: 'Review not found.' });

        if (review.verification?.reviewedAt) {
            return res.status(409).json({ message: 'This submission has already been reviewed.' });
        }

        // Capture the asset before the reference is cleared.
        const proofAsset = review.verification?.idProofAsset?.publicId
            ? review.verification.idProofAsset
            : parseDeliveryUrl(review.verification?.idProof);

        const rawNumber = String(review.verification?.idNumber || '');
        const masked = rawNumber.length > 4 ? `••••${rawNumber.slice(-4)}` : '';

        review.verification.verified = decision === 'approve';
        review.verification.verifiedReason = decision === 'approve' ? 'manual-approved' : 'manual-rejected';
        review.verification.reviewedAt = new Date();
        review.verification.reviewedBy = req.user.id;
        review.verification.idNumber = masked;
        review.verification.idProof = '';
        review.verification.idProofAsset = undefined;

        await review.save({ validateModifiedOnly: true });

        // Best-effort, and after the save: the decision is what matters, and a
        // Cloudinary outage must not roll it back or 500 an admin who has already
        // made the call. Failures are logged with the public_id for a manual sweep.
        if (proofAsset) {
            const { failed } = await destroyAssets([proofAsset]);
            if (failed > 0) {
                console.error(`[cleanup] review ${req.params.id}: ID proof survived deletion after ${decision}`);
            }
        }

        res.json({
            success: true,
            message: decision === 'approve' ? 'Marked as verified.' : 'Marked as rejected.',
            reviewId: review._id,
            verified: review.verification.verified,
        });
    } catch (error) {
        if (error.kind === 'ObjectId') return res.status(404).json({ message: 'Review not found.' });
        console.error('Decide verification error:', error.message);
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
    getPendingVerifications,
    decidePendingVerification,
};

// ─────────────────────────────────────────────────────────────────────────────
// The two data-subject rights every privacy regime grants (GDPR Art. 15/17,
// India's DPDP Act s.11/12): see what we hold about you, and have it erased.
//
// Until this existed the "Delete Account" button in Settings was decorative —
// no handler, no endpoint — and there was no way to obtain a copy of one's data
// short of emailing support.
// ─────────────────────────────────────────────────────────────────────────────

const Review = require('../models/Review');
const User = require('../models/User');
const { collectReviewAssets, destroyAssets } = require('./cloudinaryAssets');
const { recalcProperty, repairPropertyImage } = require('../controllers/reviewController');

/**
 * Everything we hold about a user, as plain JSON. The ID number and proof are
 * deliberately NOT included even in masked form: the export is downloaded to
 * whatever device the user is on, and the whole point of the verification
 * design is that the identifier does not travel.
 */
const exportUserData = async (userId) => {
    const user = await User.findById(userId);
    if (!user) return null;

    const reviews = await Review.find({ user: userId })
        .populate('property', 'title streetAddress city state zipCode type')
        .sort({ createdAt: 1 });

    return {
        exportedAt: new Date().toISOString(),
        account: {
            id: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
            isVerified: user.isVerified,
            signInMethods: [
                user.googleId ? 'google' : null,
                user.facebookId ? 'facebook' : null,
            ].filter(Boolean),
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
        },
        reviews: reviews.map((r) => ({
            id: r._id,
            property: r.property
                ? {
                    id: r.property._id,
                    title: r.property.title,
                    streetAddress: r.property.streetAddress,
                    city: r.property.city,
                    state: r.property.state,
                    zipCode: r.property.zipCode,
                    type: r.property.type,
                }
                : null,
            reviewerName: r.reviewerName,
            rating: r.rating,
            title: r.title,
            body: r.body,
            pros: r.pros,
            cons: r.cons,
            photos: r.photos,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
        })),
    };
};

/**
 * Erase a user: every review they wrote (with its photos and any ID proof
 * still in Cloudinary), then the account itself. Property aggregates are
 * recomputed so the site never shows a rating that counts a deleted review.
 *
 * @returns {Promise<{reviewsDeleted:number, assetsFailed:number}>}
 */
const deleteUserAccount = async (userId) => {
    const reviews = await Review.find({ user: userId }).select('+verification +photoAssets');

    let assetsFailed = 0;
    const touchedProperties = new Set();

    for (const review of reviews) {
        const propertyId = review.property;
        const photoUrls = Array.isArray(review.photos) ? [...review.photos] : [];
        const assets = collectReviewAssets(review);

        await review.deleteOne();
        touchedProperties.add(String(propertyId));
        await repairPropertyImage(propertyId, photoUrls);

        const { failed } = await destroyAssets(assets);
        assetsFailed += failed;
    }

    for (const propertyId of touchedProperties) {
        try {
            await recalcProperty(propertyId);
        } catch (err) {
            console.error(`[account-delete] could not recalc property ${propertyId}:`, err.message);
        }
    }

    await User.deleteOne({ _id: userId });

    return { reviewsDeleted: reviews.length, assetsFailed };
};

module.exports = { exportUserData, deleteUserAccount };

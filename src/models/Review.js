const mongoose = require('mongoose');

// A durable handle on a Cloudinary asset.
//
// The delivery URL alone is not enough to delete one: `uploader.destroy` needs
// the resource type and the delivery type, and neither survives the upload — the
// storage engine only reports `path`, `size` and `filename`. Without this, every
// deleted review leaves its photos and its government ID proof in Cloudinary
// permanently. See utils/cloudinaryAssets.js.
//
// The field is `deliveryType`, not `type`: Mongoose treats a nested object with
// a `type` key as a type declaration, so calling it `type` here would silently
// turn the whole reference into a String path.
const assetRefFields = {
    publicId: { type: String, default: '' },
    format: { type: String, default: '' },
    resourceType: { type: String, default: 'image' },
    deliveryType: { type: String, default: 'upload' },
};

const reviewSchema = new mongoose.Schema(
    {
        property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

        reviewerName: { type: String, required: true, trim: true },
        rating: { type: Number, required: true, min: 1, max: 5 },
        // maxlength matters here: multipart bodies bypass the express.json size cap,
        // so without it a 1MB title is storable and re-served in every list response.
        title: { type: String, required: true, trim: true, maxlength: 120 },
        body: { type: String, required: true, trim: true, maxlength: 5000 },

        pros: { type: [String], default: [] },
        cons: { type: [String], default: [] },
        photos: { type: [String], default: [] }, // public image URLs/paths

        // Deletion handles for `photos`, in the same order. `select: false` keeps
        // the API response shape unchanged — this is internal plumbing, not
        // something any client reads. Load it explicitly with
        // `.select('+photoAssets')` when you need to destroy the assets.
        photoAssets: {
            type: [assetRefFields],
            default: [],
            select: false,
        },

        // ── Identity verification — PRIVATE ──────────────────────────────────
        // `select: false` means these never come back in queries unless explicitly
        // requested with .select('+verification'). This honours the privacy notice:
        // "Your ID will only be used for verification and will not be shared publicly."
        verification: {
            type: {
                idType: { type: String, default: '' },
                idNumber: { type: String, default: '' },
                // Cloudinary delivery URL. Since the proof is uploaded as
                // `type: 'authenticated'`, this URL is NOT fetchable on its own —
                // it returns 401 without a signature. Mint a working one with
                // `signedAssetUrl(idProofAsset)`; the admin queue is the only
                // caller that should.
                idProof: { type: String, default: '' },
                // Deletion + signing handle for the proof above.
                idProofAsset: assetRefFields,
                verified: { type: Boolean, default: false },
                // Manual-review record. The queue selects on `verified: false AND
                // reviewedAt: null`, so a REJECTED review leaves the queue too —
                // without this, anything a human turned down would sit in the
                // pending pile forever, indistinguishable from unseen work.
                reviewedAt: { type: Date, default: null },
                reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
                // Why the automated check landed where it did — 'match', 'no-match',
                // 'pdf-skip', 'unsupported-format', 'ocr-error', 'fetch-error'.
                // Verification is advisory, never blocking, so manual review sorts
                // the pending pile by this.
                verifiedReason: { type: String, default: '' },
            },
            select: false,
            default: {},
        },
    },
    { timestamps: true }
);

// A user can only review a given property once
reviewSchema.index({ property: 1, user: 1 }, { unique: true });

module.exports = mongoose.model('Review', reviewSchema);
// const mongoose = require('mongoose');

// const reviewSchema = new mongoose.Schema(
//     {
//         tenant: {
//             type: mongoose.Schema.Types.ObjectId,
//             ref: 'User',
//             required: true,
//         },
//         property: {
//             address: { type: String, required: true, trim: true },
//             city: { type: String, required: true, trim: true },
//             state: { type: String, trim: true },
//             country: { type: String, default: 'India', trim: true },
//         },
//         landlordName: {
//             type: String,
//             trim: true,
//         },
//         ratings: {
//             overall: { type: Number, required: true, min: 1, max: 5 },
//             maintenance: { type: Number, min: 1, max: 5 },
//             communication: { type: Number, min: 1, max: 5 },
//             valueForMoney: { type: Number, min: 1, max: 5 },
//             safety: { type: Number, min: 1, max: 5 },
//         },
//         title: {
//             type: String,
//             required: true,
//             trim: true,
//             maxlength: 100,
//         },
//         body: {
//             type: String,
//             required: true,
//             trim: true,
//             maxlength: 2000,
//         },
//         pros: [{ type: String, trim: true }],
//         cons: [{ type: String, trim: true }],
//         isAnonymous: {
//             type: Boolean,
//             default: false,
//         },
//         isApproved: {
//             type: Boolean,
//             default: true,
//         },
//         helpfulVotes: [
//             {
//                 type: mongoose.Schema.Types.ObjectId,
//                 ref: 'User',
//             },
//         ],
//     },
//     { timestamps: true }
// );

// // Virtual: average rating
// reviewSchema.virtual('averageRating').get(function () {
//     const r = this.ratings;
//     const fields = [r.maintenance, r.communication, r.valueForMoney, r.safety].filter(Boolean);
//     if (!fields.length) return r.overall;
//     return ((r.overall + fields.reduce((a, b) => a + b, 0)) / (fields.length + 1)).toFixed(1);
// });

// reviewSchema.set('toJSON', { virtuals: true });

// module.exports = mongoose.model('Review', reviewSchema);








const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema(
    {
        property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

        reviewerName: { type: String, required: true, trim: true },
        rating: { type: Number, required: true, min: 1, max: 5 },
        title: { type: String, required: true, trim: true },
        body: { type: String, required: true, trim: true },

        pros: { type: [String], default: [] },
        cons: { type: [String], default: [] },
        photos: { type: [String], default: [] }, // public image URLs/paths

        // ── Identity verification — PRIVATE ──────────────────────────────────
        // `select: false` means these never come back in queries unless explicitly
        // requested with .select('+verification'). This honours the privacy notice:
        // "Your ID will only be used for verification and will not be shared publicly."
        verification: {
            type: {
                idType: { type: String, default: '' },
                idNumber: { type: String, default: '' },
                idProof: { type: String, default: '' }, // file path/URL, admin-only
                verified: { type: Boolean, default: false },
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

const mongoose = require('mongoose');

// What the complainant says is wrong. Kept short and concrete: these map onto
// the actions an admin can actually take.
const REASONS = [
    'defamatory',      // untrue, and damaging
    'personal-info',   // names, phone numbers, anything identifying a person
    'not-a-tenant',    // the reviewer never lived here
    'harassment',
    'spam',
    'other',
];

// How the complainant says they relate to the property. Self-declared and
// treated as such  nothing here is verified, which is exactly why a reply is
// published by a human rather than automatically.
const RELATIONSHIPS = ['owner', 'agent', 'resident', 'other'];

const OUTCOMES = [
    'dismissed',        // the review stands
    'review-hidden',    // taken out of public view, record kept
    'reply-published',  // the owner's response is now shown under the review
    'both',             // reply published AND review hidden
];

const reportSchema = new mongoose.Schema(
    {
        review: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Review',
            required: true,
            index: true,
        },
        // Denormalised so the queue still reads sensibly after a review is
        // deleted  otherwise resolving an old complaint shows a blank row.
        propertyLabel: { type: String, default: '' },

        reason: { type: String, enum: REASONS, required: true },
        details: { type: String, required: true, trim: true, maxlength: 3000 },

        // The complainant. This is personal data belonging to someone who is
        // NOT a user, held only so the complaint can be answered.
        reporterName: { type: String, required: true, trim: true, maxlength: 120 },
        reporterEmail: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
        relationship: { type: String, enum: RELATIONSHIPS, default: 'other' },

        // Optional right of reply, submitted with the complaint. Never shown
        // until an admin publishes it  see the note on RELATIONSHIPS.
        requestedReply: { type: String, trim: true, maxlength: 2000, default: '' },

        status: {
            type: String,
            enum: ['pending', 'resolved'],
            default: 'pending',
            index: true,
        },
        outcome: { type: String, enum: OUTCOMES, default: null },
        resolutionNote: { type: String, trim: true, maxlength: 2000, default: '' },
        reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        reviewedAt: { type: Date, default: null },

        // Acknowledgement is a compliance obligation, so record whether it
        // actually went out rather than assuming it did.
        acknowledgedAt: { type: Date, default: null },

        // For spotting someone filing the same complaint from one address.
        // Never shown to anyone.
        ip: { type: String, default: '' },
    },
    { timestamps: true }
);

// The queue: oldest pending first, so nothing rots at the bottom.
reportSchema.index({ status: 1, createdAt: 1 });

const Report = mongoose.model('Report', reportSchema);

Report.on('error', (err) => {
    console.error('Report index build error:', err.message);
});

module.exports = Report;
module.exports.REASONS = REASONS;
module.exports.RELATIONSHIPS = RELATIONSHIPS;
module.exports.OUTCOMES = OUTCOMES;

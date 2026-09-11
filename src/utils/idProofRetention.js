
const Review = require('../models/Review');
const { destroyAssets, parseDeliveryUrl } = require('./cloudinaryAssets');
const { decryptOrBlank, maskIdentifier, isEncrypted } = require('./fieldCrypto');
const { recordAudit } = require('../models/AuditLog');
const { warnOfExpiringIdProofs } = require('./verificationNotice');

const DEFAULT_RETENTION_DAYS = 30;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Give the DB connection and index builds a moment before the first sweep.
const FIRST_SWEEP_DELAY_MS = 2 * 60 * 1000;

const retentionDays = () => {
    const n = Number(process.env.ID_PROOF_RETENTION_DAYS);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
};

/**
 * Destroy a review's ID document and mask its number.
 *
 * @param {import('mongoose').Document} review  loaded with `.select('+verification')`
 * @param {object} opts
 * @param {boolean} opts.verified         final verification verdict to record
 * @param {string}  opts.reason           verifiedReason to record
 * @param {boolean} [opts.markReviewed]   stamp reviewedAt so the item leaves the queue
 * @param {string}  [opts.reviewedBy]     admin user id, when a human decided
 * @returns {Promise<{applied: boolean, assetFailed: boolean}>}
 *   `applied` is false when someone else (an admin, a concurrent sweep) got
 *   there first  the filter on reviewedAt/idProof makes this race-safe.
 */
const retireIdProof = async (review, { verified, reason, markReviewed = false, reviewedBy = null }) => {
    const v = review.verification || {};

    const proofAsset = v.idProofAsset?.publicId ? v.idProofAsset : parseDeliveryUrl(v.idProof);

    // Never mask an already-masked value, and never write the ciphertext's
    // last four characters  decrypt first.
    const stored = v.idNumber || '';
    const plain = isEncrypted(stored) ? decryptOrBlank(stored) : stored;
    const masked = plain.startsWith('••••') ? plain : maskIdentifier(plain);

    const set = {
        'verification.verified': verified,
        'verification.verifiedReason': reason,
        'verification.idNumber': masked,
        'verification.idProof': '',
    };
    if (markReviewed) {
        set['verification.reviewedAt'] = new Date();
        set['verification.reviewedBy'] = reviewedBy;
    }

    const result = await Review.updateOne(
        // A human decision wins over an automated one, and two automated paths
        // cannot both claim the same document.
        { _id: review._id, 'verification.reviewedAt': null },
        { $set: set, $unset: { 'verification.idProofAsset': 1 } }
    );

    if (result.matchedCount === 0) return { applied: false, assetFailed: false };

    let assetFailed = false;
    if (proofAsset) {
        const { failed } = await destroyAssets([proofAsset]);
        assetFailed = failed > 0;
        if (assetFailed) {
            console.error(`[id-retention] review ${review._id}: ID proof survived deletion (${reason})`);
        }
    }
    return { applied: true, assetFailed };
};

/**
 * Retire every proof older than the retention window that no human has ruled
 * on. These leave the admin queue with reason 'expired-unreviewed' so they are
 * distinguishable from a real decision.
 */
const sweepExpiredIdProofs = async () => {
    const cutoff = new Date(Date.now() - retentionDays() * 24 * 60 * 60 * 1000);

    const stale = await Review.find({
        createdAt: { $lt: cutoff },
        'verification.reviewedAt': null,
        'verification.idProof': { $nin: ['', null] },
    })
        .select('+verification')
        .limit(200); // bounded per run; the next run picks up the rest

    let retired = 0;
    let failed = 0;
    for (const review of stale) {
        try {
            const { applied, assetFailed } = await retireIdProof(review, {
                verified: Boolean(review.verification?.verified),
                reason: 'expired-unreviewed',
                markReviewed: true,
            });
            if (applied) retired += 1;
            if (assetFailed) failed += 1;
        } catch (err) {
            failed += 1;
            console.error(`[id-retention] review ${review._id}: sweep failed `, err.message);
        }
    }

    if (stale.length > 0) {
        console.log(`[id-retention] swept ${retired} ID proof(s) older than ${retentionDays()} days (${failed} failure(s))`);
        // No actor  this one is the system, not a person.
        recordAudit({
            action: 'id_proof.expired',
            targetType: 'Review',
            meta: { retired, failed, retentionDays: retentionDays() },
        });
    }
    return { retired, failed };
};

// ── The warning that runs before the destruction ─────────────────────────────
// Days of notice before a proof is swept. Seven is enough to act on over a
// weekend without being so early that the warning arrives while the submission
// might still be handled normally.
const WARN_DAYS = 7;


const warnBeforeExpiry = async () => {
    const days = retentionDays();
    if (days <= WARN_DAYS) return { warned: 0 }; // window too short to warn inside

    const now = Date.now();
    const windowStart = new Date(now - days * 24 * 60 * 60 * 1000);              // about to be swept
    const windowEnd = new Date(now - (days - WARN_DAYS) * 24 * 60 * 60 * 1000);  // still has time

    const criteria = {
        createdAt: { $gte: windowStart, $lt: windowEnd },
        'verification.reviewedAt': null,
        'verification.idProof': { $nin: ['', null] },
    };

    const count = await Review.countDocuments(criteria);
    if (count === 0) return { warned: 0 };


    const oldest = await Review.findOne(criteria).sort({ createdAt: 1 }).select('createdAt');
    const ageDays = oldest
        ? (now - new Date(oldest.createdAt).getTime()) / (24 * 60 * 60 * 1000)
        : 0;
    // Round DOWN, floor at 1. A deadline that understates the time left prompts
    // action early; one that overstates it is how something expires on the day
    // someone was planning to get to it. (Rounding up also turned a submission
    // 6.99 days from expiry into "8 days", which is simply false.)
    const withinDays = Math.max(1, Math.floor(days - ageDays));

    console.warn(
        `[id-retention] ${count} ID proof(s) will be destroyed unreviewed; soonest in ${withinDays} day(s)`
    );
    await warnOfExpiringIdProofs({ count, withinDays, retentionDays: days }).catch(() => {});
    return { warned: count, withinDays };
};

let timer = null;

/** Start the daily sweep. Safe to call once from index.js after connectDB(). */
const startIdProofRetentionSweeper = () => {
    if (timer) return;
    // Warn first, then sweep. Ordering matters: sweeping first would retire the
    // very submissions the warning is about, and the warning would report zero
    // every time  a notice that is always silent and always correct.
    const run = () =>
        warnBeforeExpiry()
            .catch((err) => console.error('[id-retention] expiry warning error:', err.message))
            .then(() => sweepExpiredIdProofs())
            .catch((err) => console.error('[id-retention] sweep error:', err.message));
    const first = setTimeout(() => {
        run();
        timer = setInterval(run, SWEEP_INTERVAL_MS);
        if (typeof timer.unref === 'function') timer.unref();
    }, FIRST_SWEEP_DELAY_MS);
    if (typeof first.unref === 'function') first.unref();
    console.log(`[id-retention] unreviewed ID proofs are destroyed after ${retentionDays()} days`);
};

module.exports = {
    retireIdProof,
    sweepExpiredIdProofs,
    warnBeforeExpiry,
    startIdProofRetentionSweeper,
    retentionDays,
};

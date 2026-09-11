

require('dotenv').config();

const mongoose = require('mongoose');
const Review = require('../models/Review');
const { isEncrypted, isConfigured } = require('../utils/fieldCrypto');

const classify = (value) => {
    const v = String(value || '');
    if (!v) return 'empty';
    if (isEncrypted(v)) return 'encrypted';
    if (v.startsWith('••••')) return 'masked';
    return 'PLAINTEXT';
};

const main = async () => {
    if (!process.env.MONGO_URI) {
        console.error('MONGO_URI is not set. Run this from the backend directory with your .env in place.');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URI);
    console.log(`Connected. DATA_ENCRYPTION_KEY is ${isConfigured() ? 'SET' : 'NOT SET'}.\n`);

    const reviews = await Review.find({})
        .select('+verification createdAt')
        .sort({ createdAt: 1 });

    const counts = { encrypted: 0, masked: 0, PLAINTEXT: 0, empty: 0 };
    const exposed = [];

    for (const review of reviews) {
        const v = review.verification || {};
        const state = classify(v.idNumber);
        counts[state] += 1;

        const age = Math.floor((Date.now() - new Date(review.createdAt).getTime()) / 86400000);
        const decided = v.reviewedAt ? 'decided' : 'pending';
        const hasProof = v.idProof ? 'proof stored' : 'no proof';

        console.log(
            `  ${state.padEnd(10)}  review ${review._id}  ${String(age).padStart(4)}d old  ` +
            `${decided.padEnd(8)}  ${hasProof}` +
            (v.verifiedReason ? `  (${v.verifiedReason})` : '')
        );

        if (state === 'PLAINTEXT') exposed.push(String(review._id));
    }

    console.log(
        `\n${reviews.length} review(s): ` +
        `${counts.encrypted} encrypted, ${counts.masked} masked, ` +
        `${counts.PLAINTEXT} PLAINTEXT, ${counts.empty} with no ID number.`
    );

    if (counts.PLAINTEXT > 0) {
        console.log(
            `\n⚠️  ${counts.PLAINTEXT} ID number(s) are stored in the clear.\n` +
            `   Fix: node src/scripts/encryptExistingIdNumbers.js --apply\n` +
            `   Affected: ${exposed.join(', ')}`
        );
    } else {
        console.log('\n✅ No ID number is stored in the clear.');
    }

    // A masked number means the verification is finished and only the last four
    // characters remain  that is the end state, not a gap.
    if (counts.masked > 0) {
        console.log(
            `   (${counts.masked} masked = verification settled, full number already discarded.)`
        );
    }

    await mongoose.disconnect();
};

main().catch(async (err) => {
    console.error('Check failed:', err.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});

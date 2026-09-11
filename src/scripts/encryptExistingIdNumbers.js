

require('dotenv').config();

const mongoose = require('mongoose');
const Review = require('../models/Review');
const { encrypt, isEncrypted, isConfigured, maskIdentifier } = require('../utils/fieldCrypto');

const APPLY = process.argv.includes('--apply');

const main = async () => {
    if (!process.env.MONGO_URI) {
        console.error('MONGO_URI is not set. Run this from the backend directory with your .env in place.');
        process.exit(1);
    }
    if (!isConfigured()) {
        console.error('DATA_ENCRYPTION_KEY is not set  nothing to encrypt with.');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URI);
    console.log(`Connected. Mode: ${APPLY ? 'APPLY (will modify data)' : 'DRY RUN (no changes)'}\n`);

    const reviews = await Review.find({ 'verification.idNumber': { $nin: ['', null] } })
        .select('+verification')
        .sort({ createdAt: 1 });

    console.log(`${reviews.length} review(s) carry an ID number.\n`);

    let encrypted = 0;
    let masked = 0;
    let skipped = 0;

    for (const review of reviews) {
        const v = review.verification;
        const current = v.idNumber;
        const label = `review ${review._id}`;

        if (isEncrypted(current) || current.startsWith('••••')) {
            skipped += 1;
            continue;
        }

        // Settled (a human ruled, or it expired) → the full number has no
        // remaining purpose; keep the last four only.
        if (v.reviewedAt) {
            console.log(`  ▪  ${label}: settled  masking`);
            if (APPLY) {
                await Review.updateOne(
                    { _id: review._id },
                    { $set: { 'verification.idNumber': maskIdentifier(current) } }
                );
            }
            masked += 1;
            continue;
        }

        console.log(`  🔒 ${label}: pending  encrypting`);
        if (APPLY) {
            await Review.updateOne(
                { _id: review._id },
                { $set: { 'verification.idNumber': encrypt(current) } }
            );
        }
        encrypted += 1;
    }

    console.log(
        `\n${APPLY ? 'Encrypted' : 'Would encrypt'}: ${encrypted}   ` +
        `${APPLY ? 'Masked' : 'Would mask'}: ${masked}   Skipped: ${skipped}`
    );
    if (!APPLY && encrypted + masked > 0) {
        console.log('\nRe-run with --apply to make these changes.');
    }

    await mongoose.disconnect();
};

main().catch(async (err) => {
    console.error('Migration failed:', err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});

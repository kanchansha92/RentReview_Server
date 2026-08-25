
require('dotenv').config();

const mongoose = require('mongoose');
const Review = require('../models/Review');
const cloudinary = require('../config/cloudinaryConfig');
const { parseDeliveryUrl, ID_PROOF_TYPE } = require('../utils/cloudinaryAssets');

const APPLY = process.argv.includes('--apply');

const main = async () => {
    if (!process.env.MONGO_URI) {
        console.error('MONGO_URI is not set. Run this from the backend directory with your .env in place.');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URI);
    console.log(`Connected. Mode: ${APPLY ? 'APPLY (will modify data)' : 'DRY RUN (no changes)'}\n`);

    const reviews = await Review.find({ 'verification.idProof': { $nin: ['', null] } })
        .select('+verification')
        .sort({ createdAt: 1 });

    console.log(`${reviews.length} review(s) carry an ID proof.\n`);

    let moved = 0;
    let skipped = 0;
    let failed = 0;

    for (const review of reviews) {
        const url = review.verification?.idProof;
        const parsed = parseDeliveryUrl(url);
        const label = `review ${review._id}`;

        if (!parsed) {
            console.warn(`  ?  ${label}: could not parse the stored URL — skipping\n     ${url}`);
            skipped += 1;
            continue;
        }

        if (parsed.deliveryType === ID_PROOF_TYPE) {
            // Already private. Backfill the reference if it is missing, so delete
            // and signing work for this row too.
            if (!review.verification.idProofAsset?.publicId) {
                console.log(`  +  ${label}: already private, backfilling asset reference`);
                if (APPLY) {
                    review.verification.idProofAsset = parsed;
                    await review.save({ validateModifiedOnly: true });
                }
            }
            skipped += 1;
            continue;
        }

        console.log(`  →  ${label}: ${parsed.deliveryType} → ${ID_PROOF_TYPE}  (${parsed.publicId})`);

        if (!APPLY) {
            moved += 1;
            continue;
        }

        try {
            const result = await cloudinary.uploader.rename(parsed.publicId, parsed.publicId, {
                resource_type: parsed.resourceType,
                type: parsed.deliveryType,
                to_type: ID_PROOF_TYPE,
                invalidate: true,
            });

            const newUrl = result.secure_url || result.url || '';
            review.verification.idProof = newUrl;
            review.verification.idProofAsset = parseDeliveryUrl(newUrl) || {
                publicId: parsed.publicId,
                format: parsed.format,
                resourceType: parsed.resourceType,
                deliveryType: ID_PROOF_TYPE,
            };
            await review.save({ validateModifiedOnly: true });
            moved += 1;
        } catch (err) {
            console.error(`  !  ${label}: ${err.message}`);
            failed += 1;
        }
    }

    console.log(
        `\n${APPLY ? 'Moved' : 'Would move'}: ${moved}   Skipped: ${skipped}   Failed: ${failed}`
    );
    if (!APPLY && moved > 0) {
        console.log('\nRe-run with --apply to make these changes.');
    }

    await mongoose.disconnect();
};

main().catch(async (err) => {
    console.error('Migration failed:', err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});

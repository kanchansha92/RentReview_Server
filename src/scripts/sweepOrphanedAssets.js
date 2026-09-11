
require('dotenv').config();

const mongoose = require('mongoose');
const cloudinary = require('../config/cloudinaryConfig');
const Review = require('../models/Review');
const Property = require('../models/Property');
const {
    ID_PROOF_FOLDER,
    PHOTO_FOLDER,
    ID_PROOF_TYPE,
    parseDeliveryUrl,
} = require('../utils/cloudinaryAssets');

const APPLY = process.argv.includes('--apply');

// Assets younger than this are skipped: a review being submitted right now has
// its files in Cloudinary before the document exists, and deleting those would
// break the submission mid-flight.
const MIN_AGE_HOURS = 24;

/** Every public_id the database still points at, from every field that holds one. */
const referencedPublicIds = async () => {
    const ids = new Set();
    const add = (v) => v && ids.add(v);

    // `verification` and `photoAssets` are select:false  ask for them.
    const cursor = Review.find({}).select('+verification +photoAssets photos').cursor();
    for await (const review of cursor) {
        (review.photoAssets || []).forEach((a) => add(a && a.publicId));
        (review.photos || []).forEach((url) => add((parseDeliveryUrl(url) || {}).publicId));
        const v = review.verification || {};
        add(v.idProofAsset && v.idProofAsset.publicId);
        add((parseDeliveryUrl(v.idProof) || {}).publicId);
    }

    // A property's cover image is a copy of a review photo's URL. It can outlive
    // the review it came from, so it counts as a reference in its own right.
    const props = await Property.find({ image: { $nin: ['', null] } }).select('image');
    props.forEach((p) => add((parseDeliveryUrl(p.image) || {}).publicId));

    return ids;
};

/** Page through a Cloudinary folder. */
const listFolder = async (folder, type) => {
    const found = [];
    let nextCursor;
    do {
        const res = await cloudinary.api.resources({
            type,
            prefix: folder,
            max_results: 500,
            ...(nextCursor ? { next_cursor: nextCursor } : {}),
        });
        found.push(...(res.resources || []));
        nextCursor = res.next_cursor;
    } while (nextCursor);
    return found;
};

const main = async () => {
    if (!process.env.MONGO_URI) {
        console.error('MONGO_URI is not set. Run this from the backend directory with your .env in place.');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URI);
    console.log(`Connected. Mode: ${APPLY ? 'APPLY (will delete)' : 'DRY RUN (no changes)'}\n`);

    const referenced = await referencedPublicIds();
    console.log(`${referenced.size} asset(s) are referenced by the database.\n`);

    const targets = [
        { folder: PHOTO_FOLDER, type: 'upload', label: 'photos' },
        { folder: ID_PROOF_FOLDER, type: ID_PROOF_TYPE, label: 'ID proofs' },
    ];

    const cutoff = Date.now() - MIN_AGE_HOURS * 60 * 60 * 1000;
    let deleted = 0;
    let failed = 0;
    let skippedYoung = 0;

    for (const { folder, type, label } of targets) {
        let resources;
        try {
            resources = await listFolder(folder, type);
        } catch (err) {
            console.error(`  !  could not list ${folder} (${type}): ${err.message}`);
            failed += 1;
            continue;
        }

        const orphans = resources.filter((r) => !referenced.has(r.public_id));
        console.log(`${label}: ${resources.length} in Cloudinary, ${orphans.length} unreferenced`);

        for (const asset of orphans) {
            if (new Date(asset.created_at).getTime() > cutoff) {
                skippedYoung += 1;
                continue;
            }

            const kb = Math.round((asset.bytes || 0) / 1024);
            console.log(`  →  ${asset.public_id}  (${kb} KB, uploaded ${asset.created_at})`);

            if (!APPLY) {
                deleted += 1;
                continue;
            }

            try {
                const res = await cloudinary.uploader.destroy(asset.public_id, {
                    resource_type: asset.resource_type,
                    type,
                    invalidate: true,
                });
                if (res.result === 'ok' || res.result === 'not found') deleted += 1;
                else {
                    console.warn(`  !  destroy returned "${res.result}" for ${asset.public_id}`);
                    failed += 1;
                }
            } catch (err) {
                console.error(`  !  ${asset.public_id}: ${err.message}`);
                failed += 1;
            }
        }
        console.log('');
    }

    console.log(
        `${APPLY ? 'Deleted' : 'Would delete'}: ${deleted}   ` +
        `Skipped (under ${MIN_AGE_HOURS}h): ${skippedYoung}   Failed: ${failed}`
    );
    if (!APPLY && deleted > 0) console.log('\nRe-run with --apply to delete these.');

    await mongoose.disconnect();
};

main().catch(async (err) => {
    console.error('Sweep failed:', err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});

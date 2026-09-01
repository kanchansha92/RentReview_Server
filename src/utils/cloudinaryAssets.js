
const cloudinary = require('../config/cloudinaryConfig');

// Cloudinary delivery type for ID proofs. Assets stored under `authenticated`
// are not retrievable from the public /image/upload/ namespace at all.
const ID_PROOF_TYPE = 'authenticated';

const ID_PROOF_FOLDER = 'rent-review/id-proofs';
const PHOTO_FOLDER = 'rent-review/photos';

// Escape hatch. Private delivery is the default and should stay on; this exists
// so a Cloudinary account that rejects authenticated uploads can be rolled back
// with an env var instead of a redeploy. Set to the literal string 'false' to
// disable — anything else (including unset) keeps proofs private.
const ID_PROOFS_PRIVATE = process.env.CLOUDINARY_PRIVATE_ID_PROOFS !== 'false';

if (!ID_PROOFS_PRIVATE) {
    console.warn(
        '⚠️  CLOUDINARY_PRIVATE_ID_PROOFS=false — ID proofs are being uploaded to the PUBLIC ' +
        'Cloudinary namespace. Anyone with the URL can read them. Unset this in production.'
    );
}

// A Cloudinary delivery URL, picked apart:
//   https://res.cloudinary.com/<cloud>/image/authenticated/s--SIG--/v1712/rent-review/id-proofs/ab12.jpg
//            resourceType ──┘        deliveryType ─┘                       └── publicId ──┘ └ format
// The transformation/signature segments between the type and the version are
// optional and are skipped.
const DELIVERY_URL = /\/(image|video|raw)\/(upload|authenticated|private)\/(?:.*?\/)?v\d+\/(.+?)(?:\.([a-z0-9]{2,5}))?$/i;

const MIME_TO_FORMAT = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'application/pdf': 'pdf',
};

/**
 * Recover a full asset reference from a Cloudinary delivery URL.
 * Used for documents stored before references were kept (every review written
 * before this change has only a URL), and to cross-check freshly uploaded files.
 *
 * @returns {{publicId:string, format:string, resourceType:string, deliveryType:string}|null}
 */
const parseDeliveryUrl = (url) => {
    const match = DELIVERY_URL.exec(String(url || '').split('?')[0]);
    if (!match) return null;
    return {
        publicId: match[3],
        format: (match[4] || '').toLowerCase(),
        resourceType: match[1].toLowerCase(),
        deliveryType: match[2].toLowerCase(),
    };
};

/**
 * Build the durable reference for a file multer just uploaded.
 *
 * The delivery URL Cloudinary handed back states which namespace the asset
 * actually landed in, so it is trusted over what we asked for — the stored
 * reference then cannot drift from reality if the upload options ever change or
 * an account setting overrides them.
 *
 * @returns {{publicId:string, format:string, resourceType:string, deliveryType:string}|null}
 */
const assetRefFromFile = (file) => {
    if (!file || !file.filename) return null;

    const fromUrl = parseDeliveryUrl(file.path);
    const isIdProof = file.fieldname === 'idProof';

    return {
        // `filename` is the public_id — the one field the storage engine does set.
        publicId: file.filename,
        format: (fromUrl && fromUrl.format) || MIME_TO_FORMAT[String(file.mimetype || '').toLowerCase()] || '',
        resourceType: (fromUrl && fromUrl.resourceType) || 'image',
        deliveryType:
            (fromUrl && fromUrl.deliveryType) ||
            (isIdProof && ID_PROOFS_PRIVATE ? ID_PROOF_TYPE : 'upload'),
    };
};

/** Normalise a stored Mongoose subdocument into a plain reference. */
const toPlainRef = (ref) => {
    if (!ref || !ref.publicId) return null;
    return {
        publicId: ref.publicId,
        format: ref.format || '',
        resourceType: ref.resourceType || 'image',
        deliveryType: ref.deliveryType || 'upload',
    };
};


const signedAssetUrl = (ref) => {
    const plain = toPlainRef(ref);
    if (!plain) return '';

    try {
        return cloudinary.url(plain.publicId, {
            resource_type: plain.resourceType,
            type: plain.deliveryType,
            format: plain.format || undefined,
            // A public asset signs harmlessly, but there is no reason to.
            sign_url: plain.deliveryType !== 'upload',
            secure: true,
        });
    } catch (err) {
        console.error('[cloudinary] could not build URL for', plain.publicId, err.message);
        return '';
    }
};

/**
 * Destroy assets, best-effort. Never throws and never rejects: callers use this
 * on paths where the database change has already happened, and a Cloudinary
 * hiccup must not turn a successful delete into a 500. Failures are logged with
 * the public_id so they can be swept by hand.
 *
 * @param {Array} refs asset references (nulls are ignored)
 * @returns {Promise<{destroyed:number, failed:number}>}
 */
const destroyAssets = async (refs = []) => {
    const plain = (Array.isArray(refs) ? refs : []).map(toPlainRef).filter(Boolean);
    if (plain.length === 0) return { destroyed: 0, failed: 0 };

    const outcomes = await Promise.all(
        plain.map(async (ref) => {
            try {
                const res = await cloudinary.uploader.destroy(ref.publicId, {
                    resource_type: ref.resourceType,
                    type: ref.deliveryType,
                    invalidate: true,
                });
                // 'not found' is a success for our purposes — the asset is gone.
                const result = res && res.result;
                if (result === 'ok' || result === 'not found') return true;
                console.warn('[cloudinary] destroy returned', result, 'for', ref.publicId);
                return false;
            } catch (err) {
                console.error('[cloudinary] could not destroy', ref.publicId, '—', err.message);
                return false;
            }
        })
    );

    const destroyed = outcomes.filter(Boolean).length;
    return { destroyed, failed: outcomes.length - destroyed };
};


const collectReviewAssets = (review) => {
    if (!review) return [];

    const refs = [];
    const seen = new Set();

    const add = (ref) => {
        const plain = toPlainRef(ref);
        if (!plain || seen.has(plain.publicId)) return;
        seen.add(plain.publicId);
        refs.push(plain);
    };

    // ── ID proof ──
    add(review.verification && review.verification.idProofAsset);
    if (review.verification && review.verification.idProof) {
        add(parseDeliveryUrl(review.verification.idProof));
    }

    // ── Photos ──
    (Array.isArray(review.photoAssets) ? review.photoAssets : []).forEach(add);
    (Array.isArray(review.photos) ? review.photos : []).forEach((url) => add(parseDeliveryUrl(url)));

    return refs;
};

module.exports = {
    ID_PROOF_TYPE,
    ID_PROOF_FOLDER,
    PHOTO_FOLDER,
    ID_PROOFS_PRIVATE,
    parseDeliveryUrl,
    assetRefFromFile,
    toPlainRef,
    signedAssetUrl,
    destroyAssets,
    collectReviewAssets,
};

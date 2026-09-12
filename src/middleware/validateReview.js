
const { assetRefFromFile, destroyAssets } = require('../utils/cloudinaryAssets');
const { detectPersonalInfo } = require('../utils/detectPersonalInfo');

// upload.fields([{ idProof: 1 }, { photos: 10 }]) × 10MB each, plus slack for
// the multipart envelope and the text fields.
const MAX_TOTAL_UPLOAD_BYTES = 11 * 10 * 1024 * 1024 + 1024 * 1024;

// Server-side ID number format rules (mirror the frontend so it can't be bypassed)
const ID_RULES = {
    'Aadhaar Card': /^\d{12}$/,
    'PAN Card': /^[A-Z]{5}[0-9]{4}[A-Z]$/,
    'Driving License': /^[A-Z]{2}\d{8,15}$/,
    'Passport': /^[A-Z][0-9]{7}$/,
    'Voter ID': /^[A-Z]{3}[0-9]{7}$/,
};

// ─── Aadhaar check digit (Verhoeff) ──────────────────────────────────────────
// Every real Aadhaar number carries a Verhoeff check digit, so `/^\d{12}$/`
// alone accepted any twelve digits at all  000000000000 included. This is the
// standard Verhoeff algorithm: the dihedral group D5 multiplication table, its
// permutation table, and the inverse table.
const VERHOEFF_D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

const isValidAadhaar = (digits) => {
    if (!/^\d{12}$/.test(digits)) return false;
    // UIDAI never issues a number starting with 0 or 1.
    if (digits[0] === '0' || digits[0] === '1') return false;

    let c = 0;
    const reversed = digits.split('').reverse();
    for (let i = 0; i < reversed.length; i += 1) {
        c = VERHOEFF_D[c][VERHOEFF_P[i % 8][Number(reversed[i])]];
    }
    return c === 0;
};

const isValidIdNumber = (idType, idNumber) => {
    const rx = ID_RULES[idType];
    if (!rx) return false;
    const clean = String(idNumber || '').replace(/[\s-]/g, '').toUpperCase();
    if (!rx.test(clean)) return false;
    // Format alone is not enough for Aadhaar  it has a check digit.
    if (idType === 'Aadhaar Card') return isValidAadhaar(clean);
    return true;
};

// A present, non-empty string. Guards against `{"reviewTitle": 123}` reaching
// `.trim()` and turning a 400 into a 500.
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

// 1–5 inclusive AND a whole number  4.7 used to be accepted.
const isValidRating = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 5;
};

// Field-length caps, matched to the Review schema's maxlength.
const LIMITS = { name: 120, reviewTitle: 120, review: 5000, address: 300 };

/**
 * Cheap request-shape validation for POST /api/reviews.
 * Runs at the top of the controller, before OCR / geocoding / any DB work.
 * @returns {string|null} an error message, or null when the body is acceptable.
 */
const validateReviewBody = (body = {}) => {
    if (!isNonEmptyString(body.streetAddress) || !isNonEmptyString(body.city) || !isNonEmptyString(body.state)) {
        return 'Street address, city, and state are required.';
    }
    if (body.streetAddress.trim().length > LIMITS.address) {
        return 'Street address is too long.';
    }
    if (!isValidRating(body.rating)) {
        return 'Please select a whole-number rating between 1 and 5.';
    }
    if (!isNonEmptyString(body.name)) return 'Your name is required.';
    if (body.name.trim().length > LIMITS.name) return 'Your name is too long.';

    if (!isNonEmptyString(body.reviewTitle)) return 'Review title is required.';
    if (body.reviewTitle.trim().length > LIMITS.reviewTitle) {
        return `Review title must be ${LIMITS.reviewTitle} characters or fewer.`;
    }

    if (!isNonEmptyString(body.review)) return 'Review text is required.';
    if (body.review.trim().length > LIMITS.review) {
        return `Review text must be ${LIMITS.review} characters or fewer.`;
    }

  
    const pii = detectPersonalInfo(
        body.reviewTitle,
        body.review,
        body.pros,
        body.cons,
        body.name
    );
    if (pii) return pii.message;

    if (!isNonEmptyString(body.idType)) return 'ID type is required.';
    if (!isNonEmptyString(body.idNumber)) return 'ID number is required.';
    if (!isValidIdNumber(body.idType, body.idNumber)) {
        return body.idType === 'Aadhaar Card'
            // Distinguish "wrong shape" from "twelve digits that are not a real
            // Aadhaar number", so someone who mistyped one digit knows to look.
            ? 'That is not a valid Aadhaar number. Please check the 12 digits and try again.'
            : `The ID number does not match the format for ${body.idType}.`;
    }

    return null;
};


const cleanupUploads = async (req) => {
    if (!req || !req.files || req._uploadsCleaned) return;

    if (req._uploadsCommitted) return;
    req._uploadsCleaned = true;

    const files = Object.values(req.files).flat().filter(Boolean);
    const refs = files.map(assetRefFromFile).filter(Boolean);

    // Logs each failure with its public_id so orphans can be swept manually.
    await destroyAssets(refs);
};


const preUploadCheck = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ message: 'Not authorised.' });
    }

    const contentType = req.headers['content-type'] || '';
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
        return res.status(400).json({
            message: 'Review submissions must be sent as multipart/form-data.',
        });
    }

    // Reject an oversized payload on the declared length before a single byte is
    // proxied to Cloudinary. multer still enforces the real per-file 10MB cap.
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_TOTAL_UPLOAD_BYTES) {
        return res.status(413).json({
            message: 'Upload is too large. Photos and your ID proof must be under 10MB each.',
        });
    }

    next();
};

module.exports = {
    preUploadCheck,
    validateReviewBody,
    cleanupUploads,
    isValidIdNumber,
    isValidAadhaar,
    isNonEmptyString,
    isValidRating,
    ID_RULES,
    LIMITS,
};

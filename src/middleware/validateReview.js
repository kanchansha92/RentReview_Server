
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

const isValidIdNumber = (idType, idNumber) => {
    const rx = ID_RULES[idType];
    if (!rx) return false;
    const clean = String(idNumber || '').replace(/[\s-]/g, '').toUpperCase();
    return rx.test(clean);
};

// A present, non-empty string. Guards against `{"reviewTitle": 123}` reaching
// `.trim()` and turning a 400 into a 500.
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

// 1–5 inclusive AND a whole number — 4.7 used to be accepted.
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
        return `The ID number does not match the format for ${body.idType}.`;
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
    isNonEmptyString,
    isValidRating,
    ID_RULES,
    LIMITS,
};

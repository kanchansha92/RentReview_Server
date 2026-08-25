const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinaryConfig');
const {
    ID_PROOF_TYPE,
    ID_PROOF_FOLDER,
    PHOTO_FOLDER,
    ID_PROOFS_PRIVATE,
    assetRefFromFile,
    destroyAssets,
} = require('../utils/cloudinaryAssets');

const ALLOWED_FORMATS = ['jpg', 'jpeg', 'png', 'gif', 'pdf'];

// ─────────────────────────────────────────────────────────────────────────────
// The two upload fields have different privacy requirements, so they get
// different destinations.
//
//   photos  → rent-review/photos,    public. They are shown to every visitor.
//   idProof → rent-review/id-proofs, type: 'authenticated'. A government ID
//             document must not be readable by anyone who obtains its URL, and
//             Cloudinary's default (`type: 'upload'`) makes it exactly that.
//
// `params` may be a function of (req, file) — see multer-storage-cloudinary's
// lib/index.js — which is what makes the per-field split possible.
//
// resource_type is deliberately left at Cloudinary's default (`image`) for both.
// PDFs are handled as image resources there, which is what the OCR step and the
// existing stored URLs already assume; switching to `auto` would move PDFs to
// the `raw` namespace and invalidate every URL written so far.
// ─────────────────────────────────────────────────────────────────────────────
const storage = new CloudinaryStorage({
    cloudinary,
    params: (req, file) => {
        if (file.fieldname === 'idProof') {
            return {
                folder: ID_PROOF_FOLDER,
                allowed_formats: ALLOWED_FORMATS,
                ...(ID_PROOFS_PRIVATE ? { type: ID_PROOF_TYPE } : {}),
            };
        }

        return {
            folder: PHOTO_FOLDER,
            allowed_formats: ALLOWED_FORMATS,
        };
    },
});

// multer calls the storage engine's `_removeFile` for files it already uploaded
// when a LATER file in the same request fails — a fileFilter rejection on photo
// three, say. The library's implementation calls `destroy(public_id)` with no
// `type`, which silently cannot find an authenticated asset, so an ID proof
// would be orphaned on exactly the path that is meant to clean it up. (That path
// also never reaches the controller, so `cleanupUploads` does not cover it.)
// Route it through the shared helper, which passes resource_type and type.
storage._removeFile = (req, file, callback) => {
    destroyAssets([assetRefFromFile(file)])
        .then(() => callback(null))
        .catch((err) => callback(err));
};

const fileFilter = (req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'application/pdf'];
    if (allowed.includes(file.mimetype)) {
        cb(null, true);
    } else {
        // Tag the error with a status so the global handler answers 400, not 500.
        // (multer's own MulterError — e.g. LIMIT_FILE_SIZE → 413 — is passed
        // through untouched and handled centrally in index.js.)
        const err = new Error('Only PNG, JPG, GIF, or PDF files are allowed.');
        err.status = 400;
        err.statusCode = 400;
        cb(err, false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file
});

module.exports = upload;

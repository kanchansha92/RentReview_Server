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


const stripMetadata = (file) => {
    const mime = String(file && file.mimetype || '').toLowerCase();
    return mime.startsWith('image/')
        ? { transformation: [{ flags: 'strip_profile' }] }
        : {};
};

const storage = new CloudinaryStorage({
    cloudinary,
    params: (req, file) => {
        if (file.fieldname === 'idProof') {
            return {
                folder: ID_PROOF_FOLDER,
                allowed_formats: ALLOWED_FORMATS,
                ...stripMetadata(file),
                ...(ID_PROOFS_PRIVATE ? { type: ID_PROOF_TYPE } : {}),
            };
        }

        return {
            folder: PHOTO_FOLDER,
            allowed_formats: ALLOWED_FORMATS,
            ...stripMetadata(file),
        };
    },
});


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
        // (multer's own MulterError  e.g. LIMIT_FILE_SIZE → 413  is passed
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

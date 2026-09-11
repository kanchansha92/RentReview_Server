require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/database');
const securityHeaders = require('./middleware/securityHeaders');
const rejectMongoOperators = require('./middleware/rejectMongoOperators');
const { startIdProofRetentionSweeper } = require('./utils/idProofRetention');

// --- Boot-time environment checks ---
// Without JWT_SECRET every token operation is broken (or, worse, signed with
// `undefined`), so fail fast rather than starting a subtly broken server.
if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not set. Refusing to start.');
}
// Government ID numbers are encrypted at rest with DATA_ENCRYPTION_KEY
// (utils/fieldCrypto.js). In production that is not optional.
const fieldCrypto = require('./utils/fieldCrypto');
if (!fieldCrypto.isConfigured()) {
    if (process.env.NODE_ENV === 'production') {
        throw new Error(
            'DATA_ENCRYPTION_KEY is not set. Refusing to start: ID numbers would be stored in plaintext. ' +
            'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
        );
    }
    console.warn('⚠️  DATA_ENCRYPTION_KEY is not set  ID numbers will be stored UNENCRYPTED. Fine locally, never in production.');
}
if (!process.env.FRONTEND_URL) {
    console.warn(
        '⚠️  FRONTEND_URL is not set  CORS will allow every origin and password-reset links will be malformed.'
    );
}

// Routes
require('./config/passport');
const authRoutes = require('./routes/authRoutes');
const reviewRoutes = require('./routes/reviewRoutes');
const propertyRoutes = require('./routes/propertyRoutes');
const placesRoutes = require('./routes/placesRoutes');
const contactRoutes = require('./routes/contactRoutes');
const reportRoutes = require('./routes/reportRoutes');

const app = express();
const PORT = process.env.PORT || 5000;

// Deployed on Render behind a proxy  without this every request reports the
// proxy's address as req.ip and the rate limiters bucket the whole world together.
app.set('trust proxy', 1);

// Connect to MongoDB
connectDB();

// Unreviewed ID proofs are destroyed after ID_PROOF_RETENTION_DAYS (default 30).
startIdProofRetentionSweeper();

// Middleware
// Security headers go on FIRST, so every response carries them  including the
// 404 handler and the global error handler at the bottom of this file.
app.disable('x-powered-by');
app.use(securityHeaders);

// FRONTEND_URL is a comma-separated allow-list so localhost dev and the
// deployed frontend can both be permitted. Shared with the sign-out route,
// which checks the Origin directly  see utils/allowedOrigins.js.
const { ALLOWED_ORIGINS: allowedOrigins, isAllowedOrigin } = require('./utils/allowedOrigins');

if (allowedOrigins.length === 0) {
    // With `credentials: true` an allow-all fallback is not a soft default: it
    // hands every origin on the internet a credentialed grant, so any page the
    // user visits could drive this API as them. Tolerable while developing,
    // never in production.
    if (process.env.NODE_ENV === 'production') {
        throw new Error(
            'FRONTEND_URL is not set. Refusing to start: with credentialed CORS, an empty ' +
            'allow-list would let any origin make authenticated requests on a user\'s behalf.'
        );
    }
    console.warn('⚠️  No FRONTEND_URL configured  allowing ALL origins. Development only.');
}

app.use(
    cors({
        origin: (origin, callback) => {
            if (isAllowedOrigin(origin)) return callback(null, true);
            // `callback(null, false)` simply omits the CORS headers, so the
            // browser blocks the response  which is the correct outcome. Passing
            // an Error instead would send every disallowed request (including
            // every crawler and bot) through the global error handler as a logged
            // 500, which is both noisy and misleading.
            return callback(null, false);
        },
        credentials: true,
    })
);
// Explicit cap (this is also the default) so it is visible here rather than
// buried in body-parser. Review submissions are multipart and go through multer.
app.use(express.json({ limit: '100kb' }));
// `$`-prefixed / dotted keys in a JSON body are never legitimate here.
app.use(rejectMongoOperators);

// CSRF is enforced inside `protect` (middleware/authMiddleware.js) rather than
// globally: it keys on how a request actually authenticated, so public routes 
// sign-in, sign-out, the contact form  are never caught by it. See the header
// comment in middleware/csrf.js.

// Passport configuration
const passport = require('passport');
app.use(passport.initialize());

// NOTE: the `/uploads` static mount was removed. The directory does not exist,
// and if it were ever created it would have served uploaded government ID
// proofs to anyone who guessed a filename. Uploads live in Cloudinary.

// Health check
app.get('/', (req, res) => {
    res.json({ message: 'Rent Review API is running 🚀' });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/properties', propertyRoutes);
app.use('/api/places', placesRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/reports', reportRoutes);

// 404 handler
app.use((req, res) => {
    res.status(404).json({ message: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
    // Always log the full error server-side.
    console.error('SERVER ERROR:', err);

    // Multer surfaces client mistakes (file too large, too many files, wrong
    // field) as errors  those are 400/413, not 500.
    if (err && err.name === 'MulterError') {
        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        const multerMessages = {
            LIMIT_FILE_SIZE: 'File is too large. Please upload a smaller file.',
            LIMIT_FILE_COUNT: 'Too many files uploaded.',
            LIMIT_UNEXPECTED_FILE: `Unexpected file field${err.field ? ` '${err.field}'` : ''}.`,
            LIMIT_PART_COUNT: 'Too many parts in the upload.',
            LIMIT_FIELD_KEY: 'Upload field name is too long.',
            LIMIT_FIELD_VALUE: 'Upload field value is too long.',
            LIMIT_FIELD_COUNT: 'Too many fields in the upload.',
        };
        return res.status(status).json({
            success: false,
            message: multerMessages[err.code] || 'File upload failed. Please check your files and try again.',
        });
    }

    const status = err.status || 500;

    // Never echo internal error text (Mongoose/driver internals) in production.
    if (process.env.NODE_ENV === 'production' && status >= 500) {
        return res.status(status).json({ success: false, message: 'Internal server error' });
    }

    res.status(status).json({
        success: false,
        message: err.message || 'An internal server error occurred.',
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});

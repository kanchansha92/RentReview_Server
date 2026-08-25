const express = require('express');
const router = express.Router();
const {
    register,
    login,
    getMe,
    updateProfile,
    changePassword,
    forgotPassword,
    resetPassword,
    verifyEmail,
    resendVerification,
    exchangeOAuthCode,
} = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');
const createRateLimit = require('../middleware/rateLimit');
const { issueCode } = require('../utils/oauthCodes');
const passport = require('passport');
const jwt = require('jsonwebtoken');

// --- Rate limiters (in-memory, per-instance — see middleware/rateLimit.js) ---
const normalizeEmail = (req) =>
    typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';

// TWO composed limiters, and both are needed.
//
// Per IP+email stops someone grinding one account's password. On its own it does
// NOT stop credential stuffing — that attack is a list of distinct (email,
// password) pairs, so every attempt lands in a fresh bucket and the limiter
// never fires. The per-IP limiter is what caps total attempts from one source.
// It sits well above what a real person hitting refresh would ever produce.
const loginEmailLimiter = createRateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyGenerator: (req) => {
        const email = normalizeEmail(req);
        return email ? `login:email:${req.ip}:${email}` : null;
    },
    message: 'Too many login attempts for this account. Please try again in 15 minutes.',
});

const loginIpLimiter = createRateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    keyGenerator: (req) => `login:ip:${req.ip}`,
    message: 'Too many login attempts from this network. Please try again in 15 minutes.',
});

// Limits are per IP. Offices, universities and mobile CGNAT put many real users
// behind one address, so these are set to stop automated abuse without locking
// out a floor of colleagues signing up on the same afternoon.
const registerLimiter = createRateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    keyGenerator: (req) => `register:${req.ip}`,
    message: 'Too many accounts created from this address. Please try again later.',
});

// Two composed limiters: one per IP, one per target email — so an attacker
// can neither spray many addresses nor mail-bomb a single victim.
// The per-email limiter below is what actually stops mail-bombing a victim; the
// per-IP one only needs to be loose enough that shared networks still work.
const forgotPasswordIpLimiter = createRateLimit({
    windowMs: 60 * 60 * 1000,
    max: 12,
    keyGenerator: (req) => `forgot:ip:${req.ip}`,
    message: 'Too many password reset requests. Please try again later.',
});

const forgotPasswordEmailLimiter = createRateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    keyGenerator: (req) => {
        const email = normalizeEmail(req);
        return email ? `forgot:email:${email}` : null;
    },
    message: 'Too many password reset requests. Please try again later.',
});

const resetPasswordLimiter = createRateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    keyGenerator: (req) => `reset:${req.ip}`,
    message: 'Too many password reset attempts. Please try again later.',
});

// Token guessing is already hopeless against 32 random bytes; this just stops a
// bot from grinding the endpoint.
const verifyEmailLimiter = createRateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    keyGenerator: (req) => `verify-email:${req.ip}`,
    message: 'Too many confirmation attempts. Please try again later.',
});

// Keyed on the user, not the IP: this route is authenticated and only ever mails
// the caller's own address, so the thing worth limiting is one account asking for
// link after link.
const resendVerificationLimiter = createRateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    keyGenerator: (req) => `resend-verify:${req.user?.id || req.ip}`,
    message: 'Too many confirmation emails requested. Please try again later.',
});

const exchangeLimiter = createRateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    keyGenerator: (req) => `exchange:${req.ip}`,
    message: 'Too many sign-in attempts. Please try again later.',
});

router.post('/register', registerLimiter, register);
router.post('/login', loginIpLimiter, loginEmailLimiter, login);
router.get('/me', protect, getMe);
router.put('/me', protect, updateProfile);
router.put('/change-password', protect, changePassword);
router.post('/forgot-password', forgotPasswordIpLimiter, forgotPasswordEmailLimiter, forgotPassword);
router.put('/reset-password/:token', resetPasswordLimiter, resetPassword);

// Email confirmation. `resendVerification` is keyed on req.user, so its limiter
// must sit AFTER `protect` — in front of it req.user does not exist yet and every
// caller would share the IP bucket.
router.put('/verify-email/:token', verifyEmailLimiter, verifyEmail);
router.post('/resend-verification', protect, resendVerificationLimiter, resendVerification);

// Exchange the one-time OAuth code for the JWT (see /auth-success on the frontend)
router.post('/exchange', exchangeLimiter, exchangeOAuthCode);

// FRONTEND_URL may hold a comma-separated allow-list (see index.js CORS setup);
// redirects always go to the first entry. Shared with the password-reset email
// builder in authController — see utils/frontendUrl.js.
const { frontendBaseUrl } = require('../utils/frontendUrl');

// Shared OAuth callback: mint the JWT, stash it behind a short-lived one-time
// code, and hand only the code to the browser. The token itself never appears
// in the URL, browser history, Referer headers or proxy logs.
const oauthCallback = (strategy) => (req, res, next) => {
    passport.authenticate(strategy, { session: false }, (err, user, info) => {
        if (err || !user) {
            const reason = err ? err.message : (info && info.message) || 'unknown';
            console.warn(`OAuth login failed (${strategy}):`, reason);
            return res.redirect(`${frontendBaseUrl()}/signin?error=oauth`);
        }

        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
            expiresIn: process.env.JWT_EXPIRES_IN || '7d',
        });

        const code = issueCode({
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                isVerified: user.isVerified,
            },
        });

        res.redirect(`${frontendBaseUrl()}/auth-success?code=${code}`);
    })(req, res, next);
};

// Google OAuth
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
router.get('/google/callback', oauthCallback('google'));

// Facebook OAuth
router.get('/facebook', passport.authenticate('facebook', { scope: ['email'] }));
router.get('/facebook/callback', oauthCallback('facebook'));

module.exports = router;


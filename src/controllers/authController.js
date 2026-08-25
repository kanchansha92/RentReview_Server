const User = require('../models/User');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const sendEmail = require('../utils/sendEmail');
const { consumeCode } = require('../utils/oauthCodes');
const { frontendBaseUrl } = require('../utils/frontendUrl');

// Generate JWT
const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    });
};

// ─── Email confirmation ──────────────────────────────────────────────────────
// `isVerified` gates exactly one thing: whether a Google/Facebook identity may be
// auto-linked to an existing account with the same address (config/passport.js).
// That guard is correct — without it anyone could pre-register a victim's address
// and inherit their Google identity — but nothing ever set the flag, so every
// password account was permanently barred from social sign-in with no way out.
//
// Deliberately NOT a gate on signing in. Verification unlocks linking; it does
// not lock people out of the account they just created. That also means a mail
// outage must never fail the request that triggered the send.
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Mint a confirmation token, store only its hash, and email the link.
 * @returns {Promise<boolean>} whether the mail actually went out
 */
const issueVerificationEmail = async (user) => {
    // FRONTEND_URL is a comma-separated allow-list, so the link must come from
    // frontendBaseUrl() — interpolating it raw yields every origin joined by
    // commas, which is an unusable link the API still reports as sent.
    const baseUrl = frontendBaseUrl();
    if (!baseUrl) {
        console.error('FRONTEND_URL is not set — verification links cannot be built.');
        return false;
    }

    const token = crypto.randomBytes(32).toString('hex');
    user.emailVerifyToken = crypto.createHash('sha256').update(token).digest('hex');
    user.emailVerifyExpire = Date.now() + EMAIL_VERIFY_TTL_MS;
    await user.save({ validateBeforeSave: false });

    const verifyUrl = `${baseUrl}/verify-email/${token}`;
    const html = `
        <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:32px;border:1px solid #e5e7eb;border-radius:12px">
            <h2 style="color:#41B985;margin-bottom:8px">Confirm Your Email</h2>
            <p style="color:#374151">Welcome to <strong>RentReview</strong>. Confirming your address lets you sign in with Google or Facebook as well as your password.</p>
            <p style="color:#374151">This link expires in <strong>24 hours</strong>.</p>
            <a href="${verifyUrl}" style="display:inline-block;margin:20px 0;padding:12px 28px;background:#41B985;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Confirm Email</a>
            <p style="color:#6b7280;font-size:13px">You can keep using your account either way — this only unlocks social sign-in.</p>
            <p style="color:#6b7280;font-size:13px">If you didn't create a RentReview account, you can safely ignore this email.</p>
            <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
            <p style="color:#9ca3af;font-size:12px">© ${new Date().getFullYear()} RentReview</p>
        </div>
    `;

    try {
        await sendEmail({ to: user.email, subject: 'RentReview — Confirm your email', html });
        return true;
    } catch (err) {
        // Don't leave a live token behind for a mail that never arrived.
        console.error('Verification email send error:', err.message);
        user.emailVerifyToken = undefined;
        user.emailVerifyExpire = undefined;
        await user.save({ validateBeforeSave: false });
        return false;
    }
};

// @desc    Register a new user (Signup)
// @route   POST /api/auth/register
// @access  Public
const register = async (req, res) => {
    try {
        const { name, email, password } = req.body;

        // --- Input validation ---
        if (typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ message: 'Full name is required.' });
        }
        if (typeof email !== 'string' || !email.trim()) {
            return res.status(400).json({ message: 'Email address is required.' });
        }
        const emailRegex = /^\S+@\S+\.\S+$/;
        if (!emailRegex.test(email.trim())) {
            return res.status(400).json({ message: 'Please enter a valid email address.' });
        }
        if (typeof password !== 'string' || password.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters.' });
        }

        // --- Check for existing user ---
        const existingUser = await User.findOne({ email: email.trim().toLowerCase() });
        if (existingUser) {
            return res.status(409).json({ message: 'An account with this email already exists.' });
        }

        // --- Create user ---
        const user = await User.create({
            name: name.trim(),
            email: email.trim().toLowerCase(),
            password,
        });

        // Fire-and-forget. A mail outage must not fail a signup that otherwise
        // succeeded — the account works regardless, and the user can resend from
        // their profile.
        issueVerificationEmail(user).catch((err) =>
            console.error('Verification email error:', err.message)
        );

        res.status(201).json({
            success: true,
            message: 'Account created successfully!',
            token: generateToken(user._id),
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                isVerified: user.isVerified,
            },
        });
    } catch (error) {
        // Concurrent registrations race past the findOne check and collide on
        // the unique email index — that's a 409, not a server error.
        if (error && error.code === 11000) {
            return res.status(409).json({ message: 'An account with this email already exists.' });
        }
        console.error('Register error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

// @desc    Login user (Signin)
// @route   POST /api/auth/login
// @access  Public
const login = async (req, res) => {
    try {
        const { email, password } = req.body;

        // --- Input validation ---
        if (typeof email !== 'string' || !email.trim()) {
            return res.status(400).json({ message: 'Email address is required.' });
        }
        if (typeof password !== 'string' || !password) {
            return res.status(400).json({ message: 'Password is required.' });
        }

        // --- Find user and verify password ---
        // `!user.password` covers social-only accounts: without it bcrypt.compare
        // throws, and the resulting 500 is an account-enumeration oracle.
        const user = await User.findOne({ email: email.trim().toLowerCase() }).select('+password');
        if (!user || !user.password || !(await user.matchPassword(password))) {
            return res.status(401).json({ message: 'Invalid email or password.' });
        }

        res.json({
            success: true,
            message: 'Logged in successfully!',
            token: generateToken(user._id),
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                // Included so the client can prompt for confirmation — an
                // unconfirmed address can't be used for Google/Facebook sign-in.
                isVerified: user.isVerified,
            },
        });
    } catch (error) {
        console.error('Login error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

// @desc    Get logged-in user profile
// @route   GET /api/auth/me
// @access  Private
const getMe = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }
        res.json({
            success: true,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                isVerified: user.isVerified,
                createdAt: user.createdAt,
            },
        });
    } catch (error) {
        console.error('GetMe error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

// @desc    Update user profile
// @route   PUT /api/auth/me
// @access  Private
const updateProfile = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        if (req.body.name !== undefined) {
            if (typeof req.body.name !== 'string' || !req.body.name.trim()) {
                return res.status(400).json({ message: 'Please provide a valid name.' });
            }
            user.name = req.body.name.trim();
        }

        if (req.body.email !== undefined) {
            if (typeof req.body.email !== 'string' || !req.body.email.trim()) {
                return res.status(400).json({ message: 'Please provide a valid email address.' });
            }
            const newEmail = req.body.email.trim().toLowerCase();
            if (newEmail !== user.email) {
                const emailExists = await User.findOne({ email: newEmail });
                if (emailExists) {
                    return res.status(400).json({ message: 'Email already in use.' });
                }
                user.email = newEmail;
                // The new address hasn't been proven to belong to this user, so
                // the account must not stay verified (and must not be auto-linkable
                // by OAuth) until it is re-verified.
                user.isVerified = false;
            }
        }

        // Password changes go through PUT /api/auth/change-password, which
        // requires the current password. Accepting one here was a full account
        // takeover for anyone holding a token.

        const emailChanged = user.isModified('email');
        const updatedUser = await user.save();

        // A new address starts unconfirmed (set above), so send a fresh link
        // straight away — otherwise changing your email would silently and
        // permanently cost you social sign-in.
        if (emailChanged) {
            issueVerificationEmail(updatedUser).catch((err) =>
                console.error('Verification email error:', err.message)
            );
        }

        res.json({
            success: true,
            user: {
                id: updatedUser._id,
                name: updatedUser.name,
                email: updatedUser.email,
                role: updatedUser.role,
                isVerified: updatedUser.isVerified,
            },
        });
    } catch (error) {
        // The findOne check above is not atomic: two requests claiming the same
        // address both pass it and the loser collides with the unique index.
        // That is the same "email already in use" the check reports, so it must
        // get the same answer — not a server error. `register` already handles
        // this case; updateProfile did not.
        if (error && error.code === 11000) {
            return res.status(400).json({ message: 'Email already in use.' });
        }
        console.error('UpdateProfile error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

// @desc    Change password
// @route   PUT /api/auth/change-password
// @access  Private
const changePassword = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || !currentPassword || !newPassword) {
            return res.status(400).json({ message: 'Please provide current and new passwords.' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters.' });
        }

        const user = await User.findById(req.user.id).select('+password');
        if (!user) return res.status(404).json({ message: 'User not found.' });

        // Social-only accounts have no password to compare against. This path is
        // already authenticated, so saying so leaks nothing.
        if (!user.password) {
            return res.status(400).json({
                message: 'This account uses social sign-in and has no password. Please sign in with Google or Facebook.',
            });
        }

        // Check current password
        const isMatch = await user.matchPassword(currentPassword);
        if (!isMatch) {
            return res.status(401).json({ message: 'Current password is incorrect.' });
        }

        // Set new password
        user.password = newPassword;
        await user.save();

        // The pre-save hook stamps `passwordChangedAt`, and `protect` rejects any
        // token issued before it — including the one this very request arrived
        // with. Without a fresh token the user is silently signed out of their own
        // session the instant they change their password. Rotate it instead: every
        // OTHER device is logged out (the point of the change), this one is not.
        res.json({
            success: true,
            message: 'Password updated successfully!',
            token: generateToken(user._id),
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                isVerified: user.isVerified,
            },
        });
    } catch (error) {
        console.error('Change password error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

// @desc    Forgot password — send reset email
// @route   POST /api/auth/forgot-password
// @access  Public
const forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        if (typeof email !== 'string' || !email.trim()) {
            return res.status(400).json({ message: 'Email is required.' });
        }

        const user = await User.findOne({ email: email.trim().toLowerCase() });
        // Always respond 200 to prevent email enumeration
        if (!user) {
            return res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
        }

        // Generate token
        const resetToken = crypto.randomBytes(32).toString('hex');
        user.resetPasswordToken = crypto.createHash('sha256').update(resetToken).digest('hex');
        user.resetPasswordExpire = Date.now() + 15 * 60 * 1000; // 15 minutes
        await user.save({ validateBeforeSave: false });

        // Must go through frontendBaseUrl(): FRONTEND_URL is a comma-separated
        // allow-list, so interpolating it raw builds a link containing every
        // origin joined by commas — unusable, while the API still answers 200.
        const baseUrl = frontendBaseUrl();
        if (!baseUrl) {
            // Nothing the user can do about this, and telling them would leak
            // that the account exists. Fail loudly in the logs instead and give
            // the same generic 200 as every other branch.
            console.error('FRONTEND_URL is not set — password reset links cannot be built.');
            user.resetPasswordToken = undefined;
            user.resetPasswordExpire = undefined;
            await user.save({ validateBeforeSave: false });
            return res.json({
                success: true,
                message: 'If an account exists for that email, a reset link has been sent.',
            });
        }

        const resetUrl = `${baseUrl}/reset-password/${resetToken}`;

        const html = `
            <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:32px;border:1px solid #e5e7eb;border-radius:12px">
                <h2 style="color:#41B985;margin-bottom:8px">Reset Your Password</h2>
                <p style="color:#374151">You requested a password reset for your <strong>RentReview</strong> account.</p>
                <p style="color:#374151">Click the button below to set a new password. This link expires in <strong>15 minutes</strong>.</p>
                <a href="${resetUrl}" style="display:inline-block;margin:20px 0;padding:12px 28px;background:#41B985;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Reset Password</a>
                <p style="color:#6b7280;font-size:13px">If you didn't request this, you can safely ignore this email.</p>
                <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
                <p style="color:#9ca3af;font-size:12px">© ${new Date().getFullYear()} RentReview</p>
            </div>
        `;

        try {
            await sendEmail({ to: user.email, subject: 'RentReview — Password Reset', html });
            res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
        } catch (emailErr) {
            user.resetPasswordToken = undefined;
            user.resetPasswordExpire = undefined;
            await user.save({ validateBeforeSave: false });
            // Log server-side, but return the SAME generic 200 as the unknown-email
            // branch — a 500 here identifies every registered address.
            console.error('Email send error:', emailErr.message);
            res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
        }
    } catch (error) {
        console.error('ForgotPassword error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

// @desc    Reset password using token
// @route   PUT /api/auth/reset-password/:token
// @access  Public
const resetPassword = async (req, res) => {
    try {
        const { password } = req.body;
        if (typeof password !== 'string' || password.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters.' });
        }

        const token = req.params.token;
        if (typeof token !== 'string' || !token.trim()) {
            return res.status(400).json({ message: 'Reset link is invalid or has expired.' });
        }

        const hashedToken = crypto.createHash('sha256').update(token.trim()).digest('hex');
        const user = await User.findOne({
            resetPasswordToken: hashedToken,
            resetPasswordExpire: { $gt: Date.now() },
        });

        if (!user) {
            return res.status(400).json({ message: 'Reset link is invalid or has expired.' });
        }

        user.password = password;
        user.resetPasswordToken = undefined;
        user.resetPasswordExpire = undefined;
        await user.save();

        res.json({ success: true, message: 'Password reset successfully! You can now sign in.' });
    } catch (error) {
        console.error('ResetPassword error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

// @desc    Confirm an email address using the token from the link
// @route   PUT /api/auth/verify-email/:token
// @access  Public
const verifyEmail = async (req, res) => {
    try {
        const token = req.params.token;
        if (typeof token !== 'string' || !token.trim()) {
            return res.status(400).json({ message: 'That confirmation link is invalid or has expired.' });
        }

        const hashedToken = crypto.createHash('sha256').update(token.trim()).digest('hex');
        const user = await User.findOne({
            emailVerifyToken: hashedToken,
            emailVerifyExpire: { $gt: Date.now() },
        }).select('+emailVerifyToken +emailVerifyExpire');

        if (!user) {
            // Covers unknown, already-used and expired tokens alike — telling them
            // apart would say whether an address is registered.
            return res.status(400).json({ message: 'That confirmation link is invalid or has expired.' });
        }

        user.isVerified = true;
        user.emailVerifyToken = undefined;
        user.emailVerifyExpire = undefined;
        // validateBeforeSave:false — accounts created before the current field
        // rules must not be blocked from confirming by a field they never touched.
        await user.save({ validateBeforeSave: false });

        res.json({
            success: true,
            message: 'Email confirmed. You can now sign in with Google or Facebook as well as your password.',
        });
    } catch (error) {
        console.error('VerifyEmail error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

// @desc    Resend the confirmation email to the signed-in user
// @route   POST /api/auth/resend-verification
// @access  Private
const resendVerification = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: 'User not found.' });

        if (user.isVerified) {
            return res.json({
                success: true,
                alreadyVerified: true,
                message: 'Your email is already confirmed.',
            });
        }

        // This route is authenticated and only ever mails the caller's own
        // address, so unlike forgot-password there is nothing to leak by being
        // specific about what happened.
        const sent = await issueVerificationEmail(user);
        if (!sent) {
            return res.status(503).json({
                message: "We couldn't send the confirmation email just now. Please try again shortly.",
            });
        }

        res.json({ success: true, message: `Confirmation link sent to ${user.email}.` });
    } catch (error) {
        console.error('ResendVerification error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

// @desc    Exchange a one-time OAuth code for a JWT
// @route   POST /api/auth/exchange
// @access  Public
const exchangeOAuthCode = async (req, res) => {
    try {
        const { code } = req.body;
        const payload = typeof code === 'string' ? consumeCode(code) : null;

        if (!payload) {
            return res.status(400).json({ success: false, message: 'Invalid or expired sign-in code.' });
        }

        res.json({
            success: true,
            token: payload.token,
            user: payload.user,
        });
    } catch (error) {
        console.error('OAuth exchange error:', error.message);
        res.status(400).json({ success: false, message: 'Invalid or expired sign-in code.' });
    }
};

module.exports = {
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
};

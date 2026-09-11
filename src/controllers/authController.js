const User = require('../models/User');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const sendEmail = require('../utils/sendEmail');
const { consumeCode } = require('../utils/oauthCodes');
const { applySeededAdmin } = require('../utils/seededAdmins');
const { frontendBaseUrl } = require('../utils/frontendUrl');
const { validatePassword } = require('../utils/passwordPolicy');
const { exportUserData, deleteUserAccount } = require('../utils/accountData');
const { issueSession, clearSession, issueCsrfToken } = require('../utils/sessionCookie');
const {
    notifyPasswordChanged,
    notifyEmailChangeRequested,
    notifyAccountLocked,
} = require('../utils/securityNotice');
const { recordAudit } = require('../models/AuditLog');
const { readCookie } = require('../utils/cookies');
const { isAllowedOrigin } = require('../utils/allowedOrigins');
const { CSRF_COOKIE } = require('../utils/sessionCookie');
const { maskEmail } = require('../utils/redact');
const bcrypt = require('bcryptjs');

// A bcrypt hash of a throwaway value, computed once at boot. `login` compares
// against it when the email is unknown so that a miss costs the same ~100ms as
// a hit  without this, response time alone tells an attacker which addresses
// are registered.
const DUMMY_HASH_PROMISE = bcrypt.hash(`dummy-${Date.now()}`, 10);

// Generate JWT
const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    });
};

const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;


const MAX_FAILED_LOGINS = 8;
const LOCK_DURATION_MS = 15 * 60 * 1000;

// An email change is parked until the NEW address confirms it.
const EMAIL_CHANGE_TTL_MS = 60 * 60 * 1000;

/**
 * Mint a confirmation token, store only its hash, and email the link.
 * @returns {Promise<boolean>} whether the mail actually went out
 */
const issueVerificationEmail = async (user) => {
    // FRONTEND_URL is a comma-separated allow-list, so the link must come from
    // frontendBaseUrl()  interpolating it raw yields every origin joined by
    // commas, which is an unusable link the API still reports as sent.
    const baseUrl = frontendBaseUrl();
    if (!baseUrl) {
        console.error('FRONTEND_URL is not set  verification links cannot be built.');
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
            <p style="color:#6b7280;font-size:13px">You can keep using your account either way  this only unlocks social sign-in.</p>
            <p style="color:#6b7280;font-size:13px">If you didn't create a RentReview account, you can safely ignore this email.</p>
            <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
            <p style="color:#9ca3af;font-size:12px">© ${new Date().getFullYear()} RentReview</p>
        </div>
    `;

    try {
        await sendEmail({ to: user.email, subject: 'RentReview  Confirm your email', html });
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
        const passwordError = validatePassword(password, { email, name });
        if (passwordError) {
            return res.status(400).json({ message: passwordError });
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
        // succeeded  the account works regardless, and the user can resend from
        // their profile.
        issueVerificationEmail(user).catch((err) =>
            console.error('Verification email error:', err.message)
        );

        // The JWT goes into an HttpOnly cookie, never into the response body.
        // The CSRF token DOES come back in the body  the page cannot read that
        // cookie when the site and API are on different domains, and it is not
        // a credential on its own. See utils/sessionCookie.js.
        const csrfToken = issueSession(res, generateToken(user._id));

        res.status(201).json({
            success: true,
            csrfToken,
            message: 'Account created successfully!',
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                isVerified: user.isVerified,
                hasPassword: true,
            },
        });
    } catch (error) {
        // Concurrent registrations race past the findOne check and collide on
        // the unique email index  that's a 409, not a server error.
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
        const user = await User.findOne({ email: email.trim().toLowerCase() })
            .select('+password +failedLoginAttempts +lockUntil');

        if (!user || !user.password) {
            // Burn the same bcrypt cost as a real comparison  see DUMMY_HASH_PROMISE.
            await bcrypt.compare(password, await DUMMY_HASH_PROMISE);
            return res.status(401).json({ message: 'Invalid email or password.' });
        }

        // Locked: do not even check the password, and do not say why (see the
        // note on MAX_FAILED_LOGINS). Still burn the bcrypt cost so a locked
        // account is not detectable by how fast it answers.
        if (user.isLocked()) {
            await bcrypt.compare(password, await DUMMY_HASH_PROMISE);
            return res.status(401).json({ message: 'Invalid email or password.' });
        }

        if (!(await user.matchPassword(password))) {
            // $inc, not read-then-write: N simultaneous guesses would otherwise
            // all read the same count and all write the same number, so a
            // parallel run got far more than MAX_FAILED_LOGINS attempts before
            // the lock ever landed. Mongo increments atomically.
            const after = await User.findOneAndUpdate(
                { _id: user._id },
                { $inc: { failedLoginAttempts: 1 } },
                { new: true, projection: { failedLoginAttempts: 1 } }
            );

            const attempts = after ? after.failedLoginAttempts : 0;
            let justLocked = false;

            if (attempts >= MAX_FAILED_LOGINS) {
                // Only the request that crosses the threshold locks and resets,
                // so exactly one notification goes out per lockout.
                const locked = await User.findOneAndUpdate(
                    { _id: user._id, failedLoginAttempts: { $gte: MAX_FAILED_LOGINS } },
                    { $set: { lockUntil: new Date(Date.now() + LOCK_DURATION_MS), failedLoginAttempts: 0 } },
                    { new: false }
                );
                justLocked = Boolean(locked);
            }

            if (justLocked) {
                console.warn(`[auth] sign-in locked for ${maskEmail(user.email)} (${user._id}) after ${MAX_FAILED_LOGINS} failures`);
                notifyAccountLocked(user, Math.round(LOCK_DURATION_MS / 60000)).catch(() => {});
                recordAudit({
                    action: 'account.locked',
                    targetType: 'User',
                    targetId: user._id,
                    meta: { attempts: MAX_FAILED_LOGINS },
                    ip: req.ip,
                });
            }

            return res.status(401).json({ message: 'Invalid email or password.' });
        }

        // Success wipes the counter  the threshold is for consecutive failures.
        if (user.failedLoginAttempts || user.lockUntil) {
            await User.updateOne(
                { _id: user._id },
                { $set: { failedLoginAttempts: 0 }, $unset: { lockUntil: 1 } }
            );
        }

        // Only AFTER the password check  a configured address earns the role,
        // it never stands in for proving who you are. Applied here as well as
        // in `protect` so the sign-in response already carries role: 'admin',
        // and the client's cached user isn't a step behind the server.
        await applySeededAdmin(user);

        const csrfToken = issueSession(res, generateToken(user._id));

        res.json({
            success: true,
            csrfToken,
            message: 'Logged in successfully!',
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                // Included so the client can prompt for confirmation  an
                // unconfirmed address can't be used for Google/Facebook sign-in.
                isVerified: user.isVerified,
                hasPassword: true,
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
        // +password only to report whether one exists  the hash never leaves.
        const user = await User.findById(req.user.id).select('+password');
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
                // Lets the client know whether to ask for a password on
                // account deletion (social-only accounts have none).
                hasPassword: Boolean(user.password),
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
        // +password so we can tell a password account from a social-only one,
        // and verify the current password when the email is changing.
        const user = await User.findById(req.user.id).select('+password');
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        if (req.body.name !== undefined) {
            if (typeof req.body.name !== 'string' || !req.body.name.trim()) {
                return res.status(400).json({ message: 'Please provide a valid name.' });
            }
            user.name = req.body.name.trim();
        }

        
        let emailChangeRequested = false;
        let pendingAddress = '';

        if (req.body.email !== undefined) {
            if (typeof req.body.email !== 'string' || !req.body.email.trim()) {
                return res.status(400).json({ message: 'Please provide a valid email address.' });
            }
            const newEmail = req.body.email.trim().toLowerCase();

            if (newEmail !== user.email) {
                if (!/^\S+@\S+\.\S+$/.test(newEmail)) {
                    return res.status(400).json({ message: 'Please enter a valid email address.' });
                }

                if (!user.password) {
                    // A social-only account has no password to prove ownership
                    // with, so there is nothing here an attacker holding the
                    // session would have to know. Refuse, and point at the one
                    // flow that gives the account a password.
                    return res.status(400).json({
                        message:
                            'Your account signs in with Google or Facebook. Set a password first ' +
                            '(use "Forgot password" on the sign-in page), then you can change your email.',
                    });
                }

                const { currentPassword } = req.body;
                if (typeof currentPassword !== 'string' || !currentPassword) {
                    return res.status(400).json({
                        message: 'Please enter your current password to change your email address.',
                    });
                }
                if (!(await user.matchPassword(currentPassword))) {
                    return res.status(401).json({ message: 'Current password is incorrect.' });
                }

                const emailExists = await User.findOne({ email: newEmail });
                if (emailExists) {
                    return res.status(400).json({ message: 'Email already in use.' });
                }

                const token = crypto.randomBytes(32).toString('hex');
                user.pendingEmail = newEmail;
                user.pendingEmailToken = crypto.createHash('sha256').update(token).digest('hex');
                user.pendingEmailExpire = Date.now() + EMAIL_CHANGE_TTL_MS;
                emailChangeRequested = true;
                pendingAddress = newEmail;

                // Sent AFTER the save below, so nothing goes out for a change
                // that failed to persist.
                req._pendingEmailToken = token;
            }
        }

        const updatedUser = await user.save({ validateModifiedOnly: true });

        if (emailChangeRequested) {
            // To the NEW address: the link that actually applies the change.
            issueEmailChangeConfirmation(updatedUser, req._pendingEmailToken, pendingAddress).catch((err) =>
                console.error('Email change confirmation error:', err.message)
            );
            // To the OLD address: notice that someone asked.
            notifyEmailChangeRequested(updatedUser, pendingAddress).catch(() => {});
        }

        res.json({
            success: true,
            emailChangePending: emailChangeRequested,
            message: emailChangeRequested
                ? `Check ${pendingAddress} for a link to confirm your new email address. Your current address stays active until you do.`
                : 'Profile updated.',
            user: {
                id: updatedUser._id,
                name: updatedUser.name,
                email: updatedUser.email,
                role: updatedUser.role,
                isVerified: updatedUser.isVerified,
                hasPassword: Boolean(updatedUser.password),
            },
        });
    } catch (error) {
        if (error && error.code === 11000) {
            return res.status(400).json({ message: 'Email already in use.' });
        }
        console.error('UpdateProfile error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

/**
 * Mail the confirmation link for a pending email change to the NEW address.
 * Proving the address receives mail is the point  the change does not land
 * until this link is opened.
 */
const issueEmailChangeConfirmation = async (user, token, newEmail) => {
    const baseUrl = frontendBaseUrl();
    if (!baseUrl) {
        console.error('FRONTEND_URL is not set  email-change links cannot be built.');
        return false;
    }

    const url = `${baseUrl}/confirm-email-change/${token}`;
    const html = `
        <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:32px;border:1px solid #e5e7eb;border-radius:12px">
            <h2 style="color:#41B985;margin-bottom:8px">Confirm your new email address</h2>
            <p style="color:#374151">You asked to move your <strong>RentReview</strong> account to this address.
            Confirm below and it becomes the address you sign in with.</p>
            <p style="color:#374151">This link expires in <strong>1 hour</strong>.</p>
            <a href="${url}" style="display:inline-block;margin:20px 0;padding:12px 28px;background:#41B985;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Confirm new address</a>
            <p style="color:#6b7280;font-size:13px">If you didn't ask for this, ignore this email  nothing changes
            until the link is opened.</p>
            <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
            <p style="color:#9ca3af;font-size:12px">© ${new Date().getFullYear()} RentReview</p>
        </div>
    `;

    try {
        await sendEmail({ to: newEmail, subject: 'RentReview  Confirm your new email address', html });
        return true;
    } catch (err) {
        console.error('Email change send error:', err.message);
        return false;
    }
};

// @desc    Apply a pending email change using the token from the link
// @route   PUT /api/auth/confirm-email-change/:token
// @access  Public (the token is the authorisation)
const confirmEmailChange = async (req, res) => {
    try {
        const token = req.params.token;
        if (typeof token !== 'string' || !token.trim()) {
            return res.status(400).json({ message: 'That link is invalid or has expired.' });
        }

        const hashedToken = crypto.createHash('sha256').update(token.trim()).digest('hex');
        const user = await User.findOne({
            pendingEmailToken: hashedToken,
            pendingEmailExpire: { $gt: Date.now() },
        }).select('+pendingEmail +pendingEmailToken +pendingEmailExpire');

        if (!user || !user.pendingEmail) {
            return res.status(400).json({ message: 'That link is invalid or has expired.' });
        }

        // Someone may have claimed the address in the meantime.
        const taken = await User.findOne({ email: user.pendingEmail });
        if (taken && String(taken._id) !== String(user._id)) {
            user.pendingEmail = undefined;
            user.pendingEmailToken = undefined;
            user.pendingEmailExpire = undefined;
            await user.save({ validateBeforeSave: false });
            return res.status(400).json({ message: 'That email address is already in use.' });
        }

        user.email = user.pendingEmail;
        // The address proved it receives mail by opening this link, so it is
        // verified by construction  which also keeps social sign-in linkable.
        user.isVerified = true;
        user.pendingEmail = undefined;
        user.pendingEmailToken = undefined;
        user.pendingEmailExpire = undefined;
        // The identity this account signs in with just changed, so every token
        // issued against the old one must stop working  including any an
        // attacker holds. `protect` rejects tokens older than this stamp.
        user.passwordChangedAt = new Date();
        await user.save({ validateBeforeSave: false });

        // Whoever opened this link is now signed out too; they sign in with the
        // new address. Anything less would leave the pre-change session alive.
        clearSession(res);

        res.json({ success: true, message: 'Email address updated. Please sign in again.' });
    } catch (error) {
        if (error && error.code === 11000) {
            return res.status(400).json({ message: 'That email address is already in use.' });
        }
        console.error('ConfirmEmailChange error:', error.message);
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

        const user = await User.findById(req.user.id).select('+password');
        if (!user) return res.status(404).json({ message: 'User not found.' });

        const passwordError = validatePassword(newPassword, { email: user.email, name: user.name });
        if (passwordError) {
            return res.status(400).json({ message: passwordError });
        }
        if (newPassword === currentPassword) {
            return res.status(400).json({ message: 'New password must be different from the current one.' });
        }

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
        // token issued before it  including the one this very request arrived
        // with. Without a fresh token the user is silently signed out of their own
        // session the instant they change their password. Rotate the cookie
        // instead: every OTHER device is logged out (the point of the change),
        // this one is not.
        const csrfToken = issueSession(res, generateToken(user._id));

        // Best-effort, and after the change: the one notice that makes a
        // takeover recoverable rather than final.
        notifyPasswordChanged(user).catch(() => {});

        res.json({
            success: true,
            csrfToken,
            message: 'Password updated successfully!',
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                isVerified: user.isVerified,
                hasPassword: true,
            },
        });
    } catch (error) {
        console.error('Change password error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

// @desc    Forgot password  send reset email
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
        // origin joined by commas  unusable, while the API still answers 200.
        const baseUrl = frontendBaseUrl();
        if (!baseUrl) {
            // Nothing the user can do about this, and telling them would leak
            // that the account exists. Fail loudly in the logs instead and give
            // the same generic 200 as every other branch.
            console.error('FRONTEND_URL is not set  password reset links cannot be built.');
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
            await sendEmail({ to: user.email, subject: 'RentReview  Password Reset', html });
            res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
        } catch (emailErr) {
            user.resetPasswordToken = undefined;
            user.resetPasswordExpire = undefined;
            await user.save({ validateBeforeSave: false });
            // Log server-side, but return the SAME generic 200 as the unknown-email
            // branch  a 500 here identifies every registered address.
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
        // Cheap shape check first; the identity-aware policy runs once the
        // token has resolved to a user (below), so an invalid token never
        // reveals anything about the account.
        if (typeof password !== 'string' || !password) {
            return res.status(400).json({ message: 'Password is required.' });
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

        const passwordError = validatePassword(password, { email: user.email, name: user.name });
        if (passwordError) {
            return res.status(400).json({ message: passwordError });
        }

        user.password = password;
        user.resetPasswordToken = undefined;
        user.resetPasswordExpire = undefined;
        // A completed reset clears any lockout  the person proved control of
        // the mailbox, which is a stronger signal than the failed guesses were.
        user.failedLoginAttempts = 0;
        user.lockUntil = undefined;
        await user.save();

        notifyPasswordChanged(user).catch(() => {});

        // `passwordChangedAt` has just invalidated every existing token,
        // including any cookie in THIS browser. Clear it here so the next page
        // load is cleanly signed out rather than discovering it via a 401.
        clearSession(res);

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
            // Covers unknown, already-used and expired tokens alike  telling them
            // apart would say whether an address is registered.
            return res.status(400).json({ message: 'That confirmation link is invalid or has expired.' });
        }

        user.isVerified = true;
        user.emailVerifyToken = undefined;
        user.emailVerifyExpire = undefined;
        // validateBeforeSave:false  accounts created before the current field
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

        // Same as password sign-in: the JWT becomes an HttpOnly cookie and
        // never reaches page script.
        const csrfToken = issueSession(res, payload.token);

        res.json({
            success: true,
            csrfToken,
            user: payload.user,
        });
    } catch (error) {
        console.error('OAuth exchange error:', error.message);
        res.status(400).json({ success: false, message: 'Invalid or expired sign-in code.' });
    }
};


const getCsrfToken = (req, res) => {
    const existing = readCookie(req, CSRF_COOKIE);
    const csrfToken = existing || issueCsrfToken(res);
    res.json({ success: true, csrfToken });
};


const logout = (req, res) => {
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) {
        return res.status(403).json({ message: 'Request origin not allowed.' });
    }
    clearSession(res);
    res.json({ success: true, message: 'Signed out.' });
};

// @desc    Download everything we hold about the signed-in user
// @route   GET /api/auth/me/export
// @access  Private
const exportMyData = async (req, res) => {
    try {
        const data = await exportUserData(req.user.id);
        if (!data) return res.status(404).json({ message: 'User not found.' });

        res.setHeader('Content-Disposition', `attachment; filename="rentreview-data-${req.user.id}.json"`);
        res.setHeader('Cache-Control', 'no-store');
        res.json(data);
    } catch (error) {
        console.error('Export data error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};


const deleteMyAccount = async (req, res) => {
    try {
        const { password, confirmation } = req.body || {};

        const user = await User.findById(req.user.id).select('+password');
        if (!user) return res.status(404).json({ message: 'User not found.' });

        if (user.password) {
            if (typeof password !== 'string' || !password) {
                return res.status(400).json({ message: 'Please enter your password to confirm.' });
            }
            if (!(await user.matchPassword(password))) {
                return res.status(401).json({ message: 'Password is incorrect.' });
            }
        } else if (confirmation !== 'DELETE') {
            return res.status(400).json({ message: 'Type DELETE to confirm.' });
        }

        const userId = user._id;
        const { reviewsDeleted, assetsFailed } = await deleteUserAccount(userId);

        // Ids only  the address itself is gone with the account.
        console.log(
            `[account-delete] user ${userId} erased (${reviewsDeleted} review(s), ${assetsFailed} asset failure(s))`
        );
        recordAudit({
            actor: userId,
            action: 'account.deleted',
            targetType: 'User',
            targetId: userId,
            meta: { reviewsDeleted, assetsFailed },
            ip: req.ip,
        });

        // The account is gone; the cookie pointing at it must go too.
        clearSession(res);

        res.json({ success: true, message: 'Your account and all your reviews have been deleted.' });
    } catch (error) {
        console.error('Delete account error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

module.exports = {
    logout,
    getCsrfToken,
    confirmEmailChange,
    exportMyData,
    deleteMyAccount,
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

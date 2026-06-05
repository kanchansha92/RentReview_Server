const User = require('../models/User');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const sendEmail = require('../utils/sendEmail');

// Generate JWT
const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    });
};

// @desc    Register a new user (Signup)
// @route   POST /api/auth/register
// @access  Public
// const register = async (req, res) => {
//     try {
//         const { name, email, password, role } = req.body;

//         // --- Input validation ---
//         if (!name || !name.trim()) {
//             return res.status(400).json({ message: 'Full name is required.' });
//         }
//         if (!email || !email.trim()) {
//             return res.status(400).json({ message: 'Email address is required.' });
//         }
//         const emailRegex = /^\S+@\S+\.\S+$/;
//         if (!emailRegex.test(email.trim())) {
//             return res.status(400).json({ message: 'Please enter a valid email address.' });
//         }
//         if (!password || password.length < 6) {
//             return res.status(400).json({ message: 'Password must be at least 6 characters.' });
//         }

//         // --- Check for existing user ---
//         const existingUser = await User.findOne({ email: email.trim().toLowerCase() });
//         if (existingUser) {
//             return res.status(409).json({ message: 'An account with this email already exists.' });
//         }

//         // --- Create user ---
//         const user = await User.create({
//             name: name.trim(),
//             email: email.trim().toLowerCase(),
//             password,
//             role: role || 'tenant',
//         });

//         res.status(201).json({
//             success: true,
//             message: 'Account created successfully!',
//             token: generateToken(user._id),
//             user: {
//                 id: user._id,
//                 name: user.name,
//                 email: user.email,
//                 role: user.role,
//             },
//         });
//     } catch (error) {
//         console.error('Register error:', error.message);
//         res.status(500).json({ message: 'Server error. Please try again later.' });
//     }
// };



const register = async (req, res) => {
    try {
        const { name, email, password } = req.body;

        // --- Input validation ---
        if (!name || !name.trim()) {
            return res.status(400).json({ message: 'Full name is required.' });
        }
        if (!email || !email.trim()) {
            return res.status(400).json({ message: 'Email address is required.' });
        }
        const emailRegex = /^\S+@\S+\.\S+$/;
        if (!emailRegex.test(email.trim())) {
            return res.status(400).json({ message: 'Please enter a valid email address.' });
        }
        if (!password || password.length < 6) {
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

        res.status(201).json({
            success: true,
            message: 'Account created successfully!',
            token: generateToken(user._id),
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
            },
        });
    } catch (error) {
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
        if (!email || !email.trim()) {
            return res.status(400).json({ message: 'Email address is required.' });
        }
        if (!password) {
            return res.status(400).json({ message: 'Password is required.' });
        }

        // --- Find user and verify password ---
        const user = await User.findOne({ email: email.trim().toLowerCase() }).select('+password');
        if (!user || !(await user.matchPassword(password))) {
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

        user.name = req.body.name || user.name;
        if (req.body.email && req.body.email !== user.email) {
            const emailExists = await User.findOne({ email: req.body.email.trim().toLowerCase() });
            if (emailExists) {
                return res.status(400).json({ message: 'Email already in use.' });
            }
            user.email = req.body.email.trim().toLowerCase();
        }

        if (req.body.password) {
            user.password = req.body.password;
        }

        const updatedUser = await user.save();

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

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ message: 'Please provide current and new passwords.' });
        }

        const user = await User.findById(req.user.id).select('+password');
        if (!user) return res.status(404).json({ message: 'User not found.' });

        // Check current password
        const isMatch = await user.matchPassword(currentPassword);
        if (!isMatch) {
            return res.status(401).json({ message: 'Current password is incorrect.' });
        }

        // Set new password
        user.password = newPassword;
        await user.save();

        res.json({ success: true, message: 'Password updated successfully!' });
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
        if (!email) return res.status(400).json({ message: 'Email is required.' });

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

        const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;

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
            console.error('Email send error:', emailErr.message);
            res.status(500).json({ message: 'Failed to send reset email. Please try again later.' });
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
        if (!password || password.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters.' });
        }

        const hashedToken = crypto.createHash('sha256').update(req.params.token).digest('hex');
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

module.exports = { register, login, getMe, updateProfile, changePassword, forgotPassword, resetPassword };

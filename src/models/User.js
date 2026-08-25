const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Name is required'],
            trim: true,
        },
        email: {
            type: String,
            required: [true, 'Email is required'],
            unique: true,
            lowercase: true,
            trim: true,
        },
        password: {
            type: String,
            minlength: 6,
            select: false,
        },
        googleId: {
            type: String,
            unique: true,
            sparse: true,
        },
        facebookId: {
            type: String,
            unique: true,
            sparse: true,
        },
        role: {
            type: String,
            enum: ['tenant', 'landlord', 'admin'],
            default: 'tenant',
        },
        isVerified: {
            type: Boolean,
            default: false,
        },
        // Email confirmation. Same shape as the reset-password pair below: the
        // token in the link is random, only its SHA-256 hash is stored, and it
        // expires. `isVerified` gates whether a Google/Facebook identity may be
        // auto-linked to this account (see config/passport.js) — it does NOT gate
        // signing in.
        //
        // These replace the old `otp` / `otpExpiry` fields, which no endpoint ever
        // wrote: `isVerified` was unreachable for password accounts, so they were
        // permanently barred from social sign-in.
        emailVerifyToken: {
            type: String,
            select: false,
        },
        emailVerifyExpire: {
            type: Date,
            select: false,
        },
        resetPasswordToken: {
            type: String,
            select: false,
        },
        resetPasswordExpire: {
            type: Date,
            select: false,
        },
        passwordChangedAt: {
            type: Date,
        },
    },
    { timestamps: true }
);

// Hash password before saving
// userSchema.pre('save', async function (next) {
//     if (!this.isModified('password')) return next();
//     this.password = await bcrypt.hash(this.password, 10);
//     next();
// });
userSchema.pre('save', async function () {
    if (!this.isModified('password')) return;
    this.password = await bcrypt.hash(this.password, 10);
    // Stamp the change so any JWT issued before this moment is rejected by
    // `protect`. Backdated 1s so a token minted in the same tick as the save
    // (e.g. register) doesn't lose the race against its own `iat`.
    this.passwordChangedAt = new Date(Date.now() - 1000);
});

// Compare passwords
userSchema.methods.matchPassword = async function (enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);

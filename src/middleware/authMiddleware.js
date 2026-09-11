const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { applySeededAdmin } = require('../utils/seededAdmins');
const { readCookie } = require('../utils/cookies');
const { SESSION_COOKIE } = require('../utils/sessionCookie');
const { verifyCsrf } = require('./csrf');

const protect = async (req, res, next) => {
    try {
        // The HttpOnly session cookie is the ONLY credential this API accepts.
        //
        // The old `Authorization: Bearer` path is gone deliberately. Since the
        // cookie migration nothing hands a JWT to a client  the OAuth code is
        // redeemed server-side and the token goes straight into a cookie  so
        // no legitimate caller could hold one. All the branch still did was
        // offer a CSRF-exempt way in for a token obtained some other way. If a
        // non-browser client is ever needed, give it its own credential type
        // rather than re-opening this.
        const token = readCookie(req, SESSION_COOKIE);

        if (!token) {
            return res.status(401).json({ message: 'Not authorized, no token' });
        }

        // The browser attaches that cookie to requests our own page did not
        // make, so a state-changing request has to prove where it came from.
        // See middleware/csrf.js for why the check lives here and not globally.
        if (!verifyCsrf(req)) {
            return res.status(403).json({
                message: 'Your session could not be verified. Please refresh the page and try again.',
            });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
        req.user = await User.findById(decoded.id).select('-password');

        if (!req.user) {
            return res.status(401).json({ message: 'User not found' });
        }

        // Reject tokens issued before the password was last changed, so a
        // reset / change invalidates every session that existed beforehand.
        if (req.user.passwordChangedAt && decoded.iat) {
            const changedAtSeconds = Math.floor(req.user.passwordChangedAt.getTime() / 1000);
            if (changedAtSeconds > decoded.iat) {
                return res.status(401).json({ message: 'Password recently changed. Please sign in again.' });
            }
        }

        // Accounts listed in ADMIN_EMAILS hold the admin role by configuration.
        // This is the choke point every authenticated request passes through,
        // so putting it here means a newly configured admin is one request away
        // from the role  including OAuth sessions, which never touch `login`
        // below. Deliberately AFTER the token checks above: an expired or
        // superseded token must still be rejected, listed address or not.
        await applySeededAdmin(req.user);

        next();
    } catch (error) {
        res.status(401).json({ message: 'Not authorized, token failed' });
    }
};

const authorizeRoles = (...roles) => {
    return (req, res, next) => {
        // Defensive: never 500 if this is mounted without `protect` in front.
        if (!req.user) {
            return res.status(401).json({ message: 'Not authorized, no token' });
        }
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({
                message: `Role '${req.user.role}' is not authorized to access this route`,
            });
        }
        next();
    };
};

module.exports = { protect, authorizeRoles };

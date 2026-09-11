
const crypto = require('crypto');

const COOKIE_NAME = 'rr_oauth_state';
const MAX_AGE_MS = 10 * 60 * 1000; // plenty for a consent screen, useless to an attacker

const secret = () => {
    const s = process.env.JWT_SECRET;
    if (!s) throw new Error('JWT_SECRET is required to sign OAuth state.');
    return s;
};

const sign = (value) => crypto.createHmac('sha256', secret()).update(value).digest('base64url');

const readCookie = (req, name) => {
    const header = req.headers && req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        if (part.slice(0, idx).trim() === name) {
            try {
                return decodeURIComponent(part.slice(idx + 1).trim());
            } catch {
                return null;
            }
        }
    }
    return null;
};

const cookieOptions = () => ({
    httpOnly: true,
    sameSite: 'lax',
    // Scoped to the auth routes so it is never sent with API calls that do not
    // need it. Must be the same on set and clear.
    path: '/api/auth',
    secure: process.env.NODE_ENV === 'production',
});

class StatelessStateStore {
    store(req, callback) {
        try {
            const nonce = crypto.randomBytes(24).toString('base64url');
            const issuedAt = Date.now().toString(36);
            const body = `${nonce}.${issuedAt}`;
            const value = `${body}.${sign(body)}`;

            if (!req.res || typeof req.res.cookie !== 'function') {
                return callback(new Error('Response object unavailable; cannot set OAuth state cookie.'));
            }
            req.res.cookie(COOKIE_NAME, value, { ...cookieOptions(), maxAge: MAX_AGE_MS });
            callback(null, nonce);
        } catch (err) {
            callback(err);
        }
    }

    verify(req, providedState, callback) {
        try {
            const raw = readCookie(req, COOKIE_NAME);
            // One-shot: clear it whether or not verification succeeds.
            if (req.res && typeof req.res.clearCookie === 'function') {
                req.res.clearCookie(COOKIE_NAME, cookieOptions());
            }

            if (!raw || typeof providedState !== 'string' || !providedState) {
                return callback(null, false, { message: 'oauth-state-missing' });
            }

            const parts = raw.split('.');
            if (parts.length !== 3) return callback(null, false, { message: 'oauth-state-malformed' });
            const [nonce, issuedAt, sig] = parts;
            const body = `${nonce}.${issuedAt}`;

            const expected = sign(body);
            if (expected.length !== sig.length ||
                !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
                return callback(null, false, { message: 'oauth-state-bad-signature' });
            }

            const age = Date.now() - parseInt(issuedAt, 36);
            if (!Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) {
                return callback(null, false, { message: 'oauth-state-expired' });
            }

            if (nonce.length !== providedState.length ||
                !crypto.timingSafeEqual(Buffer.from(nonce), Buffer.from(providedState))) {
                return callback(null, false, { message: 'oauth-state-mismatch' });
            }

            callback(null, true);
        } catch (err) {
            callback(err);
        }
    }
}

module.exports = { StatelessStateStore, COOKIE_NAME };

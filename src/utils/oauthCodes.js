
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const TTL_MS = 2 * 60 * 1000;
const TTL_SECONDS = Math.floor(TTL_MS / 1000);
const PURPOSE = 'oauth-exchange';

// Redeemed JTIs, so a code works exactly once. Entries are dropped once they are
// older than the TTL — after that the token has expired on its own and the
// record is redundant.
const redeemed = new Map(); // jti -> expiry (ms)

const SWEEP_INTERVAL_MS = 60 * 1000;
const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [jti, expiresAt] of redeemed) {
        if (expiresAt <= now) redeemed.delete(jti);
    }
}, SWEEP_INTERVAL_MS);

// .unref() so this timer never keeps the process alive on its own.
if (typeof sweeper.unref === 'function') sweeper.unref();

/**
 * Issue a single-use code carrying a freshly-minted session token and the user
 * payload the client needs to render immediately.
 */
const issueCode = ({ token, user }) =>
    jwt.sign(
        { purpose: PURPOSE, jti: crypto.randomBytes(16).toString('hex'), token, user },
        process.env.JWT_SECRET,
        { expiresIn: TTL_SECONDS }
    );

/**
 * Redeem a code. Returns { token, user }, or null when the code is unknown,
 * malformed, expired, already used, or not an exchange code at all.
 */
const consumeCode = (code) => {
    if (typeof code !== 'string' || !code) return null;

    let payload;
    try {
        payload = jwt.verify(code, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
        // Expired, tampered with, or signed by something else.
        return null;
    }

    // Without this a normal session token would redeem here — and, more
    // importantly, an exchange code must never be usable as one.
    if (payload.purpose !== PURPOSE || !payload.jti || !payload.token || !payload.user) {
        return null;
    }

    if (redeemed.has(payload.jti)) return null;
    redeemed.set(payload.jti, Date.now() + TTL_MS);

    return { token: payload.token, user: payload.user };
};

module.exports = { issueCode, consumeCode, TTL_MS, PURPOSE };

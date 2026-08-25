// ─────────────────────────────────────────────────────────────────────────────
// One-time codes for the OAuth hand-off, so the session JWT never travels in a
// URL (where it would land in browser history, Referer headers and proxy logs).
//
// The code used to be a random string pointing at an in-process Map. That made
// the whole sign-in flow depend on hitting the SAME instance twice: the callback
// issued the code on one dyno and the browser redeemed it on whichever dyno the
// load balancer picked next. On a single instance it worked; on two it failed
// roughly half the time, with nothing in the logs to explain it. A restart
// between the redirect and the redemption broke it too.
//
// The code is now a short-lived signed token carrying the payload itself, so any
// instance can redeem one issued by any other, and nothing is lost on restart.
//
// Three things keep this from being a second session token:
//
//   • `purpose: 'oauth-exchange'` — checked on redemption, so an exchange code
//     cannot be presented to `protect` as a session token, and a session token
//     cannot be redeemed here.
//   • A 2-minute lifetime. The frontend redeems immediately on page load.
//   • Single use, enforced by remembering redeemed JTIs. That part IS in-process
//     (the only remaining per-instance state here), so on a multi-instance deploy
//     a stolen code could in principle be replayed once per instance inside the
//     2-minute window. Everything else about the flow is now instance-agnostic;
//     move this Set to Redis if that residual window ever matters.
// ─────────────────────────────────────────────────────────────────────────────

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

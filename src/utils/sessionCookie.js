// ─────────────────────────────────────────────────────────────────────────────
// Session cookies.
//
// The JWT used to be handed to the browser in the response body and kept in
// localStorage, where any injected script could read it — and it stayed valid
// for seven days with no way to revoke it. It now travels in an HttpOnly
// cookie that JavaScript cannot read at all.
//
// Two cookies are set together:
//
//   rr_session  HttpOnly — the JWT. Never readable by page scripts.
//   rr_csrf     readable — a random value the page echoes back in the
//               X-CSRF-Token header. Because a cookie is attached to
//               cross-site requests automatically, the header is what proves
//               the request came from our own page rather than from an
//               attacker's: another origin can send the cookie but cannot
//               read it, so it cannot produce a matching header.
//               (middleware/csrf.js does the comparing.)
//
// SameSite. When the site and the API are on the same registrable domain
// (rentreview.in and api.rentreview.in) `lax` is right and is its own CSRF
// defence. When they are not — a netlify.app frontend against an onrender.com
// API — the browser will not send a `lax` cookie at all, so the pair has to be
// `none` + `Secure`, and the CSRF header is then doing the real work. Default
// is therefore `none` in production and `lax` in development (where `Secure`
// would stop the cookie working over http://localhost). Override with
// SESSION_COOKIE_SAMESITE when both ends share a domain.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

const SESSION_COOKIE = 'rr_session';
const CSRF_COOKIE = 'rr_csrf';
const CSRF_HEADER = 'x-csrf-token';

const isProduction = () => process.env.NODE_ENV === 'production';

const sameSite = () => {
    const configured = String(process.env.SESSION_COOKIE_SAMESITE || '').trim().toLowerCase();
    if (configured === 'lax' || configured === 'strict' || configured === 'none') return configured;
    return isProduction() ? 'none' : 'lax';
};

// `SameSite=None` is only honoured on a Secure cookie — a browser drops the
// pair otherwise, which presents as "login silently does nothing".
const secure = () => sameSite() === 'none' || isProduction();

/**
 * How long the cookie lives. Kept in step with the JWT's own expiry so the
 * cookie never outlives the token it carries (a cookie that survives its token
 * just produces a confusing 401 on the next request).
 */
const maxAgeMs = () => {
    const raw = String(process.env.JWT_EXPIRES_IN || '7d').trim();
    const match = /^(\d+)\s*([smhd])?$/.exec(raw);
    if (!match) return 7 * 24 * 60 * 60 * 1000;
    const n = Number(match[1]);
    const unit = match[2] || 's';
    const factor = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
    return n * factor;
};

const baseOptions = () => ({
    sameSite: sameSite(),
    secure: secure(),
    path: '/',
});

/**
 * Set (or replace) the CSRF cookie and return its value.
 *
 * Deliberately NOT HttpOnly — but do not rely on the page reading it. When the
 * site and the API sit on different registrable domains, this cookie belongs to
 * the API's host and `document.cookie` on the site cannot see it at all; that
 * is why every endpoint that starts a session also RETURNS this value in its
 * JSON body, and why GET /api/auth/csrf exists. The cookie is the server's copy
 * for comparison; the body is how the page learns what to echo back.
 *
 * It is not a credential: on its own it authorises nothing without the session
 * cookie beside it.
 *
 * @returns {string} the new CSRF token
 */
const issueCsrfToken = (res) => {
    const value = crypto.randomBytes(24).toString('base64url');
    res.cookie(CSRF_COOKIE, value, { ...baseOptions(), httpOnly: false, maxAge: maxAgeMs() });
    return value;
};

/**
 * Start a session: set the HttpOnly token cookie and a fresh CSRF cookie.
 * @param {import('express').Response} res
 * @param {string} token a signed JWT
 * @returns {string} the CSRF token the client must echo in X-CSRF-Token
 */
const issueSession = (res, token) => {
    res.cookie(SESSION_COOKIE, token, { ...baseOptions(), httpOnly: true, maxAge: maxAgeMs() });
    return issueCsrfToken(res);
};

/** End a session. Attributes must match those used to set, or nothing clears. */
const clearSession = (res) => {
    const opts = baseOptions();
    res.clearCookie(SESSION_COOKIE, { ...opts, httpOnly: true });
    res.clearCookie(CSRF_COOKIE, { ...opts, httpOnly: false });
};

module.exports = {
    issueCsrfToken,
    SESSION_COOKIE,
    CSRF_COOKIE,
    CSRF_HEADER,
    issueSession,
    clearSession,
    sameSite,
};

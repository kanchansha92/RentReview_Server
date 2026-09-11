
const crypto = require('crypto');
const { readCookie } = require('../utils/cookies');
const { CSRF_COOKIE, CSRF_HEADER } = require('../utils/sessionCookie');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const timingSafeEqual = (a, b) => {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    // Compare lengths first: timingSafeEqual throws on a mismatch.
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
};

/**
 * Does this request clear the CSRF bar?
 * Only meaningful for a request that authenticated via cookie  the caller
 * decides that (see `protect`).
 *
 * @returns {boolean} true when the request is safe to process.
 */
const verifyCsrf = (req) => {
    if (SAFE_METHODS.has(req.method)) return true;

    const cookieToken = readCookie(req, CSRF_COOKIE);
    const headerToken = req.headers[CSRF_HEADER];

    if (!cookieToken || typeof headerToken !== 'string' || !headerToken) return false;
    return timingSafeEqual(cookieToken, headerToken);
};

module.exports = { verifyCsrf };

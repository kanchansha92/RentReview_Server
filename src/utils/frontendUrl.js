/**
 * FRONTEND_URL is a comma-separated allow-list (see the CORS setup in index.js)
 * so localhost dev and the deployed site can both be permitted at once.
 *
 * Anything that builds a link FOR A USER — an OAuth redirect, a password-reset
 * email — must use the first entry only, with trailing slashes stripped.
 * Interpolating the raw variable produces
 *   "http://localhost:5173,https://rentreview.app/reset-password/<token>"
 * which is an unusable link that the API still reports as sent successfully.
 */
const frontendBaseUrl = () =>
    (process.env.FRONTEND_URL || '')
        .split(',')[0]
        .trim()
        .replace(/\/+$/, '');

module.exports = { frontendBaseUrl };

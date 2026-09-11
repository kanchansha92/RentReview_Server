// Minimal cookie reading. Express 5 ships no cookie parser and this API needs
// exactly one thing from one  the value of a named cookie  so a dependency
// (and its own advisories) is not worth taking on.
//
// Shared by the session cookie, the CSRF check and the OAuth state store.

/**
 * @param {import('express').Request} req
 * @param {string} name
 * @returns {string|null} the decoded value, or null when absent/undecodable.
 */
const readCookie = (req, name) => {
    const header = req && req.headers && req.headers.cookie;
    if (!header) return null;

    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        if (part.slice(0, idx).trim() !== name) continue;
        try {
            return decodeURIComponent(part.slice(idx + 1).trim());
        } catch {
            // A malformed percent-escape is not a cookie we can use.
            return null;
        }
    }
    return null;
};

module.exports = { readCookie };

// ─────────────────────────────────────────────────────────────────────────────
// Security response headers.
//
// Hand-rolled rather than pulling in `helmet`, to match the dependency-free
// approach already taken for the rate limiter — and because what this API
// actually needs is a short, explicit list. Every header below is commented with
// what it does here specifically; if that list ever grows, swap this for helmet
// rather than accumulating folklore.
//
// Note what this is NOT: these headers protect the API's own responses. They do
// nothing for the frontend, which is served by Netlify — a Content-Security-Policy
// for the site belongs in netlify.toml, and would be the single best defence
// against the class of injection bug that the JSON-LD escaping fixed one instance
// of.
// ─────────────────────────────────────────────────────────────────────────────

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

const securityHeaders = (req, res, next) => {
    // Every response here is JSON. Without this a browser is free to sniff a
    // response body and treat it as HTML or script, which turns any endpoint
    // that echoes user input into a delivery vector.
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Nothing on this API is meant to be framed. Modern browsers prefer CSP
    // frame-ancestors, but X-Frame-Options still covers older ones.
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");

    // Don't leak the full request URL to third-party hosts. Relevant because
    // password-reset and email-confirmation links carry their token in the path:
    // without this, any outbound request from a page holding one could put that
    // token in a Referer header.
    res.setHeader('Referrer-Policy', 'no-referrer');

    // This API has no use for the camera, microphone or location.
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

    // Tell browsers never to try this origin over plain HTTP again. Only sent in
    // production: setting it in development would pin `localhost` to HTTPS in the
    // developer's browser, which is difficult to undo and confusing when it bites.
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', `max-age=${ONE_YEAR_SECONDS}; includeSubDomains`);
    }

    // Express advertises itself by default. No reason to name the stack.
    res.removeHeader('X-Powered-By');

    next();
};

module.exports = securityHeaders;

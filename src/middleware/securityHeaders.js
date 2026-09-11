
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

const securityHeaders = (req, res, next) => {

    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Nothing on this API is meant to be framed. Modern browsers prefer CSP
    // frame-ancestors, but X-Frame-Options still covers older ones.
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");


    res.setHeader('Referrer-Policy', 'no-referrer');

    // This API has no use for the camera, microphone or location.
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

   
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', `max-age=${ONE_YEAR_SECONDS}; includeSubDomains`);
    }

  
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');

    // Every response carries personal data of one kind or another (tokens, the
    // caller's own profile, admin queues). Never let a shared cache keep it.
    if (!res.getHeader('Cache-Control')) {
        res.setHeader('Cache-Control', 'no-store');
    }

    // Express advertises itself by default. No reason to name the stack.
    res.removeHeader('X-Powered-By');

    next();
};

module.exports = securityHeaders;



const store = require('./rateLimitStore');

// createRateLimit({ windowMs, max, keyGenerator, message })
//   windowMs       length of the fixed window in ms
//   max            allowed requests per key per window
//   keyGenerator   (req) => string | null. Returning null/undefined skips the limiter.
//   message        body returned as { message } on 429
const createRateLimit = ({ windowMs, max, keyGenerator, message }) => {
    const window = windowMs || 15 * 60 * 1000;
    const limit = max || 10;
    const getKey = keyGenerator || ((req) => req.ip);
    const body = message || 'Too many requests. Please try again later.';

    return async (req, res, next) => {
        let key;
        try {
            key = getKey(req);
        } catch {
            key = null;
        }

        if (!key) return next();

        let entry;
        try {
            // Namespaced so these keys cannot collide with anything else
            // sharing the Redis instance.
            entry = await store.hit(`rl:${key}`, window);
        } catch (err) {
            console.error('[rate-limit] store unavailable, allowing request:', err.message);
            return next();
        }

        if (entry.count > limit) {
            const retryAfter = Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000));
            res.set('Retry-After', String(retryAfter));
            return res.status(429).json({ message: body });
        }

        next();
    };
};

module.exports = createRateLimit;
module.exports.createRateLimit = createRateLimit;
module.exports.store = store;

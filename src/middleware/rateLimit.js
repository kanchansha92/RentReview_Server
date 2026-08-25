// Dependency-free, in-memory rate limiter.
//
// NOTE: state lives in this process only. It is per-instance (a multi-dyno /
// multi-worker deploy gets one bucket per instance) and it resets on every
// restart. That is good enough to blunt credential stuffing and mail-bombing;
// it is not a distributed quota. Swap the Map for Redis if that is ever needed.

const buckets = new Map(); // key -> { count, resetAt }

const SWEEP_INTERVAL_MS = 60 * 1000;

// Drop expired buckets so the Map cannot grow without bound.
// .unref() so this timer never keeps the process alive on its own.
const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets) {
        if (entry.resetAt <= now) {
            buckets.delete(key);
        }
    }
}, SWEEP_INTERVAL_MS);

if (typeof sweeper.unref === 'function') {
    sweeper.unref();
}

// createRateLimit({ windowMs, max, keyGenerator, message })
//   windowMs      — length of the fixed window in ms
//   max           — allowed requests per key per window
//   keyGenerator  — (req) => string | null. Returning null/undefined skips the limiter.
//   message       — body returned as { message } on 429
const createRateLimit = ({ windowMs, max, keyGenerator, message }) => {
    const window = windowMs || 15 * 60 * 1000;
    const limit = max || 10;
    const getKey = keyGenerator || ((req) => req.ip);
    const body = message || 'Too many requests. Please try again later.';

    return (req, res, next) => {
        let key;
        try {
            key = getKey(req);
        } catch (err) {
            key = null;
        }

        if (!key) return next();

        const now = Date.now();
        let entry = buckets.get(key);

        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + window };
            buckets.set(key, entry);
        }

        entry.count += 1;

        if (entry.count > limit) {
            const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
            res.set('Retry-After', String(retryAfter));
            return res.status(429).json({ message: body });
        }

        next();
    };
};

module.exports = createRateLimit;
module.exports.createRateLimit = createRateLimit;

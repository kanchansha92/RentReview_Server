
const SWEEP_INTERVAL_MS = 60 * 1000;

// ── In-memory store (the default) ────────────────────────────────────────────
const createMemoryStore = () => {
    const buckets = new Map(); // key -> { count, resetAt }

    // Drop expired buckets so the Map cannot grow without bound.
    const sweeper = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of buckets) {
            if (entry.resetAt <= now) buckets.delete(key);
        }
    }, SWEEP_INTERVAL_MS);
    // .unref() so this timer never keeps the process alive on its own.
    if (typeof sweeper.unref === 'function') sweeper.unref();

    return {
        kind: 'memory',
        /** @returns {Promise<{count:number, resetAt:number}>} */
        async hit(key, windowMs) {
            const now = Date.now();
            let entry = buckets.get(key);
            if (!entry || entry.resetAt <= now) {
                entry = { count: 0, resetAt: now + windowMs };
                buckets.set(key, entry);
            }
            entry.count += 1;
            return { count: entry.count, resetAt: entry.resetAt };
        },
    };
};

// ── Redis store ──────────────────────────────────────────────────────────────
const createRedisStore = (url) => {
    let client;
    try {
        // Lazy + optional: only reached when REDIS_URL is set, so the package
        // need not be installed otherwise.
        // eslint-disable-next-line global-require
        const { createClient } = require('redis');
        client = createClient({ url });
    } catch (err) {
        console.error(
            '[rate-limit] REDIS_URL is set but the `redis` package is not installed ' +
            '(`npm install redis`). Falling back to in-memory limits.'
        );
        return null;
    }

    let healthy = false;
    client.on('error', (err) => {
        // Redis emits errors continuously while down; log the transition only.
        if (healthy) console.error('[rate-limit] Redis error, falling back to memory:', err.message);
        healthy = false;
    });
    client.on('ready', () => {
        healthy = true;
        console.log('[rate-limit] Redis connected  limits are shared across instances.');
    });

    client.connect().catch((err) => {
        console.error('[rate-limit] could not connect to Redis:', err.message);
    });

    const memoryFallback = createMemoryStore();

    return {
        kind: 'redis',
        async hit(key, windowMs) {
            // A store outage must not take sign-in down with it.
            if (!healthy) return memoryFallback.hit(key, windowMs);
            try {
                const ttlSeconds = Math.ceil(windowMs / 1000);
                // INCR then EXPIRE-if-new: the first hit in a window sets the
                // TTL, later hits leave it alone, so the window is fixed rather
                // than sliding forward on every request.
                const count = await client.incr(key);
                if (count === 1) await client.expire(key, ttlSeconds);
                const ttl = await client.ttl(key);
                return {
                    count,
                    resetAt: Date.now() + (ttl > 0 ? ttl * 1000 : windowMs),
                };
            } catch (err) {
                console.error('[rate-limit] Redis hit failed, using memory:', err.message);
                return memoryFallback.hit(key, windowMs);
            }
        },
    };
};

const url = (process.env.REDIS_URL || '').trim();
const store = (url && createRedisStore(url)) || createMemoryStore();

// Only worth saying in production, where running more than one instance is
// plausible and the note is therefore actionable. Printing it on every local
// start is noise, and a message you cannot act on just teaches people to skim
// past the ones you can.
if (store.kind === 'memory' && process.env.NODE_ENV === 'production') {
    console.warn(
        '[rate-limit] in-memory limits: counts are per-instance and reset on restart. ' +
        'Set REDIS_URL (and `npm install redis`) if this service runs more than one instance.'
    );
}

module.exports = store;

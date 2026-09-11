

const MAX_DEPTH = 10;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const offendingKey = (value, depth = 0) => {
    if (depth > MAX_DEPTH) return '(nesting too deep)';
    if (Array.isArray(value)) {
        for (const item of value) {
            const hit = offendingKey(item, depth + 1);
            if (hit) return hit;
        }
        return null;
    }
    if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) {
            if (key.startsWith('$') || key.includes('.') || FORBIDDEN_KEYS.has(key)) return key;
            const hit = offendingKey(value[key], depth + 1);
            if (hit) return hit;
        }
    }
    return null;
};

const rejectMongoOperators = (req, res, next) => {
    if (!req.body || typeof req.body !== 'object') return next();
    const key = offendingKey(req.body);
    if (key) {
        return res.status(400).json({ message: 'Request contains an invalid field name.' });
    }
    next();
};

module.exports = rejectMongoOperators;
module.exports.offendingKey = offendingKey;

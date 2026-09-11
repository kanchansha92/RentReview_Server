

const ALLOWED_ORIGINS = (process.env.FRONTEND_URL || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);


const isAllowedOrigin = (origin) => {
    if (ALLOWED_ORIGINS.length === 0) return true;
    if (!origin) return true; // same-origin / server-to-server send no Origin
    return ALLOWED_ORIGINS.includes(String(origin).replace(/\/+$/, ''));
};

module.exports = { ALLOWED_ORIGINS, isAllowedOrigin };

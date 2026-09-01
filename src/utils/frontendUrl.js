
const frontendBaseUrl = () =>
    (process.env.FRONTEND_URL || '')
        .split(',')[0]
        .trim()
        .replace(/\/+$/, '');

module.exports = { frontendBaseUrl };

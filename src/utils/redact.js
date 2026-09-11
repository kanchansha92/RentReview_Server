
/** `kanchan@example.com` → `k***n@example.com` */
const maskEmail = (email) => {
    if (typeof email !== 'string' || !email.includes('@')) return '(no email)';
    const [local, domain] = email.split('@');
    if (local.length <= 2) return `${local[0] || '*'}***@${domain}`;
    return `${local[0]}***${local[local.length - 1]}@${domain}`;
};

module.exports = { maskEmail };

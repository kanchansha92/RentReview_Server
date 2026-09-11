
const { maskEmail } = require('./redact');
const { recordAudit } = require('../models/AuditLog');

const SEEDED_ADMIN_EMAILS = new Set(
    (process.env.ADMIN_EMAILS || '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
);

/**
 * Is this address configured as an admin?
 * @param {string} email
 * @returns {boolean}
 */
const isSeededAdmin = (email) =>
    typeof email === 'string' && SEEDED_ADMIN_EMAILS.has(email.trim().toLowerCase());


const applySeededAdmin = async (user) => {
    if (!user || user.role === 'admin' || !isSeededAdmin(user.email)) return false;

    user.role = 'admin';

    try {
        // validateModifiedOnly, matching promoteAdmin.js: accounts created
        // before the current field rules must not be blocked by a field this
        // change never touched.
        await user.save({ validateModifiedOnly: true });
        console.log(`[seeded-admin] ${maskEmail(user.email)} (${user._id}) promoted to admin via ADMIN_EMAILS`);
        // Gaining admin is the single most consequential role change here  it
        // unlocks every pending government ID. It belongs in the durable trail.
        recordAudit({
            action: 'admin.granted',
            targetType: 'User',
            targetId: user._id,
            meta: { via: 'ADMIN_EMAILS' },
        });
    } catch (error) {
        console.error(`[seeded-admin] could not persist admin role for ${maskEmail(user.email)}:`, error.message);
    }

    return true;
};

module.exports = { isSeededAdmin, applySeededAdmin, SEEDED_ADMIN_EMAILS };

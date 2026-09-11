

const mongoose = require('mongoose');

const RETENTION_DAYS = Number(process.env.AUDIT_LOG_RETENTION_DAYS) > 0
    ? Number(process.env.AUDIT_LOG_RETENTION_DAYS)
    : 730; // two years

const auditLogSchema = new mongoose.Schema(
    {
        // Who acted. Null for automated processes (the retention sweeper).
        actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        actorRole: { type: String, default: '' },

        action: {
            type: String,
            required: true,
            enum: [
                'id_proof.viewed',
                'id_proof.decided',
                'id_proof.expired',
                'review.deleted_by_admin',
                'review.restored',
                'report.resolved',
                'account.deleted',
                'account.locked',
                'admin.granted',
            ],
            index: true,
        },

        targetType: { type: String, default: '' },   // 'Review' | 'User'
        targetId: { type: mongoose.Schema.Types.ObjectId, default: null },

        // Small, non-identifying context: { decision: 'approve' }, { count: 12 }.
        meta: { type: mongoose.Schema.Types.Mixed, default: {} },

        // Useful for spotting a compromised admin account. Not shown to anyone.
        ip: { type: String, default: '' },
    },
    { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ actor: 1, createdAt: -1 });
// Expire old entries automatically  an audit log that grows forever becomes a
// liability of its own.
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_DAYS * 24 * 60 * 60 });

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

AuditLog.on('error', (err) => {
    console.error('AuditLog index build error:', err.message);
});

/**
 * Record an event. Never throws and never rejects: an audit write failing must
 * not turn a completed action into a 500, and it must not roll anything back.
 * A failure is logged loudly instead, because a silent gap in an audit trail is
 * worse than a noisy one.
 */
const recordAudit = async (entry) => {
    try {
        await AuditLog.create(entry);
    } catch (err) {
        console.error('[audit] could not record', entry && entry.action, '', err.message);
    }
};

module.exports = AuditLog;
module.exports.recordAudit = recordAudit;
module.exports.RETENTION_DAYS = RETENTION_DAYS;

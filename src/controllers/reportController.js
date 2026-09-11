const mongoose = require('mongoose');
const Report = require('../models/Report');
const { REASONS, RELATIONSHIPS } = require('../models/Report');
const Review = require('../models/Review');
const { recalcProperty } = require('./reviewController');
const { recordAudit } = require('../models/AuditLog');
const { maskEmail } = require('../utils/redact');
const { detectPersonalInfo } = require('../utils/detectPersonalInfo');
const {
    acknowledgeReport,
    notifyReportResolved,
    notifyTeamOfReport,
} = require('../utils/reportNotice');

const LIMITS = { name: 120, email: 254, details: 3000, reply: 2000 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const asString = (value) => (typeof value === 'string' ? value.trim() : '');

// ─── POST /api/reports ───────────────────────────────────────────────────────
// Public. See models/Report.js for why this does not require an account.
const submitReport = async (req, res) => {
    try {
        // Honeypot, same as the contact form: a hidden field no human fills in.
        // Answer 200 so a bot believes it worked and doesn't retry.
        if (asString(req.body?.website)) {
            console.warn('[report] honeypot filled  dropping, nothing stored.');
            return res.status(200).json({ success: true, message: 'Thanks  your report has been received.' });
        }

        const reviewId = asString(req.body?.reviewId);
        const reason = asString(req.body?.reason);
        const details = asString(req.body?.details);
        const reporterName = asString(req.body?.reporterName);
        const reporterEmail = asString(req.body?.reporterEmail).toLowerCase();
        const relationship = asString(req.body?.relationship) || 'other';
        const requestedReply = asString(req.body?.requestedReply);

        const errors = {};

        if (!reviewId || !mongoose.Types.ObjectId.isValid(reviewId)) {
            return res.status(400).json({ message: 'That review could not be found.' });
        }
        if (!REASONS.includes(reason)) errors.reason = 'Please choose a reason.';
        if (!details) errors.details = 'Please tell us what the problem is.';
        else if (details.length > LIMITS.details) errors.details = `Please keep this under ${LIMITS.details} characters.`;

        if (!reporterName) errors.reporterName = 'Please enter your name.';
        else if (reporterName.length > LIMITS.name) errors.reporterName = 'That name is too long.';

        if (!reporterEmail) errors.reporterEmail = 'Please enter your email address.';
        else if (reporterEmail.length > LIMITS.email || !EMAIL_RE.test(reporterEmail)) {
            errors.reporterEmail = 'Please enter a valid email address.';
        }

        if (!RELATIONSHIPS.includes(relationship)) errors.relationship = 'Please choose how you relate to this property.';
        if (requestedReply.length > LIMITS.reply) errors.requestedReply = `Please keep your response under ${LIMITS.reply} characters.`;

        if (Object.keys(errors).length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Please check the form and try again.',
                errors,
            });
        }

        // The review has to exist, but say nothing about whether it is hidden 
        // a complaint about an already-hidden review is still worth recording,
        // and confirming its state to an anonymous caller leaks moderation
        // decisions.
        const review = await Review.findById(reviewId).populate('property', 'streetAddress city state');
        if (!review) {
            return res.status(404).json({ message: 'That review could not be found.' });
        }

        const propertyLabel = review.property
            ? [review.property.streetAddress, review.property.city, review.property.state]
                .filter(Boolean)
                .join(', ')
            : '';

        const report = await Report.create({
            review: review._id,
            propertyLabel,
            reason,
            details,
            reporterName,
            reporterEmail,
            relationship,
            requestedReply,
            ip: req.ip,
        });

        // Ids and a masked address only  the complaint body can name people.
        console.log(`[report] ${report._id} filed (${reason}) on review ${review._id} by ${maskEmail(reporterEmail)}`);

        // Acknowledge on the request itself: this is the 24-hour obligation, and
        // a queue that fails silently would not discharge it. Recorded so we can
        // show it was sent.
        const acknowledged = await acknowledgeReport(report);
        if (acknowledged) {
            report.acknowledgedAt = new Date();
            await report.save({ validateBeforeSave: false });
        }

        // The team needs to know without opening the admin page.
        notifyTeamOfReport(report).catch(() => {});

        res.status(201).json({
            success: true,
            reference: String(report._id).slice(-8),
            message: acknowledged
                ? 'Thanks  your report has been received. Check your email for confirmation and your reference number.'
                : 'Thanks  your report has been received. We could not email a confirmation, but it has been logged.',
        });
    } catch (error) {
        console.error('Submit report error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

// ─── GET /api/reports/admin ──────────────────────────────────────────────────
// The moderation queue. Admin only  a report carries the complainant's name
// and email, which belong to someone who is not a user of this site.
const getReports = async (req, res) => {
    try {
        const status = req.query.status === 'resolved' ? 'resolved' : 'pending';
        const limit = Math.max(Math.min(Number(req.query.limit) || 25, 100), 1);
        const page = Math.max(Number(req.query.page) || 1, 1);

        const [reports, total] = await Promise.all([
            Report.find({ status })
                .populate({
                    path: 'review',
                    select: 'reviewerName rating title body createdAt moderation ownerResponse photos',
                })
                .populate('reviewedBy', 'name')
                // Pending: oldest first, so the 15-day clock is visible.
                // Resolved: newest first, which is how you read a history.
                .sort(status === 'pending' ? { createdAt: 1 } : { reviewedAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit),
            Report.countDocuments({ status }),
        ]);

        res.json({
            success: true,
            count: reports.length,
            reports,
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit) || 0,
        });
    } catch (error) {
        console.error('Get reports error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};


const decideReport = async (req, res) => {
    try {
        const outcome = asString(req.body?.outcome);
        const note = asString(req.body?.note);
        const replyText = asString(req.body?.replyText);

        const VALID = ['dismissed', 'review-hidden', 'reply-published', 'both'];
        if (!VALID.includes(outcome)) {
            return res.status(400).json({ message: `Outcome must be one of: ${VALID.join(', ')}.` });
        }
        if (note.length > 2000) {
            return res.status(400).json({ message: 'Note must be 2000 characters or fewer.' });
        }

        const report = await Report.findById(req.params.id);
        if (!report) return res.status(404).json({ message: 'Report not found.' });
        if (report.status === 'resolved') {
            return res.status(409).json({ message: 'This report has already been resolved.' });
        }

        const publishesReply = outcome === 'reply-published' || outcome === 'both';
        const hidesReview = outcome === 'review-hidden' || outcome === 'both';

        // What actually gets published: whatever the admin edited in the box,
        // falling back to what was submitted. An admin trimming a reply before
        // it goes live is the normal case, not an exception.
        const finalReply = replyText || report.requestedReply;
        if (publishesReply && !finalReply) {
            return res.status(400).json({
                message: 'There is no response text to publish. Add one, or choose a different outcome.',
            });
        }
        if (finalReply.length > 2000) {
            return res.status(400).json({ message: 'The response must be 2000 characters or fewer.' });
        }
        // The reply is published publicly, so it gets the same screen a review
        // does  an owner rebutting a review by posting the tenant's phone
        // number is the mirror image of the harm this queue exists to fix.
        if (publishesReply) {
            const pii = detectPersonalInfo(finalReply);
            if (pii) {
                return res.status(400).json({
                    message: `That response can't be published as written. ${pii.message}`,
                });
            }
        }

        const review = await Review.findById(report.review);
        if (!review && (publishesReply || hidesReview)) {
            return res.status(410).json({
                message: 'The review this report is about no longer exists. Dismiss the report instead.',
            });
        }

        if (review) {
            if (hidesReview) {
                review.moderation.status = 'hidden';
                review.moderation.hiddenReason = report.reason;
                review.moderation.hiddenAt = new Date();
                review.moderation.hiddenBy = req.user.id;
            }
            if (publishesReply) {
                review.ownerResponse.body = finalReply;
                review.ownerResponse.publishedAt = new Date();
                review.ownerResponse.publishedBy = req.user.id;
            }
            if (hidesReview || publishesReply) {
                // validateModifiedOnly: reviews written before the current field
                // rules must not be blocked by a field this change never touched.
                await review.save({ validateModifiedOnly: true });
                // Hiding changes the property's average, so recompute it.
                if (hidesReview) await recalcProperty(review.property);
            }
        }

        report.status = 'resolved';
        report.outcome = outcome;
        report.resolutionNote = note;
        report.reviewedBy = req.user.id;
        report.reviewedAt = new Date();
        await report.save();

        recordAudit({
            actor: req.user.id,
            actorRole: req.user.role,
            action: 'report.resolved',
            targetType: 'Report',
            targetId: report._id,
            meta: { outcome, review: String(report.review), reason: report.reason },
            ip: req.ip,
        });

        // Best-effort and last: the decision is made and recorded, and a mail
        // failure must not roll it back or 500 an admin who already decided.
        notifyReportResolved(report, outcome, note).catch(() => {});

        res.json({
            success: true,
            message: 'Report resolved.',
            reportId: report._id,
            outcome,
        });
    } catch (error) {
        if (error.kind === 'ObjectId') return res.status(404).json({ message: 'Report not found.' });
        console.error('Decide report error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

// ─── PUT /api/reports/admin/reviews/:id/restore ──────────────────────────────
// Put a hidden review back. Hiding has to be reversible, or a bad-faith
// complaint becomes a permanent takedown that nobody can undo.
const restoreReview = async (req, res) => {
    try {
        const review = await Review.findById(req.params.id);
        if (!review) return res.status(404).json({ message: 'Review not found.' });

        if (review.moderation?.status !== 'hidden') {
            return res.status(409).json({ message: 'That review is already visible.' });
        }

        review.moderation.status = 'visible';
        review.moderation.hiddenReason = '';
        review.moderation.hiddenAt = null;
        review.moderation.hiddenBy = null;
        await review.save({ validateModifiedOnly: true });
        await recalcProperty(review.property);

        recordAudit({
            actor: req.user.id,
            actorRole: req.user.role,
            action: 'review.restored',
            targetType: 'Review',
            targetId: review._id,
            ip: req.ip,
        });

        res.json({ success: true, message: 'Review is publicly visible again.' });
    } catch (error) {
        if (error.kind === 'ObjectId') return res.status(404).json({ message: 'Review not found.' });
        console.error('Restore review error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

module.exports = { submitReport, getReports, decideReport, restoreReview };


const sendEmail = require('./sendEmail');
const { frontendBaseUrl } = require('./frontendUrl');
const { maskEmail } = require('./redact');

const escapeHtml = (value) =>
    String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

const shell = (title, bodyHtml) => `
    <div style="font-family:sans-serif;max-width:560px;margin:auto;padding:32px;border:1px solid #e5e7eb;border-radius:12px">
        <h2 style="color:#41B985;margin-bottom:8px">${title}</h2>
        ${bodyHtml}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
        <p style="color:#9ca3af;font-size:12px">© ${new Date().getFullYear()} RentReview</p>
    </div>
`;

const send = async (to, subject, html, text) => {
    try {
        await sendEmail({ to, subject, html, text });
        return true;
    } catch (err) {
        console.error(`[report] could not send "${subject}" to ${maskEmail(to)}:`, err.message);
        return false;
    }
};

/**
 * Sent immediately on submission. This is the 24-hour acknowledgement, so it
 * goes out on the request itself rather than on a queue that might not run.
 * @returns {Promise<boolean>} whether it actually went out
 */
const acknowledgeReport = (report) =>
    send(
        report.reporterEmail,
        `RentReview — we've received your report (${String(report._id).slice(-8)})`,
        shell(
            "We've received your report",
            `<p style="color:#374151">Thank you for getting in touch. Someone will review your report about a
             listing at <strong>${escapeHtml(report.propertyLabel || 'a property')}</strong> and respond
             within <strong>15 days</strong>, usually sooner.</p>
             <p style="color:#374151">Your reference is
             <strong style="font-family:monospace">${String(report._id).slice(-8)}</strong> — quote it if you
             need to follow up.</p>
             ${report.requestedReply
                ? `<p style="color:#374151">You also submitted a response to be published alongside the review.
                   We'll tell you whether it goes up when we've reviewed the report.</p>`
                : ''}
             <p style="color:#6b7280;font-size:13px">We don't publish anything about your report, and we don't
             pass your contact details to the reviewer.</p>`
        ),
        `We've received your report about ${report.propertyLabel || 'a property'}.\n` +
        `Reference: ${String(report._id).slice(-8)}\n\n` +
        `Someone will review it and respond within 15 days.`
    );

/** Sent when an admin closes the report. `outcome` explains what changed. */
const notifyReportResolved = (report, outcome, note) => {
    const base = frontendBaseUrl();

    const outcomeCopy = {
        'dismissed':
            `<p style="color:#374151">We've looked at the review you reported and it will stay published.
             Based on what we could establish, it doesn't breach our content guidelines.</p>`,
        'review-hidden':
            `<p style="color:#374151">We've looked at the review you reported and <strong>removed it from
             public view</strong>.</p>`,
        'reply-published':
            `<p style="color:#374151">Your response is now <strong>published beneath the review</strong>, so
             anyone reading it sees your side. The review itself will stay up.</p>`,
        'both':
            `<p style="color:#374151">We've <strong>removed the review from public view</strong> and
             <strong>published your response</strong>.</p>`,
        'review-deleted':
            `<p style="color:#374151">We've looked at the review you reported and
             <strong>deleted it permanently</strong>. It is gone from the site along with any photos
             attached to it, and it cannot be put back.</p>
             ${report.requestedReply
                ? `<p style="color:#374151">Your response has not been published  it would have appeared
                   beneath the review, and there is no longer a review for it to sit under.</p>`
                : ''}`,
    }[outcome] || `<p style="color:#374151">We've finished reviewing your report.</p>`;

    return send(
        report.reporterEmail,
        `RentReview — your report has been reviewed (${String(report._id).slice(-8)})`,
        shell(
            'Your report has been reviewed',
            `${outcomeCopy}
             ${note ? `<div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:10px;padding:16px;margin:16px 0;font-size:14px;line-height:1.6;color:#374151"><strong>Note from our team:</strong><br>${escapeHtml(note).replace(/\r?\n/g, '<br />')}</div>` : ''}
             <p style="color:#6b7280;font-size:13px">If you disagree with this outcome, reply to this email or
             use the ${base ? `<a href="${base}/contact" style="color:#41B985">contact form</a>` : 'contact form'}
             quoting reference
             <strong style="font-family:monospace">${String(report._id).slice(-8)}</strong>.</p>`
        ),
        `We've finished reviewing your report (ref ${String(report._id).slice(-8)}).\n\n` +
        (note ? `Note from our team: ${note}\n\n` : '') +
        `If you disagree with this outcome, reply to this email quoting your reference.`
    );
};

/**
 * Tell the team a complaint has landed. Without this the queue is only seen by
 * someone who happens to open the admin page, and the 15-day clock is already
 * running.
 */
const notifyTeamOfReport = (report) => {
    const to =
        process.env.CONTACT_RECEIVER_EMAIL || process.env.FROM_EMAIL || process.env.SMTP_USER;
    if (!to) {
        console.error('[report] no recipient configured — the team was NOT told about a new report.');
        return Promise.resolve(false);
    }

    const base = frontendBaseUrl();
    return send(
        to,
        `[Report] ${report.reason} — ${report.propertyLabel || 'a property'}`,
        shell(
            'New report on a review',
            `<table style="width:100%;border-collapse:collapse;font-size:14px;color:#374151">
               <tr><td style="padding:6px 0;color:#64748B;width:110px">Reason</td><td style="padding:6px 0"><strong>${escapeHtml(report.reason)}</strong></td></tr>
               <tr><td style="padding:6px 0;color:#64748B">Property</td><td style="padding:6px 0">${escapeHtml(report.propertyLabel || '—')}</td></tr>
               <tr><td style="padding:6px 0;color:#64748B">From</td><td style="padding:6px 0">${escapeHtml(report.reporterName)} (${escapeHtml(report.relationship)})</td></tr>
               <tr><td style="padding:6px 0;color:#64748B">Reply?</td><td style="padding:6px 0">${report.requestedReply ? 'Yes — a response was submitted' : 'No'}</td></tr>
             </table>
             <div style="margin-top:16px;font-size:14px;line-height:1.6;white-space:pre-wrap;color:#374151">${escapeHtml(report.details)}</div>
             ${base ? `<a href="${base}/admin/reports" style="display:inline-block;margin-top:20px;padding:12px 28px;background:#41B985;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Open the queue</a>` : ''}
             <p style="color:#6b7280;font-size:13px;margin-top:16px">Resolve within 15 days.</p>`
        ),
        `New report (${report.reason}) on ${report.propertyLabel || 'a property'}\n` +
        `From: ${report.reporterName} (${report.relationship})\n\n${report.details}`
    );
};

module.exports = { acknowledgeReport, notifyReportResolved, notifyTeamOfReport };

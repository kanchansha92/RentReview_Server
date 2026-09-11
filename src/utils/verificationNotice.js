
const sendEmail = require('./sendEmail');
const { frontendBaseUrl } = require('./frontendUrl');

const escapeHtml = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

const shell = (title, bodyHtml) => `
  <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:32px 24px">
    <h1 style="font-size:20px;font-weight:700;color:#0F172A;margin:0 0 16px">${escapeHtml(title)}</h1>
    ${bodyHtml}
    <p style="color:#94A3B8;font-size:12px;margin-top:28px;border-top:1px solid #E2E8F0;padding-top:16px">
      Automatic message from RentReview. No personal data is included.
    </p>
  </div>`;

/** Where team mail goes. Same resolution order as the reports queue. */
const teamRecipient = () =>
    process.env.CONTACT_RECEIVER_EMAIL || process.env.FROM_EMAIL || process.env.SMTP_USER;

const button = (base, label) =>
    base
        ? `<a href="${base}/admin/verifications" style="display:inline-block;margin-top:20px;padding:12px 28px;background:#41B985;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(label)}</a>`
        : '';

// Never throws and never rejects: a mail outage must not fail a user's review
// submission, and must not take down the retention sweeper either.
const send = async (to, subject, html, text) => {
    try {
        await sendEmail({ to, subject, html, text });
        return true;
    } catch (err) {
        console.error('[verification-notice] could not send:', err.message);
        return false;
    }
};

/**
 * A submission needs a human. Sent only when the automated check did NOT clear
 * it  an auto-verified review needs nobody, and mailing about those would
 * train the reader to ignore the ones that matter.
 *
 * @param {object} review        the Review, for its id and age
 * @param {object} opts
 * @param {string} opts.reason   why OCR did not clear it ('no-match', 'ocr-error', …)
 * @param {number} opts.pending  how many are now waiting, if known
 * @param {number} opts.expiresInDays  retention window, so the deadline is stated
 */
const notifyTeamOfPendingVerification = async (review, { reason, pending, expiresInDays } = {}) => {
    const to = teamRecipient();
    if (!to) {
        console.error(
            '[verification-notice] no recipient configured (CONTACT_RECEIVER_EMAIL / FROM_EMAIL / SMTP_USER)  ' +
            'nobody was told a review is waiting for approval.'
        );
        return false;
    }

    const base = frontendBaseUrl();
    // The count goes in the subject line so a glance at the inbox is enough,
    // without opening anything.
    const subject = pending > 1
        ? `[RentReview] ID verification waiting (${pending} in the queue)`
        : '[RentReview] An ID verification is waiting';

    return send(
        to,
        subject,
        shell(
            'A review is waiting for approval',
            `<p style="font-size:15px;line-height:1.7;color:#374151;margin:0">
               The automated check could not clear this submission, so it needs a person.
             </p>
             <table style="width:100%;border-collapse:collapse;font-size:14px;color:#374151;margin-top:16px">
               <tr><td style="padding:6px 0;color:#64748B;width:130px">Review</td><td style="padding:6px 0"><code>${escapeHtml(review?._id)}</code></td></tr>
               <tr><td style="padding:6px 0;color:#64748B">Check result</td><td style="padding:6px 0">${escapeHtml(reason || 'needs review')}</td></tr>
               ${pending ? `<tr><td style="padding:6px 0;color:#64748B">Now waiting</td><td style="padding:6px 0"><strong>${escapeHtml(pending)}</strong></td></tr>` : ''}
             </table>
             ${button(base, 'Open the queue')}
             ${expiresInDays ? `<p style="color:#6b7280;font-size:13px;margin-top:16px">
               If nobody decides, the ID document is destroyed automatically after ${escapeHtml(expiresInDays)} days
               and the review is left unverified.
             </p>` : ''}`
        ),
        `A review is waiting for ID approval.\n` +
        `Review: ${review?._id}\nCheck result: ${reason || 'needs review'}\n` +
        (pending ? `Waiting in the queue: ${pending}\n` : '') +
        (base ? `\n${base}/admin/verifications\n` : '')
    );
};

/**
 * The safety net. Sent while there is still time to act, listing how many
 * documents are about to be destroyed unreviewed.
 *
 * A notice on submission assumes someone reads their email that day. This one
 * assumes only that someone reads it at some point in three weeks, which is why
 * it is the more valuable of the two.
 */
const warnOfExpiringIdProofs = async ({ count, withinDays, retentionDays: days }) => {
    const to = teamRecipient();
    if (!to) {
        console.error(
            `[verification-notice] no recipient configured  nobody was warned that ${count} ` +
            'ID proof(s) are about to expire unreviewed.'
        );
        return false;
    }

    const base = frontendBaseUrl();
    return send(
        to,
        `[RentReview] ${count} ID verification${count === 1 ? '' : 's'} waiting  soonest expires in ${withinDays} day${withinDays === 1 ? '' : 's'}`,
        shell(
            'ID documents are about to be destroyed unreviewed',
            `<p style="font-size:15px;line-height:1.7;color:#374151;margin:0">
               <strong>${escapeHtml(count)}</strong> submission${count === 1 ? ' has' : 's have'} been waiting
               and nobody has decided. The oldest is destroyed in
               <strong>${escapeHtml(withinDays)} day${withinDays === 1 ? '' : 's'}</strong>, after which
               its ID document is gone and the review is left unverified.
             </p>
             <p style="font-size:15px;line-height:1.7;color:#374151;margin-top:12px">
               That is the intended behaviour  we do not keep government documents indefinitely 
               but it is a decision made by running out of time rather than by anyone looking.
             </p>
             ${button(base, 'Review them now')}`
        ),
        `${count} ID verification(s) will be destroyed unreviewed in about ${withinDays} days.\n` +
        (base ? `\n${base}/admin/verifications\n` : '')
    );
};

module.exports = { notifyTeamOfPendingVerification, warnOfExpiringIdProofs };

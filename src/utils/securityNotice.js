
const sendEmail = require('./sendEmail');
const { frontendBaseUrl } = require('./frontendUrl');
const { maskEmail } = require('./redact');

const shell = (title, bodyHtml) => `
    <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:32px;border:1px solid #e5e7eb;border-radius:12px">
        <h2 style="color:#41B985;margin-bottom:8px">${title}</h2>
        ${bodyHtml}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
        <p style="color:#9ca3af;font-size:12px">© ${new Date().getFullYear()} RentReview</p>
    </div>
`;

const helpLine = () => {
    const base = frontendBaseUrl();
    const contact = base ? `<a href="${base}/contact" style="color:#41B985">contact us</a>` : 'contact us';
    return `<p style="color:#b91c1c;font-size:14px"><strong>If this wasn't you</strong>, reset your password
            immediately and ${contact}  someone may have access to your account.</p>`;
};

const send = async (to, subject, html, text) => {
    try {
        await sendEmail({ to, subject, html, text });
        return true;
    } catch (err) {
        console.error(`[security-notice] could not send "${subject}" to ${maskEmail(to)}:`, err.message);
        return false;
    }
};

/** The account password was changed (sent after the change succeeds). */
const notifyPasswordChanged = (user) =>
    send(
        user.email,
        'RentReview  your password was changed',
        shell(
            'Your password was changed',
            `<p style="color:#374151">The password for your RentReview account was just changed.
             Every other device has been signed out.</p>${helpLine()}`
        ),
        'The password for your RentReview account was just changed. Every other device has been signed out.\n\n' +
        "If this wasn't you, reset your password immediately and contact us."
    );

/** An email change was REQUESTED  sent to the address currently on file. */
const notifyEmailChangeRequested = (user, newEmail) =>
    send(
        user.email,
        'RentReview  a change to your email address was requested',
        shell(
            'Email change requested',
            `<p style="color:#374151">Someone asked to move your RentReview account to
             <strong>${maskEmail(newEmail)}</strong>. The change only takes effect once that new address
             confirms it  this address will stop working on your account when it does.</p>${helpLine()}`
        ),
        `Someone asked to move your RentReview account to ${maskEmail(newEmail)}. ` +
        "The change only takes effect once that address confirms it.\n\n" +
        "If this wasn't you, reset your password immediately and contact us."
    );

/** Sign-in was locked after repeated failures. */
const notifyAccountLocked = (user, minutes) =>
    send(
        user.email,
        'RentReview  sign-in temporarily locked',
        shell(
            'Too many failed sign-in attempts',
            `<p style="color:#374151">Sign-in to your RentReview account has been paused for
             <strong>${minutes} minutes</strong> after several failed attempts.</p>
             <p style="color:#374151">If that was you, wait it out or reset your password.
             If it wasn't, someone is trying to guess it  your account is safe for now, but a
             password only you would choose is worth setting.</p>`
        ),
        `Sign-in to your RentReview account has been paused for ${minutes} minutes after several failed attempts.`
    );

module.exports = {
    notifyPasswordChanged,
    notifyEmailChangeRequested,
    notifyAccountLocked,
};

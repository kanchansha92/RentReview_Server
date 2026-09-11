const sendEmail = require('../utils/sendEmail');
const { maskEmail } = require('../utils/redact');

// ── Limits ────────────────────────────────────────────────────────────────────
// Generous enough for a real enquiry, tight enough that the form cannot be used
// to post a novel (or a payload) into our inbox.
const LIMITS = {
    name: 100,
    email: 254, // RFC 5321 maximum
    subject: 150,
    message: 5000,
};

// Deliberately permissive  real-world addresses are stranger than most regexes
// allow. The authoritative check is whether the reply ever lands.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Escape before interpolating anything user-supplied into the HTML body,
// otherwise a submitted `<script>` (or a stray `<`) mangles the email we read.
const escapeHtml = (value) =>
    String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

// CR/LF in a header value is a header-injection vector (extra Bcc:, spoofed
// Reply-To). Strip them from anything that reaches a header  subject, replyTo.
const stripNewlines = (value) => String(value).replace(/[\r\n]+/g, ' ').trim();

const asString = (value) => (typeof value === 'string' ? value.trim() : '');

const recipient = () =>
    process.env.CONTACT_RECEIVER_EMAIL ||
    process.env.FROM_EMAIL ||
    process.env.SMTP_USER;

// ── POST /api/contact ─────────────────────────────────────────────────────────
// Public endpoint. Takes { name, email, subject, message } from the contact
// form, emails it to the team, and sends the visitor a confirmation copy.
const submitContactForm = async (req, res) => {
    try {
        const name = asString(req.body?.name);
        const email = asString(req.body?.email).toLowerCase();
        const subject = asString(req.body?.subject);
        const message = asString(req.body?.message);

        console.log(`CONTACT: submission received from ${maskEmail(email)}`);

  
        if (asString(req.body?.website)) {
            console.warn('CONTACT: honeypot field was filled  dropping, NO email sent.');
            return res.status(200).json({
                success: true,
                message: 'Thanks! Your message has been sent.',
            });
        }

        const errors = {};
        if (!name) errors.name = 'Please enter your name.';
        else if (name.length > LIMITS.name) errors.name = `Name must be under ${LIMITS.name} characters.`;

        if (!email) errors.email = 'Please enter your email address.';
        else if (email.length > LIMITS.email || !EMAIL_RE.test(email))
            errors.email = 'Please enter a valid email address.';

        if (!subject) errors.subject = 'Please enter a subject.';
        else if (subject.length > LIMITS.subject) errors.subject = `Subject must be under ${LIMITS.subject} characters.`;

        if (!message) errors.message = 'Please enter a message.';
        else if (message.length > LIMITS.message) errors.message = `Message must be under ${LIMITS.message} characters.`;

        if (Object.keys(errors).length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Please check the form and try again.',
                errors,
            });
        }

        const to = recipient();
        if (!to) {
            // Misconfiguration, not the visitor's fault  log loudly, and do not
            // pretend to the visitor that the message went somewhere.
            console.error('CONTACT: no recipient configured. Set CONTACT_RECEIVER_EMAIL (or FROM_EMAIL) in .env');
            return res.status(500).json({
                success: false,
                message: 'We could not send your message right now. Please email us directly.',
            });
        }

        const safe = {
            name: escapeHtml(name),
            email: escapeHtml(email),
            subject: escapeHtml(subject),
            // Preserve the visitor's line breaks in the HTML version.
            message: escapeHtml(message).replace(/\r?\n/g, '<br />'),
        };

        const receivedAt = new Date().toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            dateStyle: 'medium',
            timeStyle: 'short',
        });

        // ── 1. Notification to the team ───────────────────────────────────────
        // Reply-To is the visitor, so replying from the inbox just works.
        const teamHtml = `
            <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#0F172A">
              <div style="background:#3EB489;color:#fff;padding:20px 24px;border-radius:12px 12px 0 0">
                <h2 style="margin:0;font-size:18px">New contact form message</h2>
                <p style="margin:4px 0 0;font-size:13px;opacity:.9">RentReview · ${escapeHtml(receivedAt)} IST</p>
              </div>
              <div style="border:1px solid #E2E8F0;border-top:none;border-radius:0 0 12px 12px;padding:24px">
                <table style="width:100%;border-collapse:collapse;font-size:14px">
                  <tr>
                    <td style="padding:6px 0;color:#64748B;width:90px">From</td>
                    <td style="padding:6px 0;font-weight:bold">${safe.name}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0;color:#64748B">Email</td>
                    <td style="padding:6px 0"><a href="mailto:${safe.email}" style="color:#3EB489">${safe.email}</a></td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0;color:#64748B">Subject</td>
                    <td style="padding:6px 0;font-weight:bold">${safe.subject}</td>
                  </tr>
                </table>
                <hr style="border:none;border-top:1px solid #E2E8F0;margin:18px 0" />
                <p style="margin:0 0 8px;color:#64748B;font-size:12px;text-transform:uppercase;letter-spacing:.08em">Message</p>
                <div style="font-size:15px;line-height:1.65;white-space:pre-wrap">${safe.message}</div>
                <p style="margin-top:24px;font-size:12px;color:#94A3B8">
                  Reply to this email to respond to ${safe.name} directly.
                </p>
              </div>
            </div>`;

        await sendEmail({
            to,
            subject: stripNewlines(`[Contact] ${subject}`).slice(0, 200),
            html: teamHtml,
            text:
                `New contact form message\n\n` +
                `Name: ${name}\nEmail: ${email}\nSubject: ${subject}\nReceived: ${receivedAt} IST\n\n` +
                `Message:\n${message}\n`,
            replyTo: stripNewlines(email),
        });

        console.log('CONTACT: ✅ notification accepted by SMTP for delivery to the team inbox');

        // ── 2. Confirmation copy to the visitor ───────────────────────────────
        // Best-effort: the team already has the message, so a failure here must
        // not turn a delivered enquiry into an error for the visitor.
        try {
            await sendEmail({
                to: stripNewlines(email),
                subject: 'We received your message  RentReview',
                html: `
                    <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#0F172A">
                      <div style="background:#3EB489;color:#fff;padding:24px;border-radius:12px 12px 0 0">
                        <h2 style="margin:0;font-size:20px">Thanks for reaching out, ${safe.name}!</h2>
                      </div>
                      <div style="border:1px solid #E2E8F0;border-top:none;border-radius:0 0 12px 12px;padding:24px">
                        <p style="font-size:15px;line-height:1.65;margin-top:0">
                          We have got your message and our team will get back to you within 24 hours.
                          Here is a copy for your records:
                        </p>
                        <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:10px;padding:16px;font-size:14px;line-height:1.65">
                          <p style="margin:0 0 10px"><strong>Subject:</strong> ${safe.subject}</p>
                          <div style="white-space:pre-wrap">${safe.message}</div>
                        </div>
                        <p style="font-size:13px;color:#64748B;margin-bottom:0">
                          You do not need to reply to this email  we will be in touch shortly.
                        </p>
                      </div>
                    </div>`,
                text:
                    `Thanks for reaching out, ${name}!\n\n` +
                    `We have got your message and our team will get back to you within 24 hours.\n\n` +
                    `Subject: ${subject}\n\n${message}\n`,
            });
            console.log(`CONTACT: ✅ confirmation accepted by SMTP for delivery to ${maskEmail(email)}`);
        } catch (ackErr) {
            console.error('CONTACT: confirmation email to visitor failed:', ackErr.message);
        }

        return res.status(200).json({
            success: true,
            message: 'Thanks! Your message has been sent. We will reply within 24 hours.',
        });
    } catch (err) {
        // SMTP failures land here. Log the detail, give the visitor a message
        // they can act on rather than a raw transport error.
        console.error('CONTACT: failed to send message:', err);
        return res.status(502).json({
            success: false,
            message: 'We could not send your message right now. Please try again in a moment, or email us directly.',
        });
    }
};

module.exports = { submitContactForm };

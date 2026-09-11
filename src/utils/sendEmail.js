const nodemailer = require('nodemailer');

// sendEmail({ to, subject, html, text, replyTo })
//   to        recipient address (string, or comma-separated list)
//   subject   subject line
//   html      HTML body
//   text      optional plain-text alternative (better deliverability, and
//              readable in text-only clients)
//   replyTo   optional Reply-To address. The contact form uses it so that
//              hitting "Reply" in the inbox answers the visitor directly.
const sendEmail = async ({ to, subject, html, text, replyTo }) => {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
        throw new Error('SMTP configuration is missing. Please set SMTP_HOST, SMTP_USER, and SMTP_PASS in .env');
    }

    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_PORT === '465',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
        // Force IPv4 to avoid ::1 (IPv6 loopback) resolution issues on some systems
        family: 4,
    });

    // `from` must stay our own authenticated SMTP identity  putting the
    // visitor's address there would get the mail SPF/DMARC-rejected. Their
    // address goes in Reply-To instead.
    await transporter.sendMail({
        from: `"${process.env.FROM_NAME || 'RentReview'}" <${process.env.FROM_EMAIL || process.env.SMTP_USER}>`,
        to,
        subject,
        html,
        ...(text ? { text } : {}),
        ...(replyTo ? { replyTo } : {}),
    });
};

module.exports = sendEmail;

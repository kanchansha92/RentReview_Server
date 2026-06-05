const nodemailer = require('nodemailer');

const sendEmail = async ({ to, subject, html }) => {
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
        tls: {
            rejectUnauthorized: false,
        },
    });

    await transporter.sendMail({
        from: `"${process.env.FROM_NAME || 'RentReview'}" <${process.env.FROM_EMAIL || process.env.SMTP_USER}>`,
        to,
        subject,
        html,
    });
};

module.exports = sendEmail;

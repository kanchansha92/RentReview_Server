const cloudinary = require('cloudinary').v2;

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    // SDK v2 appends a `?_a=` usage-analytics token to every URL it builds. It
    // is telemetry for Cloudinary, not for us, and it would be stored in the DB
    // and shipped in every review response. Off.
    urlAnalytics: false,
});

module.exports = cloudinary;

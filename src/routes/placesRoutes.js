

const express = require('express');
const router = express.Router();

const createRateLimit = require('../middleware/rateLimit');
const { geocodeAddress, USER_AGENT } = require('../utils/geocode');

const OLA_BASE = 'https://api.olamaps.io';
const MAX_INPUT_LENGTH = 200;
const UPSTREAM_TIMEOUT_MS = 10000;

const placesRateLimit = createRateLimit({
    windowMs: 60 * 1000,
    max: 180,
    keyGenerator: (req) => `places:${req.ip}`,
    message: 'Too many address lookups. Please slow down and try again shortly.',
});

router.use(placesRateLimit);

// GET /autocomplete?input=...
// → https://api.olamaps.io/places/v1/autocomplete?input=...&api_key=...
router.get('/autocomplete', async (req, res) => {
    const apiKey = process.env.OLA_MAPS_API_KEY;
    if (!apiKey) {
        console.error('[places] OLA_MAPS_API_KEY is not set  address autocomplete is disabled.');
        return res.status(503).json({ message: 'Address lookup is not configured on the server.' });
    }

    const input = req.query.input;
    if (typeof input !== 'string' || !input.trim()) {
        return res.status(400).json({ message: 'A non-empty "input" query parameter is required.' });
    }
    if (input.length > MAX_INPUT_LENGTH) {
        return res.status(400).json({ message: `"input" must be ${MAX_INPUT_LENGTH} characters or fewer.` });
    }

    const url =
        `${OLA_BASE}/places/v1/autocomplete?input=${encodeURIComponent(input.trim())}` +
        `&api_key=${encodeURIComponent(apiKey)}`;

    try {
        const upstream = await fetch(url, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });

        // Pass the body and status through untouched  the client parses Ola's
        // exact response shape.
        const text = await upstream.text();
        res.status(upstream.status)
            .type(upstream.headers.get('content-type') || 'application/json')
            .send(text);
    } catch (err) {
        console.error('[places] Ola autocomplete failed:', err.message);
        // Shape-compatible empty result so the dropdown degrades quietly.
        res.status(502).json({ predictions: [], message: 'Address lookup is temporarily unavailable.' });
    }
});


router.get('/geocode', async (req, res) => {
    const q = req.query.q;
    if (typeof q !== 'string' || !q.trim()) {
        return res.status(400).json({ message: 'A non-empty "q" query parameter is required.' });
    }
    if (q.length > MAX_INPUT_LENGTH) {
        return res.status(400).json({ message: `"q" must be ${MAX_INPUT_LENGTH} characters or fewer.` });
    }
    if (!USER_AGENT) {
        // GEOCODER_CONTACT is unset, so geocoding is off (see utils/geocode.js).
        // Shape-compatible empty result  the caller just gets no pin.
        return res.json({ lat: null, lng: null });
    }

    try {
        const coords = await geocodeAddress(q.trim());
        res.json({ lat: coords.lat, lng: coords.lng });
    } catch (err) {
        console.error('[places] geocode failed:', err.message);
        res.json({ lat: null, lng: null });
    }
});

module.exports = router;

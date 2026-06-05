// ─────────────────────────────────────────────────────────────────────────────
// Best-effort geocoding via OpenStreetMap Nominatim (free, no API key).
//
// Usage policy notes (https://operations.osmfoundation.org/policies/nominatim/):
//   • Max ~1 request/second — fine for occasional review submissions.
//   • A valid User-Agent / contact is REQUIRED. Update the email below.
//   • For high volume, self-host Nominatim or use a paid geocoder.
//
// Requires Node 18+ (global fetch). On older Node, install node-fetch.
// ─────────────────────────────────────────────────────────────────────────────

const geocodeAddress = async (address) => {
    try {
        const url =
            'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' +
            encodeURIComponent(address);

        const res = await fetch(url, {
            headers: {
                'User-Agent': 'RentReview/1.0 (your-email@example.com)', // ← change this
            },
        });

        if (!res.ok) return { lat: null, lng: null };

        const data = await res.json();
        if (Array.isArray(data) && data[0]) {
            return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
        }
    } catch (err) {
        console.warn('Geocoding failed:', err.message);
    }
    return { lat: null, lng: null };
};

module.exports = { geocodeAddress };
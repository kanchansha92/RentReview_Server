
const CONTACT = (process.env.GEOCODER_CONTACT || '').trim();
const USER_AGENT = CONTACT ? `RentReview/1.0 (${CONTACT})` : '';

if (!USER_AGENT) {
    console.warn(
        '⚠️  GEOCODER_CONTACT is not set — address geocoding is disabled. Set it to an email ' +
        'address or project URL so Nominatim requests can identify themselves (their usage ' +
        'policy requires it). Coordinates sent by the address picker are unaffected.'
    );
}

// One Nominatim lookup. Returns { lat, lng } with nulls when nothing matched.
const lookup = async (query) => {
    if (!USER_AGENT) return { lat: null, lng: null };
    try {
        const url =
            'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' +
            encodeURIComponent(query);

        const res = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(10000),
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

/**
 * @param {string} address                     full street address to resolve
 * @param {{city?:string, state?:string}|null} fallback  retried as "city, state"
 *        when the full address can't be resolved (callers have always passed
 *        this — the parameter was previously missing from the signature, so the
 *        fallback was silently dropped).
 * @returns {Promise<{lat:number|null, lng:number|null}>} — note this ALWAYS
 *          returns an object, so callers must test `coords.lat != null`, not
 *          the truthiness of the object itself.
 */
const geocodeAddress = async (address, fallback = null) => {
    const primary = await lookup(address);
    if (primary.lat != null) return primary;

    if (fallback && (fallback.city || fallback.state)) {
        const coarse = `${fallback.city || ''}, ${fallback.state || ''}`.replace(/^,\s*|,\s*$/g, '').trim();
        if (coarse) {
            const secondary = await lookup(coarse);
            if (secondary.lat != null) return secondary;
        }
    }

    return { lat: null, lng: null };
};

module.exports = { geocodeAddress, USER_AGENT };
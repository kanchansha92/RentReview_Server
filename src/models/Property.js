
const mongoose = require('mongoose');

// Normalise one address component: lowercase, strip punctuation, collapse spaces.
const normalizePart = (value) =>
    String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

// "123 Oak St." / "Austin" / "TX"  →  "123 oak st|austin|tx"
const buildAddressKey = (streetAddress, city, state) =>
    [normalizePart(streetAddress), normalizePart(city), normalizePart(state)].join('|');

const propertySchema = new mongoose.Schema(
    {
        title: { type: String, required: true, trim: true }, // e.g. "123 Oak Street"
        streetAddress: { type: String, required: true, trim: true },
        city: { type: String, required: true, trim: true },
        state: { type: String, required: true, trim: true },
        zipCode: { type: String, trim: true, default: '' },

        // Normalised "street|city|state"  the real identity of a physical address.
        // Set automatically by the pre-validate hook below; see the migration note
        // at the top of this file before deploying.
        // NOTE: no `index: true` here on purpose. The unique index is declared
        // once, below, via schema.index(). Declaring it in both places generates
        // two definitions with the same auto-generated name (`addressKey_1`) but
        // different options, which Mongo rejects with IndexOptionsConflict (85) 
        // the unique constraint then silently never gets created.
        addressKey: { type: String, trim: true },

        // Display string used by the cards / map popup, e.g. "Indiranagar, Bengaluru"
        location: { type: String, trim: true, default: '' },

        type: {
            type: String,
            enum: ['House', 'Apartment', 'Condo', 'Other'],
            default: 'Other',
        },
        price: { type: Number, default: null }, // rent per month
        image: { type: String, default: '' },

        // For the Leaflet map markers
        coords: {
            lat: { type: Number, default: null },
            lng: { type: Number, default: null },
        },

        // Aggregates, kept in sync whenever a review changes
        rating: { type: Number, default: 0 },
        reviewsCount: { type: Number, default: 0 },
    },
    { timestamps: true }
);

// Expose the normaliser to callers (reviewController builds the same key to do
// its find-or-create lookup).
propertySchema.statics.buildAddressKey = buildAddressKey;


propertySchema.pre('validate', function () {
    this.addressKey = buildAddressKey(this.streetAddress, this.city, this.state);
});

// One property record per physical address (used for find-or-create).
// `sparse` so legacy documents not yet backfilled (field missing) don't collide.
propertySchema.index({ addressKey: 1 }, { unique: true, sparse: true });


propertySchema.index(
    { streetAddress: 1, city: 1, state: 1 },
    { name: 'address_lookup_legacy' }
);

const Property = mongoose.model('Property', propertySchema);


Property.on('error', (err) => {
    console.error('Property index build error:', err.message);
});

module.exports = Property;
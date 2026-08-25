// ─────────────────────────────────────────────────────────────────────────────
// ⚠️  MANUAL MIGRATION REQUIRED ON THE DEPLOYED DATABASE  ⚠️
//
// Uniqueness moved from the raw { streetAddress, city, state } compound index to
// the normalised `addressKey`. Mongoose creates the new index on boot but it will
// NEVER drop the old one, so until you run this by hand the old unique index is
// still enforced and "123 Oak St" / "123 oak st" still create two documents:
//
//   1. Drop the old unique index (name may differ — check db.properties.getIndexes()):
//        db.properties.dropIndex('streetAddress_1_city_1_state_1')
//
//   2. Backfill every existing document with the key (same normalisation as
//      propertySchema.statics.buildAddressKey below):
//        db.properties.find({ addressKey: { $exists: false } }).forEach(function (p) {
//            var norm = function (s) {
//                return String(s || '').toLowerCase()
//                    .replace(/[^a-z0-9\s]/g, ' ')
//                    .replace(/\s+/g, ' ')
//                    .trim();
//            };
//            db.properties.updateOne(
//                { _id: p._id },
//                { $set: { addressKey: [norm(p.streetAddress), norm(p.city), norm(p.state)].join('|') } }
//            );
//        });
//
//   3. Deduplicate first if step 2 reports E11000 — two rows now normalise to the
//      same key. Merge their reviews onto the surviving property, then re-run.
//
// The unique index on `addressKey` is `sparse` so legacy documents that have not
// been backfilled yet (missing field) do not all collide on null.
// ─────────────────────────────────────────────────────────────────────────────

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

        // Normalised "street|city|state" — the real identity of a physical address.
        // Set automatically by the pre-validate hook below; see the migration note
        // at the top of this file before deploying.
        // NOTE: no `index: true` here on purpose. The unique index is declared
        // once, below, via schema.index(). Declaring it in both places generates
        // two definitions with the same auto-generated name (`addressKey_1`) but
        // different options, which Mongo rejects with IndexOptionsConflict (85) —
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

// Keep `addressKey` in sync with the address fields on every save.
propertySchema.pre('validate', function (next) {
    this.addressKey = buildAddressKey(this.streetAddress, this.city, this.state);
    next();
});

// One property record per physical address (used for find-or-create).
// `sparse` so legacy documents not yet backfilled (field missing) don't collide.
propertySchema.index({ addressKey: 1 }, { unique: true, sparse: true });

// Retained as a plain lookup index for the legacy fallback query. NOT unique any
// more — uniqueness lives on addressKey. The old UNIQUE version of this index is
// still present in the deployed database under the name
// `streetAddress_1_city_1_state_1`; redeclaring the same key pattern with
// different options would be another IndexOptionsConflict, so this one is given
// its own explicit name and the old one must be dropped by hand (see top).
propertySchema.index(
    { streetAddress: 1, city: 1, state: 1 },
    { name: 'address_lookup_legacy' }
);

const Property = mongoose.model('Property', propertySchema);

// Mongoose builds indexes in the background after connecting and emits 'error'
// on the model if one fails. With no listener attached that becomes an unhandled
// rejection, which Node 22 turns into a process exit — i.e. a bad index would
// take the whole API down instead of just logging. Keep the server up and make
// the problem visible.
Property.on('error', (err) => {
    console.error('Property index build error:', err.message);
});

module.exports = Property;
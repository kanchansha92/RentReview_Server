const mongoose = require('mongoose');

const propertySchema = new mongoose.Schema(
    {
        title: { type: String, required: true, trim: true }, // e.g. "123 Oak Street"
        streetAddress: { type: String, required: true, trim: true },
        city: { type: String, required: true, trim: true },
        state: { type: String, required: true, trim: true },
        zipCode: { type: String, trim: true, default: '' },

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

// One property record per physical address (used for find-or-create)
propertySchema.index({ streetAddress: 1, city: 1, state: 1 }, { unique: true });

module.exports = mongoose.model('Property', propertySchema);
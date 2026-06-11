const Property = require('../models/Property');
const Review = require('../models/Review');

// @desc    List properties (optional ?search= and ?type=)
// @route   GET /api/properties
// @access  Public
const getProperties = async (req, res) => {
    try {
        const { search, type } = req.query;
        const filter = {};

        if (type && type !== 'All Types') filter.type = type;

        if (search && search.trim()) {
            const rx = new RegExp(search.trim(), 'i');
            filter.$or = [{ title: rx }, { location: rx }, { city: rx }, { state: rx }];
        }

        const properties = await Property.find(filter).sort({ createdAt: -1 });
        res.json({ success: true, count: properties.length, properties });
    } catch (error) {
        console.error('Get properties error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

// @desc    Get one property + its reviews (for the detail / "View Details" page)
// @route   GET /api/properties/:id
// @access  Public
const getProperty = async (req, res) => {
    try {
        const property = await Property.findById(req.params.id);
        if (!property) return res.status(404).json({ message: 'Property not found.' });

        const reviews = await Review.find({ property: property._id }).sort({ createdAt: -1 });

        res.json({ success: true, property, reviews });
    } catch (error) {
        if (error.kind === 'ObjectId') {
            return res.status(404).json({ message: 'Property not found.' });
        }
        console.error('Get property error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

module.exports = { getProperties, getProperty };

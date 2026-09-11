const Property = require('../models/Property');
const Review = require('../models/Review');
// Hidden reviews (taken down after a complaint) must not appear here either.
const { VISIBLE_ONLY } = require('./reviewController');

// Longest search string we'll compile into a regex.
const MAX_SEARCH_LENGTH = 64;


const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');


const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;

const readPaging = (query = {}) => {
    const requested = Number(query.limit);
    const limit = Math.max(
        Math.min(Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
        1
    );
    const page = Math.max(Number(query.page) || 1, 1);
    return { page, limit, skip: (page - 1) * limit };
};

// @desc    List properties (optional ?search= and ?type=)
// @route   GET /api/properties
// @access  Public
const getProperties = async (req, res) => {
    try {
        const { search, type } = req.query;

     
        const filter = req.query.includeEmpty ? {} : { reviewsCount: { $gt: 0 } };

        if (type && type !== 'All Types') filter.type = type;

        if (typeof search === 'string' && search.trim()) {
            // Truncate first, then escape  a long or hostile pattern can't reach Mongo.
            const term = search.trim().slice(0, MAX_SEARCH_LENGTH);
            const rx = new RegExp(escapeRegex(term), 'i');
            filter.$or = [{ title: rx }, { location: rx }, { city: rx }, { state: rx }];
        }

        const { page, limit, skip } = readPaging(req.query);

        const [properties, total] = await Promise.all([
            Property.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
            Property.countDocuments(filter),
        ]);

        // `properties` stays a top-level key  the frontend reads it directly.
        // page/limit/total/totalPages are pure additions.
        res.json({
            success: true,
            count: properties.length,
            properties,
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit) || 0,
        });
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

        const { page, limit, skip } = readPaging(req.query);
        const reviewFilter = { property: property._id, ...VISIBLE_ONLY };

        const [reviews, total] = await Promise.all([
            Review.find(reviewFilter).sort({ createdAt: -1 }).skip(skip).limit(limit),
            Review.countDocuments(reviewFilter),
        ]);

        // `property` and `reviews` keep their existing shape; paging is additive.
        res.json({
            success: true,
            property,
            reviews,
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit) || 0,
        });
    } catch (error) {
        if (error.kind === 'ObjectId') {
            return res.status(404).json({ message: 'Property not found.' });
        }
        console.error('Get property error:', error.message);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
};

module.exports = { getProperties, getProperty };

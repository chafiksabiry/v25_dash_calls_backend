const mongoose = require('mongoose');

const gigSchema = new mongoose.Schema({
    title: {
        type: String,
        required: [true, 'Please add a title']
    },
    description: String,
    category: String,
    status: {
        type: String,
        default: 'active'
    }
}, { strict: false });

module.exports = mongoose.model('Gig', gigSchema);

const mongoose = require('mongoose');
const { config } = require('./env');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(config.MONGO_URI);
    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error('Error connecting to MongoDB:', error);
    // process.exit(1); // Do not exit process so api can return 500 error with CORS headers
  }
};

module.exports = { connectDB };
const mongoose = require('mongoose');
const { config } = require('./env');

const connectDB = async () => {
  try {
    const maskedUri = config.MONGODB_URI.replace(/\/\/.*:.*@/, '//****:****@');
    console.log(`🔌 Attempting to connect to MongoDB: ${maskedUri}`);

    const conn = await mongoose.connect(config.MONGODB_URI);
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error('❌ Error connecting to MongoDB:', error);
    // process.exit(1); 
  }
};

module.exports = { connectDB };
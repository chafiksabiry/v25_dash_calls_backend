const mongoose = require('mongoose');
const { config } = require('./env');

const connectDB = async () => {
  try {
    // Jamais l'adresse elle-même (elle contient le mot de passe) : seulement le nom de la variable.
    console.log(`🔌 Attempting to connect to MongoDB (variable ${config.MONGODB_URI_SOURCE || 'absente'})`);

    const conn = await mongoose.connect(config.MONGODB_URI);
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error('❌ Error connecting to MongoDB:', error);
    // process.exit(1); 
  }
};

module.exports = { connectDB };
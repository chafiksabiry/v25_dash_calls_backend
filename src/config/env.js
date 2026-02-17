require('dotenv').config();

const config = {
  PORT: process.env.PORT || 5006,
  MONGODB_URI: process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://mongo:DiGaBWUZXCkIxlZMuntztBaFJcOlUJIg@maglev.proxy.rlwy.net:40270/harx?authSource=admin',
  JWT_SECRET: process.env.JWT_SECRET || 'your-secret-key',
  JWT_EXPIRE: process.env.JWT_EXPIRE || '24h',
  NODE_ENV: process.env.NODE_ENV || 'pre-production'
};

module.exports = { config };
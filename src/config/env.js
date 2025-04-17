require('dotenv').config();

const config = {
  PORT: process.env.PORT || 5006,
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://harx:ix5S3vU6BjKn4MHp@207.180.226.2:27017/V25_HarxPreProd',
  JWT_SECRET: process.env.JWT_SECRET || 'your-secret-key',
  JWT_EXPIRE: process.env.JWT_EXPIRE || '24h',
  NODE_ENV: process.env.NODE_ENV || 'development'
};

module.exports = { config };
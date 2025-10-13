require('dotenv').config();

const config = {
  PORT: process.env.PORT || 5006,
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://harx:ix5S3vU6BjKn4MHp@207.180.226.2:27017/V25_HarxPreProd',
  JWT_SECRET: process.env.JWT_SECRET || 'your-secret-key',
  JWT_EXPIRE: process.env.JWT_EXPIRE || '24h',
  NODE_ENV: process.env.NODE_ENV || 'pre-production',
  // Telnyx configuration
  TELNYX_API_KEY: process.env.TELNYX_API_KEY,
  TELNYX_PUBLIC_KEY: process.env.TELNYX_PUBLIC_KEY, // For webhook signature verification
  TELNYX_APP_ID: process.env.TELNYX_APP_ID,
  // Base URL for webhooks
  BASE_URL: process.env.BASE_URL || 'http://localhost:5006',
  // Full webhook URL that Telnyx will call
  TELNYX_WEBHOOK_URL: process.env.TELNYX_WEBHOOK_URL || 'http://localhost:5006/api/calls/telnyx/webhook'
};

module.exports = { config };
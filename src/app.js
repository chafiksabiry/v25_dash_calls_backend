const express = require('express');
const cors = require('cors');
const { config } = require('./config/env');
const { connectDB } = require('./config/database');
const { errorHandler } = require('./middleware/error');
const http = require('http');
const setupSpeechToTextWebSocket = require('./websocket/speechToText');

// Route imports
const auth = require('./routes/auth');
const integrations = require('./routes/integrations');
const leads = require('./routes/leads');
const agents = require('./routes/agents');
const calls = require('./routes/calls');
const settings = require('./routes/settings');
const analytics = require('./routes/analytics');
const dashboard = require('./routes/dashboard');

// Connect to database
connectDB();

const app = express();

app.set('trust proxy', 1);

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Manual CORS Middleware
app.use((req, res, next) => {
  const allowedOrigins = [
    'http://localhost:5180',
    'http://localhost:5183',
    'https://v25-preprod.harx.ai',
    'https://preprod-api-dash-calls.harx.ai',
    'https://v25.harx.ai',
    'https://copilot.harx.ai',
    'http://38.242.208.242:5186',
    'http://localhost:5173',
    'https://harx25pageslinks.netlify.app'
  ];

  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

app.use(express.urlencoded({ extended: true }));

// Body parser
app.use(express.json());

// Mount routers
app.use('/api/auth', auth);
app.use('/api/integrations', integrations);
app.use('/api/leads', leads);
app.use('/api/agents', agents);
app.use('/api/calls', calls);
app.use('/api/settings', settings);
app.use('/api/analytics', analytics);
app.use('/api/dashboard', dashboard);

// Error handler
//app.use(errorHandler);

const PORT = config.PORT;

// Create HTTP server
const server = http.createServer(app);
//console.log("server",server);
// Set up WebSocket handler for speech-to-text
setupSpeechToTextWebSocket(server);

// Listen on server instead of app
server.listen(PORT, () => {
  console.log(`Server running in ${config.NODE_ENV} mode on port ${PORT}`);
}); 

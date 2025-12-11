const express = require('express');
const cors = require('cors');
const { config } = require('./config/env');
const { connectDB } = require('./config/database');
const { errorHandler } = require('./middleware/error');
const http = require('http');
const setupWebSocketManager = require('./websocket/wsManager');
const { setupTestWebSocket } = require('./websocket/testWebSocket');
const setupAudioStream = require('./websocket/audioStream');

// Route imports
const auth = require('./routes/auth');
const integrations = require('./routes/integrations');
const leads = require('./routes/leads');
const agents = require('./routes/agents');
const calls = require('./routes/calls');
const settings = require('./routes/settings');
const analytics = require('./routes/analytics');
const dashboard = require('./routes/dashboard');
const phoneNumbers = require('./routes/phoneNumbers');

// Connect to database
connectDB();

const app = express();

app.use(express.urlencoded({ extended: true }));

// Special handling for Telnyx webhooks - must come before JSON parser
app.use('/api/calls/telnyx/webhook', express.raw({ type: 'application/json' }));

// Body parser for all other routes
app.use(express.json());

app.use(cors({
  origin: [
    'http://localhost:5180',
    'http://localhost:5183',
    'http://localhost:5186',
    'https://v25-preprod.harx.ai',
    'https://api-dash-calls.harx.ai',
    'https://api-calls.harx.ai',
    'https://v25.harx.ai',
    'https://copilot.harx.ai',
    'http://38.242.208.242:5186',
    'http://localhost:5173',
    'http://localhost:3000'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization',
    'Upgrade',
    'Connection',
    'Sec-WebSocket-Key',
    'Sec-WebSocket-Version',
    'Sec-WebSocket-Extensions',
    'Sec-WebSocket-Protocol'
  ],
  credentials: true
}));

// Mount routers
app.use('/api/auth', auth);
app.use('/api/integrations', integrations);
app.use('/api/leads', leads);
app.use('/api/agents', agents);
app.use('/api/calls', calls);
app.use('/api/settings', settings);
app.use('/api/analytics', analytics);
app.use('/api/dashboard', dashboard);
app.use('/api/phone-numbers', phoneNumbers);

const PORT = config.PORT;

// Create HTTP server
const server = http.createServer(app);

// Listen on server instead of app
server.listen(PORT, () => {
  console.log(`Server running in ${config.NODE_ENV} mode on port ${PORT}`);
  
  // Initialize WebSocket manager
  const wsServers = setupWebSocketManager(server);
  
  // Setup individual WebSocket handlers
  setupTestWebSocket(wsServers.get('callEvents'));
  setupAudioStream(wsServers.get('audioStream'));
  
  console.log('WebSocket servers initialized');
}); 
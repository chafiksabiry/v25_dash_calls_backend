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

// Ensure models are registered
require('./models/Call');
require('./models/Agent');
require('./models/Lead');

// Connect to database
connectDB();

const app = express();

app.set('trust proxy', 1);

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// CORS configuration
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

app.use(cors({
  origin: function (origin, callback) {
    // allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

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

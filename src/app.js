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

app.use(express.urlencoded({ extended: true }));

// Body parser
app.use(express.json());

//app.use(cors());
// Enable CORS with specific configuration
app.use(cors({
  origin: ['https://v25-preprod.harx.ai', 'https://preprod-api-dash-calls.harx.ai','https://v25.harx.ai'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
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

// Error handler
//app.use(errorHandler);

const PORT = config.PORT;

// Create HTTP server
const server = http.createServer(app);
console.log("server",server);
// Set up WebSocket handler for speech-to-text
setupSpeechToTextWebSocket(server);

// Listen on server instead of app
server.listen(PORT, () => {
  console.log(`Server running in ${config.NODE_ENV} mode on port ${PORT}`);
}); 

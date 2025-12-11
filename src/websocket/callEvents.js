const WebSocket = require('ws');

// Store connected clients
const clients = new Set();

function setupCallEventsWebSocket(server) {
  const wss = new WebSocket.Server({ 
    server, 
    path: '/call-events',
    verifyClient: (info) => {
      // Log connection attempt details
      console.log('WebSocket connection attempt from:', info.origin);
      console.log('Request URL:', info.req.url);
      console.log('Headers:', info.req.headers);
      
      // Accept connections from Postman and other allowed origins
      const allowedOrigins = [
        'postman',
        'http://localhost:5180',
        'http://localhost:5183',
        'https://v25-preprod.harx.ai',
        'https://api-dash-calls.harx.ai',
        'https://v25.harx.ai',
        'https://copilot.harx.ai',
        'http://38.242.208.242:5186',
        'http://localhost:5173',
        'http://localhost:3000'
      ];

      // Pour Postman, l'origine peut être undefined ou contenir "postman"
      if (!info.origin || info.origin.toLowerCase().includes('postman')) {
        return true;
      }

      // Pour les autres clients, vérifier si l'origine est autorisée
      return allowedOrigins.includes(info.origin);
    }
  });
  
  console.log('📞 WebSocket server initialized at /call-events');

  wss.on('connection', (ws) => {
    console.log('Client connected to call-events WebSocket');
    
    // Add client to the set
    clients.add(ws);

    ws.on('close', () => {
      console.log('Client disconnected from call-events WebSocket');
      clients.delete(ws);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      clients.delete(ws);
    });
  });
}

// Function to broadcast call events to all connected clients
function broadcastCallEvent(event) {
  const eventData = {
    type: event.data.event_type,
    id: event.data.id,
    occurredAt: event.data.occurred_at,
    payload: event.data.payload
  };

  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(eventData));
    }
  });
}

module.exports = {
  setupCallEventsWebSocket,
  broadcastCallEvent
};
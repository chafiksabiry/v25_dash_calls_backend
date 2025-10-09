const WebSocket = require('ws');

// Store connected clients
const clients = new Set();

function setupTestWebSocket(server) {
  const wss = new WebSocket.Server({ 
    server,
    path: '/call-events'  // Gardons le même chemin
  });

  console.log('📞 WebSocket server initialized at /call-events');

  wss.on('connection', (ws) => {
    console.log('👋 New client connected to call events WebSocket');
    clients.add(ws);

    // Send welcome message immediately
    ws.send(JSON.stringify({
      type: 'welcome',
      message: 'Connected to call events WebSocket'
    }));

    // Handle client disconnect
    ws.on('close', () => {
      console.log('👋 Client disconnected from call events WebSocket');
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
  console.log(`📢 Broadcasting call event to ${clients.size} clients`);
  
  const eventData = {
    type: event.data.event_type,
    callId: event.data.payload.call_control_id,
    status: event.data.event_type.replace('call.', ''),
    timestamp: event.data.occurred_at,
    details: {
      from: event.data.payload.from,
      to: event.data.payload.to,
      direction: event.data.payload.direction,
      duration: event.data.payload.duration_seconds
    }
  };

  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(eventData));
    }
  });
}

module.exports = {
  setupTestWebSocket,
  broadcastCallEvent
};
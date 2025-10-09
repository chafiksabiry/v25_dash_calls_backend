const WebSocket = require('ws');

// Store connected clients
const clients = new Set();

function setupTestWebSocket(wsServer) {
  wsServer.on('connection', (ws) => {
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
    id: event.data.id,
    occurred_at: event.data.occurred_at,
    payload: event.data.payload
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
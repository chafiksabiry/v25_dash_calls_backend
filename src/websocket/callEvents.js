const WebSocket = require('ws');

// Store connected clients
const clients = new Set();

function setupCallEventsWebSocket(server) {
  const wss = new WebSocket.Server({ 
    server,
    path: '/call-events'
  });

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

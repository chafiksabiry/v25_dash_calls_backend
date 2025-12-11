const WebSocket = require('ws');

// Store connected clients
const clients = new Set();

function setupTestWebSocket(wsServer) {
  wsServer.on('connection', (ws, request) => {
    console.log('👋 New client connected to call events WebSocket');
    console.log('   Origin:', request.headers.origin);
    console.log('   User-Agent:', request.headers['user-agent']);
    
    clients.add(ws);

    // Send welcome message immediately
    try {
      ws.send(JSON.stringify({
        type: 'welcome',
        message: 'Connected to call events WebSocket'
      }));
      console.log('✅ Welcome message sent to client');
    } catch (error) {
      console.error('❌ Error sending welcome message:', error);
    }

    // Handle client disconnect
    ws.on('close', (code, reason) => {
      console.log('👋 Client disconnected from call events WebSocket', { code, reason: reason.toString() });
      clients.delete(ws);
    });

    ws.on('error', (error) => {
      console.error('❌ WebSocket error:', error);
      clients.delete(ws);
    });

    ws.on('message', (message) => {
      console.log('📨 Received message from client:', message.toString());
    });
  });
  
  wsServer.on('error', (error) => {
    console.error('❌ WebSocket server error:', error);
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
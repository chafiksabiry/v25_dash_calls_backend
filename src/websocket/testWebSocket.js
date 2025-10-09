const WebSocket = require('ws');

function setupTestWebSocket(server) {
  const wss = new WebSocket.Server({ 
    server,
    path: '/test-ws'
  });

  console.log('🔧 Test WebSocket initialized at /test-ws');

  wss.on('connection', (ws) => {
    console.log('👋 New client connected to test WebSocket');

    // Send welcome message immediately
    ws.send(JSON.stringify({
      type: 'welcome',
      message: 'Bonjour! Connection established successfully!'
    }));

    // Handle incoming messages
    ws.on('message', (data) => {
      try {
        console.log('📩 Received:', data.toString());
        
        // Echo back the message
        ws.send(JSON.stringify({
          type: 'echo',
          message: `Server received: ${data.toString()}`
        }));
      } catch (error) {
        console.error('Error handling message:', error);
      }
    });

    // Handle client disconnect
    ws.on('close', () => {
      console.log('👋 Client disconnected from test WebSocket');
    });
  });
}

module.exports = setupTestWebSocket;

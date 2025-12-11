const WebSocket = require('ws');

function setupWebSocketManager(server) {
  // Map to store different WebSocket servers
  const wsServers = new Map();

  // Setup Call Events WebSocket
  const callEventsWss = new WebSocket.Server({
    noServer: true // Important: let the HTTP server handle upgrade
  });

  // Setup Audio Stream WebSocket
  const audioStreamWss = new WebSocket.Server({
    noServer: true // Important: let the HTTP server handle upgrade
  });

  // Handle upgrade manually
  server.on('upgrade', (request, socket, head) => {
    try {
      const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
      
      console.log('🔌 WebSocket upgrade request:', {
        pathname,
        origin: request.headers.origin,
        host: request.headers.host,
        url: request.url
      });

      if (pathname === '/call-events') {
        console.log('✅ Upgrading to call-events WebSocket');
        callEventsWss.handleUpgrade(request, socket, head, (ws) => {
          callEventsWss.emit('connection', ws, request);
        });
      } else if (pathname === '/audio-stream') {
        console.log('✅ Upgrading to audio-stream WebSocket');
        audioStreamWss.handleUpgrade(request, socket, head, (ws) => {
          audioStreamWss.emit('connection', ws, request);
        });
      } else {
        console.log('❌ Unknown WebSocket path:', pathname);
        socket.destroy();
      }
    } catch (error) {
      console.error('❌ Error handling WebSocket upgrade:', error);
      socket.destroy();
    }
  });

  // Store WebSocket servers
  wsServers.set('callEvents', callEventsWss);
  wsServers.set('audioStream', audioStreamWss);

  return wsServers;
}

module.exports = setupWebSocketManager;

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
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

    if (pathname === '/call-events') {
      callEventsWss.handleUpgrade(request, socket, head, (ws) => {
        callEventsWss.emit('connection', ws, request);
      });
    } else if (pathname === '/audio-stream') {
      audioStreamWss.handleUpgrade(request, socket, head, (ws) => {
        audioStreamWss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // Store WebSocket servers
  wsServers.set('callEvents', callEventsWss);
  wsServers.set('audioStream', audioStreamWss);

  return wsServers;
}

module.exports = setupWebSocketManager;

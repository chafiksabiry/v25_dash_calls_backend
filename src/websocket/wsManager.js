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
        url: request.url,
        upgrade: request.headers.upgrade,
        connection: request.headers.connection,
        'sec-websocket-key': request.headers['sec-websocket-key'] ? 'present' : 'missing',
        'sec-websocket-version': request.headers['sec-websocket-version']
      });

      // Verify WebSocket upgrade headers
      if (request.headers.upgrade?.toLowerCase() !== 'websocket') {
        console.warn('⚠️ Invalid upgrade header:', request.headers.upgrade);
      }

      // Normalize pathname (remove /api prefix if present, as nginx may add it)
      let normalizedPath = pathname;
      if (pathname.startsWith('/api/')) {
        normalizedPath = pathname.replace('/api', '');
      }

      if (normalizedPath === '/call-events' || pathname === '/call-events' || pathname === '/api/call-events') {
        console.log('✅ Upgrading to call-events WebSocket');
        callEventsWss.handleUpgrade(request, socket, head, (ws) => {
          callEventsWss.emit('connection', ws, request);
        });
      } else if (normalizedPath === '/audio-stream' || normalizedPath === '/audio-stream' || 
                 pathname === '/audio-stream' || pathname === '/audio-stream' ||
                 pathname === '/api/audio-stream' || pathname === '/api/audio-stream') {
        console.log('✅ Upgrading to audio-stream WebSocket (path:', pathname, ', normalized:', normalizedPath, ')');
        try {
          audioStreamWss.handleUpgrade(request, socket, head, (ws) => {
            console.log('✅ WebSocket upgrade completed, emitting connection event');
            audioStreamWss.emit('connection', ws, request);
          });
        } catch (upgradeError) {
          console.error('❌ Error during WebSocket upgrade:', upgradeError);
          console.error('Upgrade error stack:', upgradeError.stack);
          socket.destroy();
        }
      } else {
        console.log('❌ Unknown WebSocket path:', pathname);
        console.log('Available paths: /call-events, /api/call-events, /audio-stream, /audio-stream, /api/audio-stream, /api/audio-stream');
        socket.destroy();
      }
    } catch (error) {
      console.error('❌ Error handling WebSocket upgrade:', error);
      console.error('Error stack:', error.stack);
      socket.destroy();
    }
  });

  // Store WebSocket servers
  wsServers.set('callEvents', callEventsWss);
  wsServers.set('audioStream', audioStreamWss);

  return wsServers;
}

module.exports = setupWebSocketManager;

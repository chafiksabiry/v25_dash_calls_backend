const WebSocket = require('ws');

// Store connected frontend clients
const clients = new Set();

function broadcastToClients(message, excludeWs = null) {
  const connectedClients = clients.size;
  console.log(`📢 Broadcasting to ${connectedClients} frontend clients`);

  clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      if (message instanceof Buffer) {
        client.send(message);
      } else {
        client.send(JSON.stringify(message));
      }
    }
  });
}

function setupFrontendAudioStream(wsServer) {
  wsServer.on('connection', (ws, req) => {
    try {
      console.log('👤 Frontend client connected to audio stream');
      clients.add(ws);

      // Envoyer la configuration initiale
      ws.send(JSON.stringify({ 
        event: 'connected',
        message: 'Connected to audio stream',
        config: {
          format: 'PCMU',
          sampleRate: 8000,
          channels: 1
        }
      }));

      ws.on('close', () => {
        console.log('👤 Frontend client disconnected');
        clients.delete(ws);
      });

      ws.on('error', (error) => {
        console.error('❌ Frontend WebSocket error:', error);
        clients.delete(ws);
      });

    } catch (error) {
      console.error('❌ Error in frontend audio stream connection:', error);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          event: 'error',
          payload: { code: 100002, title: 'Connection error', detail: error.message }
        }));
        ws.close();
      }
    }
  });

  return {
    broadcastToClients,
    getConnectedClients: () => clients.size
  };
}

module.exports = setupFrontendAudioStream;

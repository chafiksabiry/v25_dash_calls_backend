const WebSocket = require('ws');

// Store audio stream clients with their call IDs
const audioClients = new Map(); // Map<callId, WebSocket>

function setupAudioStream(wsServer) {
  wsServer.on('connection', (ws, req) => {
    try {
      // Get callId from URL parameters
      const url = new URL(req.url, `http://${req.headers.host}`);
      const callId = url.searchParams.get('callId');
      
      console.log('🎧 Attempting audio stream connection for call:', callId);
      console.log('URL:', req.url);
      console.log('Query params:', url.searchParams.toString());

      // Accepter même sans callId pour le test
      const streamId = callId || 'test-stream';
      
      // Add to clients map
      audioClients.set(streamId, ws);
      console.log(`🎧 Audio stream connected for: ${streamId}`);
      console.log('Current active streams:', audioClients.size);

      // Send confirmation
      ws.send(JSON.stringify({
        type: 'audio.connected',
        streamId: streamId,
        message: 'Audio stream connected successfully'
      }));

      // Handle messages
      ws.on('message', (data) => {
        try {
          console.log(`📥 Received audio message for stream ${streamId}`);
          // Pour le test, on peut faire écho du message
          ws.send(data);
        } catch (error) {
          console.error('Error handling message:', error);
        }
      });

      // Handle client disconnect
      ws.on('close', (code, reason) => {
        console.log(`🔇 Audio stream disconnected for: ${streamId}`, { code, reason });
        audioClients.delete(streamId);
        console.log('Remaining active streams:', audioClients.size);
      });

      // Handle errors
      ws.on('error', (error) => {
        console.error(`❌ Audio stream error for ${streamId}:`, error);
        audioClients.delete(streamId);
      });

    } catch (error) {
      console.error('❌ Error in audio stream connection:', error);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'audio.error',
          message: 'Failed to establish audio stream'
        }));
        ws.close();
      }
    }
  });

  // Fonctions utilitaires pour gérer les streams
  return {
    // Envoyer des données audio à un client spécifique
    sendAudioData: (streamId, audioData) => {
      const client = audioClients.get(streamId);
      if (client && client.readyState === WebSocket.OPEN) {
        try {
          client.send(audioData);
          return true;
        } catch (error) {
          console.error(`Error sending audio data for stream ${streamId}:`, error);
          return false;
        }
      }
      return false;
    },

    // Vérifier si un stream est actif
    hasActiveStream: (streamId) => {
      const client = audioClients.get(streamId);
      return client && client.readyState === WebSocket.OPEN;
    },

    // Obtenir le nombre de streams actifs
    getActiveStreamsCount: () => {
      return audioClients.size;
    },

    // Fermer un stream spécifique
    closeStream: (streamId) => {
      const client = audioClients.get(streamId);
      if (client) {
        client.close();
        audioClients.delete(streamId);
        return true;
      }
      return false;
    },

    // Fermer tous les streams
    closeAllStreams: () => {
      audioClients.forEach((client, streamId) => {
        client.close();
        audioClients.delete(streamId);
      });
    }
  };
}

module.exports = setupAudioStream;
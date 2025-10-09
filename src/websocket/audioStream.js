const WebSocket = require('ws');

function setupAudioStream(wsServer) {
  wsServer.on('connection', (ws, req) => {
    try {
      console.log('🎧 New audio stream connection');

      // Envoyer l'événement de connexion selon la doc Telnyx
      ws.send(JSON.stringify({ 
        event: "connected", 
        version: "1.0.0"
      }));

      // Handle incoming messages from Telnyx
      ws.on('message', (data) => {
        try {
          // Essayer de parser comme JSON d'abord
          const messageStr = data.toString();
          const message = JSON.parse(messageStr);
          console.log(`📥 Received WebSocket message type: ${message.event}`);

          switch (message.event) {
            case 'start':
              // Message de début de stream avec les infos de format
              console.log('🎵 Stream starting:', {
                streamId: message.stream_id,
                mediaFormat: message.start.media_format
              });

              // Envoyer une confirmation au client
              ws.send(JSON.stringify({
                event: 'start',
                sequence_number: message.sequence_number,
                stream_id: message.stream_id,
                start: message.start
              }));
              break;

            case 'media':
              // Vérifier que le message a le bon format
              if (!message.media || !message.media.payload) {
                console.error('Invalid media message format:', message);
                return;
              }

              // Envoyer le message media tel quel
              ws.send(JSON.stringify({
                event: 'media',
                sequence_number: message.sequence_number,
                stream_id: message.stream_id,
                media: message.media
              }));
              break;

            case 'stop':
              console.log('🛑 Stream stopping:', message);
              ws.send(JSON.stringify(message));
              break;

            case 'error':
              console.error('❌ Stream error:', message);
              ws.send(JSON.stringify(message));
              break;

            default:
              console.log('📥 Unknown event type:', message.event);
          }
        } catch (error) {
          console.error('Error processing message:', error);
        }
      });

      // Handle client disconnect
      ws.on('close', (code, reason) => {
        console.log(`🔇 Audio stream disconnected`, { code, reason });
      });

      // Handle errors
      ws.on('error', (error) => {
        console.error(`❌ Audio stream error:`, error);
      });

    } catch (error) {
      console.error('❌ Error in audio stream connection:', error);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          event: 'error',
          payload: {
            code: 100002,
            title: 'Connection error',
            detail: error.message
          }
        }));
        ws.close();
      }
    }
  });
}

module.exports = setupAudioStream;
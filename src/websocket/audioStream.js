const WebSocket = require('ws');

// Store connected clients
const clients = new Set();
let telnyxConnection = null;

function broadcastToClients(message, excludeWs = null) {
  const connectedClients = clients.size;
  console.log(`📢 Broadcasting to ${connectedClients} clients`);

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

function setupAudioStream(wsServer) {
  wsServer.on('connection', (ws, req) => {
    try {
      const isTelnyx = req.headers['user-agent']?.toLowerCase().includes('telnyx') || 
                      req.headers['x-telnyx-signature'];

      if (isTelnyx) {
        console.log('🎧 Telnyx audio stream connected');
        telnyxConnection = ws;

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
            let message;
            try {
              message = JSON.parse(messageStr);
              console.log(`📥 Received Telnyx message type: ${message.event}`);

              switch (message.event) {
                case 'start':
                  console.log('🎵 Stream starting:', {
                    streamId: message.stream_id,
                    mediaFormat: message.start.media_format
                  });
                  broadcastToClients(message);
                  break;

                case 'media':
                  if (!message.media || !message.media.payload) {
                    console.error('Invalid media message format:', message);
                    return;
                  }

                  // Log détaillé du message media
                  console.log('📊 Media message details:', {
                    sequence: message.sequence_number,
                    streamId: message.stream_id,
                    timestamp: message.media.timestamp,
                    track: message.media.track,
                    payloadLength: message.media.payload.length
                  });

                  try {
                    // Décoder le payload base64 en buffer
                    const audioBuffer = Buffer.from(message.media.payload, 'base64');
                    
                    // Log des premiers octets pour debug
                    console.log('🎵 First 8 bytes:', Array.from(audioBuffer.slice(0, 8)));
                    console.log('📦 Buffer size:', audioBuffer.length);
                    
                    // Vérifier que c'est bien du PCMU (µ-law)
                    const isValidPCMU = audioBuffer.every(byte => byte <= 255);
                    if (!isValidPCMU) {
                      console.error('❌ Invalid PCMU data detected');
                      return;
                    }

                    // Envoyer les métadonnées avec plus d'informations
                    broadcastToClients({
                      event: 'media',
                      sequence_number: message.sequence_number,
                      stream_id: message.stream_id,
                      media: {
                        ...message.media,
                        format: 'PCMU',
                        sampleRate: 8000,
                        channels: 1,
                        size: audioBuffer.length,
                        timestamp: Date.now()
                      }
                    });

                    // Envoyer le buffer audio
                    broadcastToClients(audioBuffer);
                    console.log('✅ Audio chunk broadcasted successfully');
                  } catch (error) {
                    console.error('❌ Error processing audio data:', error);
                  }
                  break;

                case 'stop':
                  console.log('🛑 Stream stopping:', message);
                  broadcastToClients(message);
                  break;

                case 'error':
                  console.error('❌ Stream error:', message);
                  broadcastToClients(message);
                  break;

                default:
                  console.log('📥 Unknown event type:', message.event);
              }
            } catch (parseError) {
              // Si ce n'est pas du JSON, c'est probablement des données binaires
              console.log('📦 Received binary data');
              broadcastToClients(data);
            }
          } catch (error) {
            console.error('Error processing message:', error);
          }
        });

        ws.on('close', () => {
          console.log('🔇 Telnyx connection closed');
          telnyxConnection = null;
        });

      } else {
        console.log('👤 Frontend client connected to audio stream');
        clients.add(ws);

        // Envoyer un message de bienvenue au client frontend
        ws.send(JSON.stringify({
          event: 'connected',
          message: 'Connected to audio stream'
        }));

        ws.on('close', () => {
          console.log('👤 Frontend client disconnected');
          clients.delete(ws);
        });
      }

      // Handle errors for all connections
      ws.on('error', (error) => {
        console.error(`❌ WebSocket error:`, error);
        if (isTelnyx) {
          telnyxConnection = null;
        } else {
          clients.delete(ws);
        }
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
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

// Convert Float32 audio samples to PCMU 8-bit µ-law
function float32ToPCMU(float32Array) {
  const pcmu = new Uint8Array(float32Array.length);
  const MU = 255;
  for (let i = 0; i < float32Array.length; i++) {
    let sample = Math.max(-1, Math.min(1, float32Array[i]));
    const sign = sample < 0 ? 0x80 : 0;
    sample = Math.abs(sample);
    const magnitude = Math.log1p(MU * sample) / Math.log1p(MU);
    pcmu[i] = sign | (magnitude * 127 & 0x7F);
  }
  return pcmu;
}

function setupAudioStream(wsServer) {
  wsServer.on('connection', (ws, req) => {
    try {
      const isTelnyx = req.headers['user-agent']?.toLowerCase().includes('telnyx') || 
                        req.headers['x-telnyx-signature'];

      if (isTelnyx) {
        console.log('🎧 Telnyx audio stream connected');
        telnyxConnection = ws;

        ws.send(JSON.stringify({ event: "connected", version: "1.0.0" }));

        ws.on('message', (data) => {
          try {
            const messageStr = data.toString();
            let message;
            try {
              message = JSON.parse(messageStr);
              switch (message.event) {
                case 'start':
                  console.log('🎵 Stream starting:', message.stream_id, message.start.media_format);
                  broadcastToClients(message);
                  break;

                case 'media':
                  if (!message.media?.payload) return;
                  const audioBuffer = Buffer.from(message.media.payload, 'base64');
                  broadcastToClients(audioBuffer);
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
                  break;

                case 'stop':
                case 'error':
                  broadcastToClients(message);
                  break;
              }
            } catch {
              // Binary data from Telnyx
              broadcastToClients(data);
            }
          } catch (err) {
            console.error('Error processing Telnyx message:', err);
          }
        });

        ws.on('close', () => { telnyxConnection = null; });

      } else {
        console.log('👤 Frontend client connected to audio stream');
        clients.add(ws);

        ws.send(JSON.stringify({ event: 'connected', message: 'Connected to audio stream' }));

        // === Partie Frontend -> Telnyx ===
        ws.on('message', async (data) => {
          try {
            if (telnyxConnection?.readyState !== WebSocket.OPEN) return;

            if (typeof data === 'string') {
              const message = JSON.parse(data);
              if (message.event === 'media' && message.media?.payload) {
                // Ici tu assumes que le frontend a déjà envoyé en PCMU base64
                telnyxConnection.send(JSON.stringify({
                  event: 'media',
                  media: { payload: message.media.payload }
                }));
              }
            } else if (data instanceof Buffer) {
              // Si le frontend envoie brut, tu convertis en PCMU + base64
              // ⚠️ idéalement, le frontend doit déjà encoder en PCMU
              const float32Samples = new Float32Array(data.buffer);
              const pcmuData = float32ToPCMU(float32Samples);
              const base64Payload = Buffer.from(pcmuData).toString('base64');

              telnyxConnection.send(JSON.stringify({
                event: 'media',
                media: { payload: base64Payload }
              }));
            }
          } catch (err) {
            console.error('❌ Error forwarding frontend audio to Telnyx:', err);
          }
        });
        // === Fin partie Frontend -> Telnyx ===

        ws.on('close', () => { clients.delete(ws); });
      }

      ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error);
        if (isTelnyx) telnyxConnection = null;
        else clients.delete(ws);
      });

    } catch (error) {
      console.error('❌ Error in audio stream connection:', error);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          event: 'error',
          payload: { code: 100002, title: 'Connection error', detail: error.message }
        }));
        ws.close();
      }
    }
  });
}

module.exports = setupAudioStream;
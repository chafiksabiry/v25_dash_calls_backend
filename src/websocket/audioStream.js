const WebSocket = require('ws');

// Store connected clients
const clients = new Set();
let telnyxConnection = null;

// Counter for logging frequency (only log every N broadcasts)
let broadcastLogCounter = 0;
const BROADCAST_LOG_INTERVAL = 100; // Log every 100 broadcasts

function broadcastToClients(message, excludeWs = null) {
  const connectedClients = clients.size;
  
  // Only log if there are clients connected, and only periodically for media messages
  if (connectedClients > 0) {
    broadcastLogCounter++;
    if (broadcastLogCounter % BROADCAST_LOG_INTERVAL === 0 || !(message instanceof Buffer)) {
      // Log non-buffer messages (events) always, buffer messages (audio) only periodically
      console.log(`📢 Broadcasting to ${connectedClients} clients${message instanceof Buffer ? ' (audio data)' : ''}`);
    }
  } else {
    // Only log warning if trying to broadcast when no clients (but not for every media packet)
    if (!(message instanceof Buffer)) {
      console.warn(`⚠️ Attempting to broadcast to 0 clients:`, message.event || 'unknown event');
    }
    return; // Early return if no clients
  }

  let sentCount = 0;
  clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      try {
        if (message instanceof Buffer) {
          client.send(message);
        } else {
          client.send(JSON.stringify(message));
        }
        sentCount++;
      } catch (err) {
        console.error('❌ Error sending to client:', err);
        // Remove dead client
        clients.delete(client);
      }
    }
  });
  
  // Log if we tried to send but couldn't reach any clients
  if (sentCount === 0 && connectedClients > 0) {
    console.warn(`⚠️ No clients received broadcast (all may be disconnected)`);
  }
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
      console.log('🔌 WebSocket upgrade request received in audioStream handler');
      console.log('📋 Request details:', {
        pathname: req.url,
        origin: req.headers.origin,
        host: req.headers.host,
        userAgent: req.headers['user-agent'],
        upgrade: req.headers.upgrade,
        connection: req.headers.connection
      });
      
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
                  // Détecter le codec depuis le message Telnyx
                  const mediaFormat = message.start?.media_format;
                  const codec = mediaFormat?.encoding || 'PCMU'; // Par défaut PCMU
                  const sampleRate = mediaFormat?.sample_rate || 8000;
                  console.log(`🎵 Detected codec: ${codec}, sample rate: ${sampleRate}Hz`);
                  broadcastToClients(message);
                  break;

                case 'media':
                  if (!message.media?.payload) return;
                  const audioBuffer = Buffer.from(message.media.payload, 'base64');
                  
                  // Only broadcast audio buffer if there are clients connected
                  if (clients.size > 0) {
                    broadcastToClients(audioBuffer);
                    
                    // Also send metadata (less frequently - only every 10th packet to reduce overhead)
                    if (message.sequence_number % 10 === 0) {
                      const detectedCodec = message.media?.format || 'PCMU';
                      const detectedSampleRate = message.media?.sample_rate || 8000;
                      broadcastToClients({
                        event: 'media',
                        sequence_number: message.sequence_number,
                        stream_id: message.stream_id,
                        media: {
                          ...message.media,
                          format: detectedCodec,
                          sampleRate: detectedSampleRate,
                          channels: 1,
                          size: audioBuffer.length,
                          timestamp: Date.now()
                        }
                      });
                    }
                  }
                  break;

                case 'stop':
                case 'error':
                  broadcastToClients(message);
                  break;
              }
            } catch {
              // Binary data from Telnyx - only broadcast if clients connected
              if (clients.size > 0) {
                broadcastToClients(data);
              }
            }
          } catch (err) {
            console.error('Error processing Telnyx message:', err);
          }
        });

        ws.on('close', () => { telnyxConnection = null; });

      } else {
        console.log('👤 Frontend client connected to audio stream');
        console.log('📋 Connection details:', {
          remoteAddress: req.socket.remoteAddress,
          remotePort: req.socket.remotePort,
          origin: req.headers.origin,
          userAgent: req.headers['user-agent'],
          totalClients: clients.size + 1,
          pathname: req.url
        });
        clients.add(ws);

        // Send welcome message immediately with config
        try {
          // Get current stream config from Telnyx if available
          const config = {
            codec: 'PCMU', // Default codec
            sampleRate: 8000, // Default sample rate
            channels: 1
          };
          
          // If we have a Telnyx connection and know the codec, use it
          // (This will be updated when Telnyx sends the 'start' event)
          
          ws.send(JSON.stringify({ 
            event: 'connected', 
            message: 'Connected to audio stream',
            config: config
          }));
          console.log('✅ Welcome message sent to frontend client');
        } catch (sendError) {
          console.error('❌ Error sending welcome message:', sendError);
        }

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
const WebSocket = require('ws');
const vertexAIService = require('../services/vertexai.service');

function setupSpeechToTextWebSocket(server) {
  const wss = new WebSocket.Server({
    server,
    path: '/speech-to-text'
  });

  wss.on('connection', async (ws) => {
    console.log('✅ [STT] Client connected to Streaming Speech-to-Text (Google Cloud)');

    let recognizeStream = null;
    let isStreamOpen = false;

    // Default Config (Updated on first message if config provided)
    let requestConfig = {
      encoding: 'LINEAR16',
      sampleRateHertz: 16000,
      languageCode: 'fr-FR', // Default per user request (Maroc)
      enableAutomaticPunctuation: true,
      model: 'latest_long',
      useEnhanced: true,
      audioChannelCount: 2,
      enableSeparateRecognitionPerChannel: true,
      diarizationConfig: {
        enableSpeakerDiarization: false,
      },
    };

    let speechClient = null;
    try {
      speechClient = await vertexAIService.getSpeechClient();
    } catch (err) {
      console.error("❌ [STT] Failed to get SpeechClient:", err);
      ws.send(JSON.stringify({ type: 'error', message: 'Backend failed to initialize Speech Client' }));
      return;
    }

    const startStream = async () => {
      if (isStreamOpen) return;

      console.log(`🚀 [STT] Starting Google Cloud StreamingRecognize (${requestConfig.languageCode}, ${requestConfig.encoding})`);

      try {
        recognizeStream = await vertexAIService.createSpeechStream({
          ...requestConfig,
          interimResults: true
        });

        recognizeStream
          .on('error', (error) => {
            if (error.message && error.message.includes('Audio Timeout Error')) {
              console.log('ℹ️ [STT] Audio stream timed out (normal)');
              isStreamOpen = false;
              return;
            }
            console.error('❌ [STT] Google API Error:', error);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'error', message: error.message }));
            }
            isStreamOpen = false;
          })
          .on('data', (data) => {
            // Google can return multiple results in one message when using multichannel
            data.results.forEach((result) => {
              if (result.alternatives[0]) {
                const alternative = result.alternatives[0];
                const transcript = alternative.transcript;
                const channelTag = result.channelTag || result.channel_tag;

                // Only log and send non-empty transcripts (unless it's a final of a previously non-empty one)
                if (transcript.trim() === '') {
                  // If we get an empty final, it might mean the end of a segment
                  if (result.isFinal) {
                    console.log(`🗣️ [FINAL] (Channel ${channelTag}): <Empty/Silence>`);
                  }
                  return;
                }

                console.log(`🗣️ [${result.isFinal ? 'FINAL' : 'INTERIM'}] (Channel ${channelTag}): ${transcript}`);

                const message = {
                  type: result.isFinal ? 'final' : 'interim',
                  transcript: transcript,
                  confidence: alternative.confidence || 0.9,
                  isFinal: result.isFinal,
                  timestamp: Date.now(),
                  speaker: channelTag === 1 ? 'agent' : (channelTag === 2 ? 'customer' : undefined),
                  channelTag: channelTag
                };

                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify(message));
                }
              }
            });
          });

        isStreamOpen = true;
      } catch (err) {
        console.error("❌ [STT] Error starting recognize stream:", err);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: 'Failed to start speech stream' }));
        }
      }
    };

    ws.on('message', async (data) => {
      try {
        if (Buffer.isBuffer(data) || data instanceof Uint8Array || data instanceof ArrayBuffer) {
          // 🎤 Raw Audio (Simulation or Live Worklet) - usually LINEAR16 PCM
          if (!isStreamOpen) await startStream();
          if (recognizeStream && isStreamOpen) {
            const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
            // Log periodically to confirm data flow
            if (Math.random() < 0.01) {
              console.log(`🎤 [STT] Streaming binary audio: ${buffer.length} bytes`);
            }
            recognizeStream.write(buffer);
          }
        }
        else {
          // 📄 JSON Message (Config or Twilio Media)
          const message = JSON.parse(data.toString());

          if (message.type === 'config') {
            console.log("⚙️ [STT] Received Config:", message.config);
            // Merge config
            if (message.config) {
              requestConfig = { ...requestConfig, ...message.config };
              // Ensure model is robust if not specified
              if (!requestConfig.model) requestConfig.model = 'telephony';
            }
          }
          else if (message.event === 'media' && message.media && message.media.payload) {
            // 📞 Twilio Media Stream (Base64 MULAW usually)
            // Twilio sends mulaw 8000Hz. Ensure config matches or we assume default if not set.
            // If this is the start, we might need to update config to MULAW/8000
            if (!isStreamOpen) {
              // Auto-detect Twilio defaults if not explicitly configured
              if (requestConfig.sampleRateHertz === 16000) {
                console.log("⚠️ [STT] Auto-switching to Twilio defaults (MULAW / 8000Hz)");
                requestConfig.encoding = 'MULAW';
                requestConfig.sampleRateHertz = 8000;
              }
              await startStream();
            }

            if (recognizeStream && isStreamOpen) {
              // Google STT expects Buffer for audio content
              recognizeStream.write(Buffer.from(message.media.payload, 'base64'));
            }
          }
          else if (message.event === 'start') {
            console.log("📞 [STT] Twilio Stream Started:", message.start);
            // Could reset stream ID etc.
          }
          else if (message.event === 'stop') {
            console.log("🛑 [STT] Twilio Stream Stopped");
            if (recognizeStream) {
              recognizeStream.end();
              isStreamOpen = false;
            }
          }
        }
      } catch (error) {
        console.error('❌ [STT] Error processing message:', error);
      }
    });

    ws.on('close', () => {
      console.log('🔌 [STT] Client disconnected');
      if (recognizeStream) {
        recognizeStream.end();
        isStreamOpen = false;
      }
    });

    // Send initial connection success
    ws.send(JSON.stringify({ type: 'connected', message: 'Ready for streaming' }));
  });
}

module.exports = setupSpeechToTextWebSocket;
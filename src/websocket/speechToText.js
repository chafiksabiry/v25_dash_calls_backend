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
      model: 'telephony', // Optimized for phone calls (comparable to Chirp in V1)
      useEnhanced: true,
      diarizationConfig: {
        enableSpeakerDiarization: true,
        minSpeakerCount: 2,
        maxSpeakerCount: 2,
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
            console.error('❌ [STT] Google API Error:', error);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'error', message: error.message }));
            }
            isStreamOpen = false;
          })
          .on('data', (data) => {
            // Process STT Result
            if (data.results[0] && data.results[0].alternatives[0]) {
              const result = data.results[0];
              const alternative = result.alternatives[0];
              const transcript = alternative.transcript;

              // Console log for debug
              console.log(`🗣️ [${result.isFinal ? 'FINAL' : 'INTERIM'}]: ${transcript}`);

              const message = {
                type: result.isFinal ? 'final' : 'interim',
                transcript: transcript,
                confidence: alternative.confidence || 0.9,
                isFinal: result.isFinal,
                timestamp: Date.now(),
                speaker: result.channelTag === 1 ? 'agent' : (result.channelTag === 2 ? 'customer' : undefined)
              };

              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(message));
              }
            }
          });

        isStreamOpen = true;
      } catch (err) {
        console.error("❌ [STT] Error starting recognize stream:", err);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: 'Failed to start speech stream' }));
        }
      }
    };

    ws.on('message', (data) => {
      try {
        if (Buffer.isBuffer(data)) {
          // 🎤 Raw Audio (Simulation) - usually LINEAR16 PCM
          if (!isStreamOpen) startStream();
          if (recognizeStream && isStreamOpen) {
            recognizeStream.write(data);
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
              startStream();
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
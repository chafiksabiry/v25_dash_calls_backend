const WebSocket = require('ws');
const vertexAIService = require('../services/vertexai.service');

function setupSpeechToTextWebSocket(server) {
  const wss = new WebSocket.Server({
    server,
    path: '/speech-to-text'
  });
  // console.log("wss",wss);

  wss.on('connection', async (ws) => {
    console.log('✅ Client connected to speech-to-text WebSocket');
    let recognizeStream = null;
    let isStreamActive = false;
    let speechConfig = null;
    let fullTranscript = "";

    // Inform client that WebSocket is ready
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'connected', message: 'WebSocket connection established' }));
    }

    ws.on('message', async (data) => {
      try {
        // Initial STT stream setup if not already active
        if (!isStreamActive && !recognizeStream) {
          try {
            console.log('🎤 Starting initial speech recognition stream...');
            recognizeStream = await vertexAIService.createSpeechStream();
            if (recognizeStream) {
              isStreamActive = true;
              setupStreamHandlers(recognizeStream, ws);
              console.log('✅ Initial speech stream started');
            }
          } catch (sttError) {
            console.error('❌ Failed to start initial STT stream:', sttError.message);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'error',
                errorType: 'STT_INITIALIZATION_ERROR',
                message: 'Failed to start Speech-to-Text service. Check GCP credentials.'
              }));
            }
          }
        }

        // Check if it's a configuration message
        let isConfigMessage = false;
        let configData = null;

        if (data instanceof Buffer) {
          try {
            const jsonString = data.toString('utf8');
            if (jsonString.trim().startsWith('{')) {
              configData = JSON.parse(jsonString);
              isConfigMessage = true;
            }
          } catch (parseError) {
            // Probably audio data
          }
        } else {
          try {
            configData = JSON.parse(data);
            isConfigMessage = true;
          } catch (e) { }
        }

        if (isConfigMessage && configData && configData.config) {
          // Re-configure stream if requested
          speechConfig = configData.config;
          console.log('⚙️ Re-configuring speech recognition stream');
          cleanupStream();

          try {
            recognizeStream = await vertexAIService.createSpeechStream(speechConfig);
            isStreamActive = true;
            setupStreamHandlers(recognizeStream, ws);
          } catch (sttError) {
            console.error('❌ Failed to re-configure STT stream:', sttError.message);
          }
        } else if (!isConfigMessage) {
          // Audio data - Write to stream if active
          if (isStreamActive && recognizeStream && !recognizeStream.destroyed && recognizeStream.writable) {
            try {
              recognizeStream.write(data);
            } catch (writeError) {
              console.error('❌ Error writing to stream:', writeError);
              isStreamActive = false;
              cleanupStream();
            }
          }
        }
      } catch (error) {
        console.error('❌ Error processing WebSocket message:', error);
      }
    });

    const setupStreamHandlers = (stream, socket) => {
      stream.on('data', async (response) => {
        if (!isStreamActive) return;

        try {
          const result = response.results[0];
          if (result && socket.readyState === WebSocket.OPEN) {
            const transcript = result.alternatives[0]?.transcript || '';
            const isFinal = result.isFinal || false;

            const message = {
              type: isFinal ? 'final' : 'interim',
              transcript: transcript,
              confidence: result.alternatives[0]?.confidence || 0,
              isFinal: isFinal,
              languageCode: speechConfig?.languageCode || 'en-US'
            };

            // Enregistrer la transcription finale pour l'analyse
            if (isFinal && transcript.trim()) {
              fullTranscript += transcript + " ";

              // Déclencher l'analyse en temps réel
              try {
                const analysisResult = await vertexAIService.analyzeCallPhase(fullTranscript);
                console.log('📊 AI Analysis triggered for transcript. Result:', analysisResult.current_phase);

                if (socket.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({
                    type: 'analysis',
                    ...analysisResult,
                    confidence: (analysisResult.confidence || 0) / 100,
                    timestamp: Date.now()
                  }));
                }
              } catch (analysisErr) {
                console.error('Error during AI analysis:', analysisErr);
              }
            }

            console.log('🎙️ Sending transcript result to client:', transcript.substring(0, 30) + '...');
            socket.send(JSON.stringify(message));
          }
        } catch (error) {
          console.error('Error processing recognition result:', error);
        }
      });

      stream.on('error', (error) => {
        console.error('Recognition stream error:', error);
        isStreamActive = false;
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: 'error',
            errorType: 'STT_STREAM_ERROR',
            message: 'Recognition stream error: ' + error.message
          }));
        }
        cleanupStream();
      });
    };

    const cleanupStream = () => {
      if (recognizeStream) {
        try {
          console.log('🧹 Cleaning up speech recognition stream');
          if (recognizeStream.writable) {
            recognizeStream.end();
          }
          recognizeStream.removeAllListeners();
          // Explicitly destroy if it's still alive to be safe
          if (typeof recognizeStream.destroy === 'function') {
            recognizeStream.destroy();
          }
          recognizeStream = null;
        } catch (error) {
          console.error('❌ Error cleaning up stream:', error);
        }
      }
      isStreamActive = false;
    };

    ws.on('close', () => {
      console.log('🔌 Client disconnected from speech-to-text WebSocket');
      cleanupStream();
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      cleanupStream();
    });
  });
}

module.exports = setupSpeechToTextWebSocket;
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
    let isInitializing = false;
    let pendingChunks = [];
    let speechConfig = null;
    let fullTranscript = "";
    let isAnalyzingPhase = false;

    // Inform client that WebSocket is ready
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'connected', message: 'WebSocket connection established' }));
    }

    ws.on('message', async (data) => {
      try {
        // Initial STT stream setup is now deferred until configuration is received
        // or audio data starts flowing (as a fallback)

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
          console.log('⚙️ [STT] Received configuration message. Re-configuring stream...');
          console.log('⚙️ [STT] Requested config:', JSON.stringify(speechConfig));
          cleanupStream();

          if (isInitializing) {
            console.log('⏳ [STT] Already initializing. Config will be used for the next stream.');
            return;
          }

          isInitializing = true;
          try {
            recognizeStream = await vertexAIService.createSpeechStream(speechConfig);
            isStreamActive = true;
            setupStreamHandlers(recognizeStream, ws);
            console.log('✅ [STT] Stream configured successfully');
          } catch (sttError) {
            console.error('❌ [STT] Failed to configure STT stream:', sttError.message);
          } finally {
            isInitializing = false;
          }
        } else if (!isConfigMessage) {
          // Audio data
          if (!isStreamActive && !recognizeStream) {
            if (isInitializing) {
              pendingChunks.push(data);
              if (pendingChunks.length % 10 === 0) console.log('⏳ [STT] Buffering audio chunk while initializing... (count: ' + pendingChunks.length + ')');
              return;
            }

            console.log('🎤 [STT] Audio data received (' + data.length + ' bytes). Starting fallback stream...');
            isInitializing = true;
            pendingChunks.push(data);

            try {
              recognizeStream = await vertexAIService.createSpeechStream(speechConfig || {});
              isStreamActive = true;
              setupStreamHandlers(recognizeStream, ws);

              const bufferedCount = pendingChunks.length;
              if (bufferedCount > 0) {
                console.log('📤 [STT] Writing ' + bufferedCount + ' buffered chunks to new stream');
                for (const chunk of pendingChunks) {
                  if (recognizeStream && !recognizeStream.destroyed && recognizeStream.writable) {
                    recognizeStream.write(chunk);
                  }
                }
                pendingChunks = [];
              }
            } catch (err) {
              console.error('❌ [STT] Failed to start STT stream:', err);
              pendingChunks = [];
            } finally {
              isInitializing = false;
            }
          } else if (isStreamActive && recognizeStream && !recognizeStream.destroyed && recognizeStream.writable) {
            try {
              recognizeStream.write(data);
            } catch (writeError) {
              console.error('❌ [STT] Error writing as stream was destroyed:', writeError.message);
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
            const confidence = result.alternatives[0]?.confidence || 0;

            console.log(`🎙️ [STT] Result received: "${transcript}" | isFinal: ${isFinal} | confidence: ${confidence}`);

            const message = {
              type: isFinal ? 'final' : 'interim',
              transcript: transcript,
              confidence: confidence,
              isFinal: isFinal,
              languageCode: speechConfig?.languageCode || 'en-US'
            };

            // Send transcript to client immediately (don't wait for analysis)
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(message));
            }

            // Trigger real-time analysis on final results
            if (isFinal && transcript.trim()) {
              fullTranscript += transcript + " ";

              // Throttled non-blocking analysis
              if (!isAnalyzingPhase) {
                isAnalyzingPhase = true;

                // Use a local copy to avoid closure issues if fullTranscript changes rapidly
                const currentTranscript = fullTranscript;

                vertexAIService.analyzeCallPhase(currentTranscript)
                  .then(analysisResult => {
                    console.log('📊 AI Analysis result:', analysisResult.current_phase);
                    if (socket.readyState === WebSocket.OPEN) {
                      socket.send(JSON.stringify({
                        type: 'analysis',
                        ...analysisResult,
                        confidence: (analysisResult.confidence || 0) / 100,
                        timestamp: Date.now()
                      }));
                    }
                  })
                  .catch(err => console.error('Error in real-time analysis:', err))
                  .finally(() => {
                    // Small delay before allowing next analysis to avoid spamming
                    setTimeout(() => { isAnalyzingPhase = false; }, 2000);
                  });
              }
            }
            return; // Already sent above
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
          if (recognizeStream && recognizeStream.writable && !recognizeStream.destroyed) {
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
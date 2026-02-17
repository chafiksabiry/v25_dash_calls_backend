const WebSocket = require('ws');
const vertexAIService = require('../services/vertexai.service');

function setupSpeechToTextWebSocket(server) {
  const wss = new WebSocket.Server({
    server,
    path: '/speech-to-text'
  });
  // console.log("wss",wss);

  wss.on('connection', async (ws) => {
    console.log('Client connected to speech-to-text WebSocket');
    let recognizeStream = null;
    let isStreamActive = false;
    let speechConfig = null;

    let fullTranscript = "";

    try {
      // Create a new speech recognition stream for this connection
      recognizeStream = await vertexAIService.createSpeechStream();
      isStreamActive = true;

      ws.on('message', async (data) => {
        try {
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
              // Audio data
            }
          } else {
            configData = JSON.parse(data);
            isConfigMessage = true;
          }

          if (isConfigMessage && configData) {
            // Configuration message
            if (configData.config) {
              speechConfig = configData.config;
              if (recognizeStream) {
                cleanupStream();
              }

              recognizeStream = await vertexAIService.createSpeechStream(speechConfig);
              isStreamActive = true;
              console.log('Speech recognition stream recreated with new config');

              // Set up event handlers for the new stream
              recognizeStream.on('data', async (response) => {
                if (!isStreamActive) return;

                try {
                  const result = response.results[0];
                  if (result && ws.readyState === WebSocket.OPEN) {
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
                      const analysisResult = await vertexAIService.analyzeCallPhase(fullTranscript);

                      // Envoyer l'analyse au client
                      ws.send(JSON.stringify({
                        type: 'analysis',
                        ...analysisResult,
                        timestamp: Date.now()
                      }));
                    }

                    ws.send(JSON.stringify(message));
                  }
                } catch (error) {
                  console.error('Error processing recognition result:', error);
                }
              });

              recognizeStream.on('error', (error) => {
                console.error('Recognition stream error:', error);
                isStreamActive = false;
                cleanupStream();
              });
            }
          } else {
            // Audio data
            if (isStreamActive && recognizeStream && recognizeStream.writable) {
              try {
                await recognizeStream.write(data);
              } catch (writeError) {
                console.error('Error writing to stream:', writeError);
                isStreamActive = false;
                cleanupStream();
              }
            }
          }
        } catch (error) {
          console.error('Error processing message:', error);
        }
      });

      const cleanupStream = () => {
        if (recognizeStream) {
          try {
            if (recognizeStream.writable) {
              recognizeStream.end();
            }
            recognizeStream.removeAllListeners();
            recognizeStream = null;
          } catch (error) {
            console.error('Error cleaning up stream:', error);
          }
        }
        isStreamActive = false;
      };

      ws.on('close', () => {
        console.log('Client disconnected from speech-to-text WebSocket');
        cleanupStream();
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        cleanupStream();
      });

    } catch (error) {
      console.error('Error setting up speech recognition:', error);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
  });
}

module.exports = setupSpeechToTextWebSocket; 
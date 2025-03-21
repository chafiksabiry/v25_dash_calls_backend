const WebSocket = require('ws');
const vertexAIService = require('../services/vertexai.service');

function setupSpeechToTextWebSocket(server) {
  const wss = new WebSocket.Server({ 
    server,
    path: '/speech-to-text'
  });

  wss.on('connection', async (ws) => {
    console.log('Client connected to speech-to-text WebSocket');
    let recognizeStream = null;
    let isStreamActive = false;
    
    try {
      // Create a new speech recognition stream for this connection
      recognizeStream = await vertexAIService.createSpeechStream();
      isStreamActive = true;
      
      ws.on('message', async (data) => {
        try {
          // Check if it's a configuration message
          if (data instanceof Buffer) {
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
          } else {
            // Configuration message
            const config = JSON.parse(data);
            console.log('Received config:', config);
          }
        } catch (error) {
          console.error('Error processing message:', error);
        }
      });
      
      if (recognizeStream) {
        recognizeStream.on('data', (response) => {
          if (!isStreamActive) return;
          
          try {
            const result = response.results[0];
            if (result && ws.readyState === WebSocket.OPEN) {
              const message = {
                transcript: result.alternatives[0]?.transcript || '',
                confidence: result.alternatives[0]?.confidence || 0,
                isFinal: result.isFinal || false,
                languageCode: result.languageCode
              };
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
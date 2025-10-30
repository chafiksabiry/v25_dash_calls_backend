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
    
    try {
      // Create a new speech recognition stream for this connection
      recognizeStream = await vertexAIService.createSpeechStream();
      isStreamActive = true;
      
      ws.on('message', async (data) => {
        try {
          console.log('📨 MESSAGE RECEIVED:');
          console.log('📊 Data type:', typeof data);
          console.log('📊 Data instanceof Buffer:', data instanceof Buffer);
          console.log('📊 Data length:', data.length);
          console.log('📊 Raw data (first 200 chars):', data.toString().substring(0, 200));
          
                     // Check if it's a configuration message
           let isConfigMessage = false;
           let configData = null;
           
           if (data instanceof Buffer) {
             // Try to parse as JSON first (config message)
             try {
               const jsonString = data.toString('utf8');
               if (jsonString.trim().startsWith('{')) {
                 console.log('🔧 DETECTED JSON IN BUFFER - PARSING CONFIG MESSAGE...');
                 configData = JSON.parse(jsonString);
                 isConfigMessage = true;
               }
             } catch (parseError) {
               // Not JSON, treat as audio data
               console.log('🔊 Buffer contains audio data, not JSON');
             }
           } else {
             // String data, treat as config
             console.log('🔧 PARSING CONFIG MESSAGE FROM STRING...');
             configData = JSON.parse(data);
             isConfigMessage = true;
           }
           
           if (isConfigMessage && configData) {
             // Configuration message
             console.log('🔧 PARSING CONFIG MESSAGE...');
             const config = configData;
            console.log('📥 CONFIG RECEIVED FROM FRONTEND:');
            console.log('📋 Raw config:', JSON.stringify(config, null, 2));
            console.log('🌍 Language from frontend:', config.config?.languageCode || 'NOT FOUND');
            console.log('📊 Full config object:', config);
            
            // Store the speech configuration
            if (config.config) {
              speechConfig = config.config;
              console.log('💾 STORED CONFIG:');
              console.log('🌍 Language stored:', speechConfig.languageCode);
              console.log('📋 Full stored config:', JSON.stringify(speechConfig, null, 2));
              console.log('🔍 Config keys:', Object.keys(speechConfig));
              
              // Recreate the stream with new configuration
              if (recognizeStream) {
                cleanupStream();
              }
              
              try {
                recognizeStream = await vertexAIService.createSpeechStream(speechConfig);
                isStreamActive = true;
                console.log('Speech recognition stream recreated with new config');
                
                // Set up event handlers for the new stream
                recognizeStream.on('data', (response) => {
                  if (!isStreamActive) return;
                  
                  try {
                    console.log('🔍 Raw recognition response:', JSON.stringify(response, null, 2));
                    
                    const result = response.results[0];
                    if (result && ws.readyState === WebSocket.OPEN) {
                      const detectedLanguage = speechConfig?.languageCode || 'en-US';
                      const message = {
                        transcript: result.alternatives[0]?.transcript || '',
                        confidence: result.alternatives[0]?.confidence || 0,
                        isFinal: result.isFinal || false,
                        languageCode: detectedLanguage
                      };
                      
                      // Log avec la langue détectée
                      if (result.alternatives[0]?.transcript) {
                        console.log(`🌍 Transcription (${detectedLanguage}): "${result.alternatives[0].transcript}"`);
                        console.log(`📊 Confidence: ${result.alternatives[0].confidence}, Final: ${result.isFinal}`);
                        console.log(`🔍 Full result:`, result);
                      } else {
                        console.log('⚠️ Empty transcript in recognition result');
                      }
                      
                      ws.send(JSON.stringify(message));
                    } else {
                      console.log('⚠️ No result or WebSocket not open');
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
              } catch (error) {
                console.error('Error recreating speech stream:', error);
              }
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
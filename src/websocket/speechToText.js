const WebSocket = require('ws');
const vertexAIService = require('../services/vertexai.service');

function setupSpeechToTextWebSocket(server) {
  const wss = new WebSocket.Server({
    server,
    path: '/speech-to-text'
  });
  // console.log("wss",wss);

  wss.on('connection', async (ws) => {
    console.log('✅ Client connected to speech-to-text WebSocket (Gemini 1.5 Flash Mode)');

    // Buffer for accumulating audio chunks
    let audioBuffer = Buffer.alloc(0);
    const BUFFER_LIMIT = 32000 * 5; // ~5 seconds of audio at 16kHz (32KB/s)
    const FLUSH_INTERVAL = 3000; // 3 seconds
    let flushTimer = null;
    let isProcessing = false;

    let fullTranscript = "";
    let isAnalyzingPhase = false;

    // Inform client that WebSocket is ready
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'connected', message: 'WebSocket connection established (Gemini)' }));
    }

    const processBuffer = async () => {
      if (audioBuffer.length === 0 || isProcessing) return;

      isProcessing = true;
      const bufferToProcess = audioBuffer;
      audioBuffer = Buffer.alloc(0); // Clear buffer immediately

      try {
        console.log(`🧠 [STT] Processing buffered audio (${bufferToProcess.length} bytes) with Gemini...`);
        const segments = await vertexAIService.transcribeAudioBuffer(bufferToProcess);

        if (segments && segments.length > 0) {
          console.log(`🎙️ [STT] Gemini returned ${segments.length} segments`);

          // Send all segments to client
          segments.forEach(segment => {
            const transcriptText = segment.text;

            // Format transcript with speaker label if present
            let formattedTranscript = transcriptText;
            if (segment.speaker) {
              formattedTranscript = `[${segment.speaker}]: ${transcriptText}`;
            }

            console.log(`🎙️ [STT] Segment: "${formattedTranscript}"`);

            const message = {
              type: 'final', // Gemini results are always final in this batch mode
              transcript: formattedTranscript,
              confidence: 0.95, // Gemini doesn't always return confidence, assuming high for now
              isFinal: true,
              speaker: segment.speaker,
              startTime: segment.start,
              endTime: segment.end,
              languageCode: 'en-US'
            };

            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(message));
            }

            // Append to full transcript for context/analysis
            fullTranscript += " " + formattedTranscript;
          });

          // Trigger Phase Analysis (throttled)
          if (!isAnalyzingPhase && fullTranscript.length > 50) {
            isAnalyzingPhase = true;
            // Analyze the last portion of transcript or full context?
            // Sending full transcript provides better context for phases
            vertexAIService.analyzeCallPhase(fullTranscript)
              .then(analysisResult => {
                console.log('📊 AI Analysis result:', analysisResult.current_phase);
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: 'analysis',
                    ...analysisResult,
                    confidence: (analysisResult.confidence || 0) / 100,
                    timestamp: Date.now()
                  }));
                }
              })
              .catch(err => console.error('Error in real-time analysis:', err))
              .finally(() => {
                setTimeout(() => { isAnalyzingPhase = false; }, 2000);
              });
          }
        }
      } catch (error) {
        console.error('❌ [STT] Error processing audio buffer:', error);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: 'Transcription error' }));
        }
      } finally {
        isProcessing = false;
      }
    };

    // Start periodic flush
    flushTimer = setInterval(processBuffer, FLUSH_INTERVAL);

    ws.on('message', async (data) => {
      try {
        // Handle Configuration (Ignore for now, using hardcoded Gemini defaults)
        if (data instanceof Buffer) {
          try {
            const jsonString = data.toString('utf8');
            if (jsonString.trim().startsWith('{')) {
              const config = JSON.parse(jsonString);
              console.log("⚙️ [STT] Received config (ignored in Gemini mode):", config.config?.languageCode);
              return;
            }
          } catch (e) { } // Not JSON, treat as audio
        } else {
          // If string data, likely config
          try {
            const config = JSON.parse(data);
            console.log("⚙️ [STT] Received config JSON (ignored in Gemini mode)");
            return;
          } catch (e) { }
        }

        // It's audio data
        if (Buffer.isBuffer(data)) {
          // Append to buffer
          audioBuffer = Buffer.concat([audioBuffer, data]);

          // If buffer gets too large, force flush
          if (audioBuffer.length >= BUFFER_LIMIT) {
            console.log("⚠️ [STT] Buffer limit reached, forcing flush");
            processBuffer();
          }
        }
      } catch (error) {
        console.error('❌ Error processing WebSocket message:', error);
      }
    });

    ws.on('close', () => {
      console.log('🔌 Client disconnected from speech-to-text WebSocket');
      if (flushTimer) clearInterval(flushTimer);
      // Process remaining buffer? Maybe not needed as call is over.
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      if (flushTimer) clearInterval(flushTimer);
    });
  });
}

module.exports = setupSpeechToTextWebSocket;
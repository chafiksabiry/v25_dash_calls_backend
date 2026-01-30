const WebSocket = require('ws');
const url = require('url');

// Map to store frontend connections: callControlId -> WebSocket
const frontendStreams = new Map();

// Import sendAudioToTelnyx safely (lazy load or dependency injection preferred, but direct require works if careful)
let telnyxMediaStream; // Will be loaded later to avoid circular dependency issues during init

function setTelnyxMediaStreamModule(module) {
    telnyxMediaStream = module;
}

function handleFrontendAudioStream(ws, req) {
    const parameters = url.parse(req.url, true).query;
    const callControlId = parameters.callControlId;

    console.log(`🔌 Frontend Audio Stream connecting for callControlId: ${callControlId}`);

    if (!callControlId) {
        console.error('❌ Missing callControlId parameter');
        ws.close(1008, 'Missing callControlId');
        return;
    }

    // Store the connection
    frontendStreams.set(callControlId, ws);
    console.log(`✅ Frontend stream registered for ${callControlId}`);

    ws.on('message', (message) => {
        // Message from Frontend (Microphone) -> to Telnyx
        try {
            // Parse message if it's JSON
            let payload;

            // Check if binary or text
            if (Buffer.isBuffer(message)) {
                // It might be raw audio or text
                const str = message.toString();
                if (str.startsWith('{')) {
                    const data = JSON.parse(str);
                    if (data.event === 'media' && data.media && data.media.payload) {
                        payload = data.media.payload;
                    }
                }
            } else {
                const data = JSON.parse(message);
                if (data.event === 'media' && data.media && data.media.payload) {
                    payload = data.media.payload;
                }
            }

            if (payload && telnyxMediaStream) {
                // Send to Telnyx
                telnyxMediaStream.sendAudioToTelnyx(callControlId, payload);
            }
        } catch (error) {
            console.error('❌ Error handling frontend message:', error);
        }
    });

    ws.on('close', () => {
        console.log(`🔌 Frontend stream disconnected for ${callControlId}`);
        frontendStreams.delete(callControlId);
    });

    ws.on('error', (error) => {
        console.error(`❌ Frontend stream error for ${callControlId}:`, error);
        frontendStreams.delete(callControlId);
    });
}

// Function to send audio to frontend (Speaker)
function sendAudioToFrontend(callControlId, audioPayload) {
    const ws = frontendStreams.get(callControlId);

    if (ws && ws.readyState === WebSocket.OPEN) {
        // Send as JSON event 'media'
        ws.send(JSON.stringify({
            event: 'media',
            media: {
                payload: audioPayload
            }
        }));
        return true; // Sent successfully
    }
    return false; // Not sent (no connection)
}

module.exports = {
    handleFrontendAudioStream,
    sendAudioToFrontend,
    setTelnyxMediaStreamModule
};

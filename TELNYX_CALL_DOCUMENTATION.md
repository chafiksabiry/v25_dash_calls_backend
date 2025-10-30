# Telnyx Call Integration Documentation

This document provides comprehensive documentation for making calls with Telnyx, including call creation options, webhook handling, event broadcasting, and audio streaming architecture.

## Table of Contents

1. [Overview](#overview)
2. [Call Creation Options](#call-creation-options)
3. [Webhook System](#webhook-system)
4. [Audio Streaming Architecture](#audio-streaming-architecture)
5. [API Endpoints](#api-endpoints)
6. [WebSocket Events](#websocket-events)
7. [Configuration](#configuration)
8. [Examples](#examples)

## Overview

The Telnyx integration provides a complete call management system with real-time audio streaming and event broadcasting. The system consists of:

- **Call Management**: Initiate, control, and monitor calls
- **Webhook Processing**: Handle call events from Telnyx
- **Audio Streaming**: Real-time audio transmission from Telnyx to frontend clients
- **Event Broadcasting**: Real-time call event updates to connected clients

## General Flow and Architecture

### Outbound Call Flow Diagram

When an outbound call is initiated, the system follows this flow:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          OUTBOUND CALL FLOW                              │
└─────────────────────────────────────────────────────────────────────────┘

1. CLIENT INITIATES CALL
   ┌──────────┐
   │ Frontend │ POST /api/calls/telnyx/initiate
   └────┬─────┘      {to, from, agentId}
        │
        ▼
   ┌────────────────────────────────────┐
   │ Backend (telnyxService.makeCall)  │
   │ - Creates call via Telnyx API      │
   │ - Enables noise suppression        │
   │ - Stores call in DB                │
   └────┬───────────────────────────────┘
        │
        ▼ Returns call data
   ┌──────────┐
   │ Frontend │ Receives call ID, stream URL
   └──────────┘

2. WEBSOCKET CONNECTIONS ESTABLISHED
   ┌──────────┐  Connect to ws://host/call-events    ┌──────────────┐
   │ Frontend │ ───────────────────────────────────► │ Backend      │
   │ Client   │                                      │ (WS Server)  │
   └──────────┘                                      └──────────────┘
   
   ┌──────────┐  Connect to ws://host/frontend-audio ┌──────────────┐
   │ Frontend │ ────────────────────────────────────► │ Backend      │
   │ Client   │                                       │ (WS Server)  │
   └──────────┘                                       └──────────────┘

3. TELNYX EVENTS (Webhook → WebSocket)
   ┌─────────┐  Webhook Events               ┌─────────────────────────┐
   │ Telnyx  │ ────────────────────────────► │ POST /telnyx/webhook   │
   └─────────┘    call.initiated              │ - Verify signature     │
   └─────────┘    call.answered                │ - Update DB            │
   └─────────┘    streaming.started            │ - Broadcast to WS      │
   └─────────┘    call.hangup                 └───────────┬───────────┘
                                                           │
                                                           ▼
                                            ┌─────────────────────────┐
                                            │ broadcastCallEvent()    │
                                            │ - Broadcasts to all     │
                                            │   call-events clients   │
                                            └───────────┬──────────────┘
                                                        │
                                                        ▼
                                              ┌─────────────────────┐
                                              │ Frontend receives   │
                                              │ call status updates │
                                              └─────────────────────┘

4. AUDIO STREAMING (Telnyx → Frontend)
   ┌─────────┐  Audio WebSocket              ┌──────────────────────────┐
   │ Telnyx  │ ────────────────────────────► │ /audio-stream            │
   └─────────┘  Connect to audio-stream       │ - Receives audio from    │
        │      Send audio data (PCMU)         │   Telnyx                 │
        │      - start event                  │ - Filters inbound track  │
        │      - media events                 │ - Broadcasts to frontend │
        │      - stop event                   └──────────┬───────────────┘
        │                                                │
        └────────────────────────────────────────────────┘
                                                         │
                                                         ▼
                                            ┌──────────────────────────┐
                                            │ frontendBroadcaster       │
                                            │ - Forwards to             │
                                            │   /frontend-audio clients │
                                            └──────────┬───────────────┘
                                                       │
                                                       ▼
                                            ┌─────────────────────────┐
                                            │ Frontend receives       │
                                            │ real-time audio data    │
                                            │ - Decodes PCMU          │
                                            │ - Plays audio           │
                                            └─────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                       COMPONENT RELATIONSHIPS                           │
└─────────────────────────────────────────────────────────────────────────┘

┌──────────────────────┐      ┌──────────────────┐
│ TELNYX WEBHOOK       │      │ WEBSOCKETS       │
│ (/api/calls/         │◄────►│                  │
│  telnyx/webhook)     │      │ 1. /call-events  │ ← Frontend clients
│                      │      │    - Call status │   receive call events
│ - Receives events    │      │                  │
│ - Verifies sig       │      │ 2. /audio-stream │ ← Telnyx audio
│ - Updates DB         │      │    - From Telnyx │   connection
│ - Broadcasts events  │      │                  │
└──────────────────────┘      │ 3. /frontend-    │ ← Frontend clients
                              │    audio         │   receive audio data
                              │    - To Frontend │
                              └──────────────────┘
                              │
                              │ Flow:
                              │ Webhook → call-events (status updates)
                              │ Telnyx → audio-stream → frontend-audio (audio)
                              └────────────────────────────────────────────┘
```

### Key Relationships

#### 1. Telnyx Webhook → call-events WebSocket
- **Purpose**: Broadcast call status events to frontend clients
- **Flow**: 
  - Telnyx sends webhook → Backend verifies signature → Updates DB → Broadcasts via `broadcastCallEvent()` → Frontend receives via call-events WS
- **Events**: `call.initiated`, `call.answered`, `call.hangup`, `streaming.started`, etc.

#### 2. Telnyx → audio-stream WebSocket → frontend-audio WebSocket
- **Purpose**: Stream audio data from Telnyx to frontend clients
- **Flow**:
  1. Telnyx connects to `/audio-stream` WebSocket
  2. Sends audio data (PCMU format)
  3. Backend filters only `inbound` track audio
  4. Forwards to `/frontend-audio` clients via `frontendBroadcaster`
  5. Frontend clients receive and play audio
- **Data**: Real-time PCMU audio chunks with timestamps

#### 3. Outbound Call Lifecycle

```
┌──────────────────────────────────────────────────────────────────────┐
│                    CALL LIFECYCLE SEQUENCE                           │
└──────────────────────────────────────────────────────────────────────┘

1. INITIATION
   Frontend: POST /api/calls/telnyx/initiate
   → Backend creates call with Telnyx API
   → Enables noise suppression
   → Returns call ID and stream URL

2. WEBSOCKET CONNECTION
   Frontend connects to:
   - ws://host/call-events       (for status updates)
   - ws://host/frontend-audio    (for audio data)

3. CALL EVENTS
   Telnyx sends webhooks:
   → call.initiated → broadcasted to call-events clients
   → call.answered → broadcasted to call-events clients
   → streaming.started → broadcasted to call-events clients

4. AUDIO STREAMING
   Telnyx connects to /audio-stream:
   → Start event → forwarded to /frontend-audio clients
   → Media events (audio chunks) → forwarded to /frontend-audio clients
   → Stop event → forwarded to /frontend-audio clients

5. CALL TERMINATION
   Frontend: POST /api/calls/telnyx/end
   OR Telnyx sends call.hangup webhook:
   → broadcasted to call-events clients
   → Audio streaming stops
   → Disable noise suppression
```

### Communication Channels

| Channel | Direction | Purpose | Data Flow |
|---------|-----------|---------|-----------|
| **HTTP** `/api/calls/telnyx/initiate` | Frontend → Backend | Initiate calls | Call config, returns call ID |
| **HTTP** `/api/calls/telnyx/webhook` | Telnyx → Backend | Call events | Webhook events |
| **WebSocket** `/call-events` | Backend → Frontend | Status updates | Call status events |
| **WebSocket** `/audio-stream` | Telnyx → Backend | Audio data | Raw audio from Telnyx |
| **WebSocket** `/frontend-audio` | Backend → Frontend | Audio playback | Filtered audio to clients |

This architecture ensures:
- **Real-time status updates** via call-events WebSocket
- **Real-time audio streaming** via audio-stream → frontend-audio pipeline
- **Decoupled components** for scalability
- **Secure webhook verification** for all Telnyx events

## Call Creation Options

### Basic Call Creation

When creating a call with Telnyx, you can configure various options through the `makeCall` method in `telnyxService.js`:

```javascript
const callOptions = {
  connection_id: this.applicationId,           // Telnyx connection ID
  to: to,                                     // Destination number (E.164 format)
  from: from,                                 // Source number (E.164 format)
  stream_url: 'wss://your-domain.com/audio-stream',  // WebSocket URL for audio streaming
  stream_track: 'both_tracks',                // Audio track configuration
  stream_bidirectional_mode: 'rtp',          // Bidirectional streaming mode
  stream_codec: 'PCMU',                      // Audio codec
  stream_sample_rate: '8000',                // Sample rate
  stream_bidirectional_codec: 'PCMU',        // Bidirectional codec
  stream_bidirectional_sample_rate: 8000,    // Bidirectional sample rate
  client_state: clientState,                 // Base64 encoded client state
  command_id: this.generateCommandId()       // Unique command identifier
};
```

### Call Options Explained

#### Required Parameters
- **`connection_id`**: Your Telnyx application connection ID
- **`to`**: Destination phone number in E.164 format (e.g., +1234567890)
- **`from`**: Source phone number in E.164 format

#### Audio Streaming Parameters
- **`stream_url`**: WebSocket URL where Telnyx will send audio data
- **`stream_track`**: Which audio tracks to stream
  - `'inbound_track'`: Only caller's audio
  - `'outbound_track'`: Only callee's audio  
  - `'both_tracks'`: Both caller and callee audio
- **`stream_codec`**: Audio codec for streaming
  - `'PCMU'`: Standard telephony codec (recommended)
  - `'PCMA'`: Alternative telephony codec
- **`stream_sample_rate`**: Audio sample rate (8000 Hz standard for telephony)

#### Advanced Options
- **`stream_bidirectional_mode`**: How bidirectional audio is handled
- **`stream_bidirectional_codec`**: Codec for bidirectional audio
- **`stream_bidirectional_sample_rate`**: Sample rate for bidirectional audio
- **`client_state`**: Base64 encoded JSON with custom data (agentId, timestamp, etc.)
- **`command_id`**: Unique identifier for the command

### Noise Suppression

The system automatically enables noise suppression for all calls:

```javascript
// Enable noise suppression after call creation
await this.axiosInstance.post(`/calls/${call.call_control_id}/actions/suppression_start`, {
  direction: 'both'  // Suppress noise in both directions
});
```

## Webhook System

### Webhook Endpoint

The webhook endpoint is configured as:
```javascript
router.post('/telnyx/webhook', verifyTelnyxWebhook, callController.telnyxWebhook);
```

### Webhook Verification

All incoming webhooks are verified using Telnyx's signature verification:

```javascript
// Middleware: src/middleware/telnyxWebhook.js
function verifyTelnyxWebhook(req, res, next) {
  const signatureHeader = req.headers['telnyx-signature-ed25519'];
  const timestampHeader = req.headers['telnyx-timestamp'];
  
  const event = telnyx.webhooks.constructEvent(
    rawBody,
    signatureHeader,
    timestampHeader,
    config.TELNYX_PUBLIC_KEY
  );
  
  req.telnyxEvent = event;
  next();
}
```

### Supported Webhook Events

The system handles the following Telnyx events:

#### Call Events
- **`call.initiated`**: Call has been initiated
- **`call.answered`**: Call has been answered
- **`call.hangup`**: Call has been terminated
- **`call.terminated`**: Call has been terminated (alternative)

#### Streaming Events
- **`streaming.started`**: Audio streaming has begun
- **`streaming.failed`**: Audio streaming failed
- **`streaming.stopped`**: Audio streaming has stopped

### Event Processing Flow

1. **Webhook Reception**: Telnyx sends event to `/api/calls/telnyx/webhook`
2. **Signature Verification**: Middleware verifies webhook authenticity
3. **Event Processing**: Controller processes the event type
4. **Database Update**: Call status is updated in the database
5. **Event Broadcasting**: Event is broadcast to WebSocket clients
6. **Response**: 200 OK response sent to Telnyx

```javascript
// Event processing in telnyxWebhook controller
exports.telnyxWebhook = async (req, res) => {
  // Quick acknowledgment
  res.status(200).json({ received: true });
  
  const eventType = event.data.event_type;
  
  // Process call and streaming events
  if (['call.initiated', 'call.answered', 'call.hangup', 'streaming.started', 'streaming.failed', 'streaming.stopped'].includes(eventType)) {
    // Broadcast to WebSocket clients
    broadcastCallEvent(event);
    
    // Update database
    const call = await Call.findOne({ call_id: callId });
    // ... update call status based on event type
  }
};
```

## Audio Streaming Architecture

### Architecture Overview

The audio streaming system uses a multi-layer WebSocket architecture:

```
Telnyx → audio-stream WebSocket → frontend-audio WebSocket → Frontend Clients
```

### WebSocket Servers

The system runs multiple WebSocket servers on different ports:

```javascript
// WebSocket server configuration in app.js
const wsServers = setupWebSocketManager(server);

// Individual WebSocket handlers
setupTestWebSocket(wsServers.get('callEvents'));        // Call events
const frontendAudioStream = setupFrontendAudioStream(wsServers.get('frontendAudio'));  // Frontend audio
setupAudioStream(wsServers.get('audioStream'), frontendAudioStream);  // Telnyx audio
```

### Audio Stream Flow

#### 1. Telnyx Audio Stream (`/audio-stream`)

**Purpose**: Receives audio data from Telnyx
**Port**: Configured in WebSocket manager
**Authentication**: Telnyx user-agent verification

```javascript
// src/websocket/audioStream.js
wsServer.on('connection', (ws, req) => {
  // Verify Telnyx connection
  const isTelnyx = req.headers['user-agent']?.toLowerCase().includes('telnyx') || 
                  req.headers['x-telnyx-signature'];
  
  if (!isTelnyx) {
    ws.close();
    return;
  }
  
  // Handle Telnyx audio messages
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    
    switch (message.event) {
      case 'start':
        // Stream starting
        frontendBroadcaster.broadcastToClients(message);
        break;
        
      case 'media':
        // Audio data (only inbound track)
        if (message.media?.payload && message.media.track === 'inbound') {
          frontendBroadcaster.broadcastToClients(message);
        }
        break;
        
      case 'stop':
        // Stream stopped
        frontendBroadcaster.broadcastToClients(message);
        break;
    }
  });
});
```

#### 2. Frontend Audio Stream (`/frontend-audio`)

**Purpose**: Broadcasts audio to frontend clients
**Port**: Configured in WebSocket manager
**Authentication**: None (frontend clients connect directly)

```javascript
// src/websocket/frontendAudioStream.js
function setupFrontendAudioStream(wsServer) {
  wsServer.on('connection', (ws, req) => {
    console.log('👤 Frontend client connected to audio stream');
    clients.add(ws);
    
    // Send initial configuration
    ws.send(JSON.stringify({ 
      event: 'connected',
      message: 'Connected to audio stream',
      config: {
        format: 'PCMU',
        sampleRate: 8000,
        channels: 1
      }
    }));
  });
  
  return {
    broadcastToClients,
    getConnectedClients: () => clients.size
  };
}
```

### Audio Message Format

#### Stream Start Message
```json
{
  "event": "start",
  "stream_id": "unique-stream-id",
  "start": {
    "media_format": "audio/PCMU",
    "sample_rate": 8000,
    "channels": 1
  }
}
```

#### Audio Data Message
```json
{
  "event": "media",
  "stream_id": "unique-stream-id",
  "media": {
    "track": "inbound",
    "chunk": "1",
    "timestamp": "1234567890",
    "payload": "base64-encoded-audio-data"
  }
}
```

#### Stream Stop Message
```json
{
  "event": "stop",
  "stream_id": "unique-stream-id"
}
```

## API Endpoints

### Call Management

#### Initiate Call
```http
POST /api/calls/telnyx/initiate
Content-Type: application/json

{
  "to": "+1234567890",
  "from": "+0987654321", 
  "agentId": "agent-id-here"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "callId": "call-control-id",
    "status": "initiated",
    "direction": "outbound-dial",
    "streamUrl": "wss://your-domain.com/audio-stream",
    "dbRecord": { /* call record */ }
  }
}
```

#### End Call
```http
POST /api/calls/telnyx/end
Content-Type: application/json

{
  "call_control_id": "call-control-id"
}
```

#### Mute Call
```http
POST /api/calls/telnyx/:callControlId/mute
```

#### Unmute Call
```http
POST /api/calls/telnyx/:callControlId/unmute
```

### Webhook Endpoint

#### Telnyx Webhook
```http
POST /api/calls/telnyx/webhook
Content-Type: application/json
telnyx-signature-ed25519: signature-here
telnyx-timestamp: timestamp-here

{
  "data": {
    "event_type": "call.answered",
    "payload": {
      "call_control_id": "call-id",
      "to": "+1234567890",
      "from": "+0987654321"
    }
  }
}
```

## WebSocket Events

### Call Events WebSocket (`/call-events`)

Connects to call events WebSocket to receive real-time call status updates.

#### Connection
```javascript
const ws = new WebSocket('ws://localhost:PORT/call-events');

ws.onopen = () => {
  console.log('Connected to call events');
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  switch(data.type) {
    case 'call.initiated':
      console.log('Call initiated:', data.payload);
      break;
    case 'call.answered':
      console.log('Call answered:', data.payload);
      break;
    case 'call.hangup':
      console.log('Call ended:', data.payload);
      break;
  }
};
```

#### Event Format
```json
{
  "type": "call.answered",
  "id": "event-id",
  "occurred_at": "2024-01-01T12:00:00Z",
  "payload": {
    "call_control_id": "call-id",
    "to": "+1234567890",
    "from": "+0987654321",
    "duration_seconds": 120
  }
}
```

### Frontend Audio WebSocket (`/frontend-audio`)

Connects to audio stream to receive real-time audio data.

#### Connection
```javascript
const ws = new WebSocket('ws://localhost:PORT/frontend-audio');

ws.onopen = () => {
  console.log('Connected to audio stream');
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  switch(data.event) {
    case 'connected':
      console.log('Audio stream connected:', data.config);
      break;
    case 'start':
      console.log('Stream started:', data.start);
      break;
    case 'media':
      // Process audio data
      const audioData = atob(data.media.payload);
      playAudio(audioData);
      break;
    case 'stop':
      console.log('Stream stopped');
      break;
  }
};
```

## Configuration

### Environment Variables

Required environment variables for Telnyx integration:

```bash
# Telnyx Configuration
TELNYX_API_KEY=your-api-key
TELNYX_APPLICATION_ID=your-application-id
TELNYX_PUBLIC_KEY=your-public-key
TELNYX_STREAM_URL=your-stream-domain.com

# WebSocket Configuration
WS_CALL_EVENTS_PORT=8080
WS_AUDIO_STREAM_PORT=8081
WS_FRONTEND_AUDIO_PORT=8082
```

### WebSocket Manager Configuration

```javascript
// src/websocket/wsManager.js
function setupWebSocketManager(server) {
  const wsServers = new Map();
  
  // Call events WebSocket
  wsServers.set('callEvents', new WebSocket.Server({
    server,
    path: '/call-events',
    port: process.env.WS_CALL_EVENTS_PORT || 8080
  }));
  
  // Audio stream WebSocket
  wsServers.set('audioStream', new WebSocket.Server({
    server,
    path: '/audio-stream',
    port: process.env.WS_AUDIO_STREAM_PORT || 8081
  }));
  
  // Frontend audio WebSocket
  wsServers.set('frontendAudio', new WebSocket.Server({
    server,
    path: '/frontend-audio',
    port: process.env.WS_FRONTEND_AUDIO_PORT || 8082
  }));
  
  return wsServers;
}
```

## Examples

### Complete Call Flow Example

#### 1. Initiate Call
```javascript
// Frontend initiates call
const response = await fetch('/api/calls/telnyx/initiate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    to: '+1234567890',
    from: '+0987654321',
    agentId: 'agent-123'
  })
});

const { data } = await response.json();
console.log('Call initiated:', data.callId);
```

#### 2. Connect to WebSockets
```javascript
// Connect to call events
const callEventsWs = new WebSocket('ws://localhost:8080/call-events');
callEventsWs.onmessage = (event) => {
  const data = JSON.parse(event.data);
  updateCallStatus(data);
};

// Connect to audio stream
const audioWs = new WebSocket('ws://localhost:8082/frontend-audio');
audioWs.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.event === 'media') {
    playAudio(data.media.payload);
  }
};
```

#### 3. Handle Call Events
```javascript
function updateCallStatus(eventData) {
  switch(eventData.type) {
    case 'call.initiated':
      showCallStatus('Calling...');
      break;
    case 'call.answered':
      showCallStatus('Connected');
      startAudioPlayback();
      break;
    case 'call.hangup':
      showCallStatus('Call Ended');
      stopAudioPlayback();
      break;
  }
}
```

#### 4. End Call
```javascript
// End the call
await fetch('/api/calls/telnyx/end', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    call_control_id: callId
  })
});
```

### Audio Playback Example

```javascript
class AudioPlayer {
  constructor() {
    this.audioContext = new AudioContext();
    this.audioBuffer = null;
  }
  
  async playAudioData(base64Data) {
    try {
      // Decode base64 audio data
      const binaryData = atob(base64Data);
      const arrayBuffer = new Uint8Array(binaryData.length);
      
      for (let i = 0; i < binaryData.length; i++) {
        arrayBuffer[i] = binaryData.charCodeAt(i);
      }
      
      // Decode PCMU audio
      const audioBuffer = await this.decodePCMU(arrayBuffer);
      
      // Play audio
      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioContext.destination);
      source.start();
      
    } catch (error) {
      console.error('Audio playback error:', error);
    }
  }
  
  async decodePCMU(pcmuData) {
    // Convert PCMU to PCM and create AudioBuffer
    const pcmData = new Float32Array(pcmuData.length);
    
    for (let i = 0; i < pcmuData.length; i++) {
      pcmData[i] = (pcmuData[i] - 128) / 128;
    }
    
    const audioBuffer = this.audioContext.createBuffer(1, pcmData.length, 8000);
    audioBuffer.copyToChannel(pcmData, 0);
    
    return audioBuffer;
  }
}
```

## Error Handling

### Common Error Scenarios

1. **Invalid Phone Number Format**
   ```javascript
   if (!to.startsWith('+')) {
     throw new Error('Destination number must be in E.164 format (e.g., +1234567890)');
   }
   ```

2. **WebSocket Connection Failures**
   ```javascript
   ws.on('error', (error) => {
     console.error('WebSocket error:', error);
     // Implement reconnection logic
   });
   ```

3. **Audio Streaming Failures**
   ```javascript
   case 'streaming.failed':
     console.error('Streaming failed:', message.payload.failure_reason);
     // Notify user and attempt reconnection
     break;
   ```

### Debugging Tips

1. **Enable Detailed Logging**
   ```javascript
   console.log('📞 Initiating call with config:', callOptions);
   console.log('🎧 Telnyx audio stream connected');
   console.log('📢 Broadcasting to X frontend clients');
   ```

2. **Monitor WebSocket Connections**
   ```javascript
   console.log(`Connected clients: ${clients.size}`);
   console.log(`Telnyx connection: ${telnyxConnection ? 'active' : 'inactive'}`);
   ```

3. **Verify Webhook Signatures**
   ```javascript
   console.log('✅ Webhook verified successfully:', event.data.event_type);
   ```

This documentation provides a comprehensive guide to the Telnyx call integration system, covering all aspects from call creation to real-time audio streaming and event handling.

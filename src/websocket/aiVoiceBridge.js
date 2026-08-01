const WebSocket = require('ws');
const { getActiveSession } = require('../services/aiOutboundCallService');
const {
  mulawBufferToPcm16Base64_24k,
  pcm16Base64_24kToMulawBuffer,
} = require('../utils/audioCodec');

/**
 * Telnyx media stream <-> OpenAI Realtime bridge.
 * Path: /ai-voice-stream?callControlId=...
 */
function setupAiVoiceBridge(server) {
  const wss = new WebSocket.Server({
    server,
    path: '/ai-voice-stream',
  });

  wss.on('connection', (ws, request) => {
    let callControlId = null;
    try {
      const url = new URL(request.url, 'http://localhost');
      callControlId = url.searchParams.get('callControlId');
    } catch {
      /* ignore */
    }

    const ctx = callControlId ? getActiveSession(callControlId) : null;
    if (!ctx || !ctx.realtime) {
      console.error('[AiVoiceBridge] no active AI session for', callControlId);
      ws.close(1008, 'no_session');
      return;
    }

    console.log('[AiVoiceBridge] telnyx stream connected', callControlId);
    const realtime = ctx.realtime;
    ctx.telnyxStreamWs = ws;

    realtime.on('onAudioDelta', (base64Pcm24) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        const mulaw = pcm16Base64_24kToMulawBuffer(base64Pcm24);
        ws.send(
          JSON.stringify({
            event: 'media',
            media: {
              payload: mulaw.toString('base64'),
            },
          })
        );
      } catch (err) {
        console.warn('[AiVoiceBridge] outbound audio encode failed', err?.message || err);
      }
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const event = msg.event || msg.type;
      if (event === 'media' && msg.media?.payload) {
        try {
          const mulawBuf = Buffer.from(msg.media.payload, 'base64');
          const pcm24b64 = mulawBufferToPcm16Base64_24k(mulawBuf);
          realtime.appendInputAudio(pcm24b64);
        } catch (err) {
          console.warn('[AiVoiceBridge] invalid inbound audio', err?.message || err);
        }
        return;
      }

      if (event === 'start') {
        console.log('[AiVoiceBridge] stream start', callControlId);
        return;
      }

      if (event === 'stop' || event === 'ended') {
        console.log('[AiVoiceBridge] stream stop', callControlId);
        try {
          realtime.close();
        } catch {
          /* ignore */
        }
      }
    });

    ws.on('close', () => {
      console.log('[AiVoiceBridge] telnyx stream closed', callControlId);
    });

    ws.on('error', (err) => {
      console.error('[AiVoiceBridge] ws error', err?.message || err);
    });
  });

  console.log('[AiVoiceBridge] listening on /ai-voice-stream');
}

module.exports = setupAiVoiceBridge;

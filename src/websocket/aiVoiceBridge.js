const WebSocket = require('ws');
const { getActiveSession } = require('../services/aiOutboundCallService');

/**
 * Telnyx media stream <-> OpenAI Realtime bridge (PCMU passthrough).
 * Path: /ai-voice-stream?callControlId=...
 *
 * Audio is g711 µ-law @ 8kHz end-to-end (Telnyx PCMU ↔ OpenAI g711_ulaw)
 * so there is no resampling — required for natural barge-in conversation.
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
    if (!ctx) {
      console.error('[AiVoiceBridge] no session ctx for', callControlId);
      ws.close(1008, 'no_session');
      return;
    }

    // Telnyx may connect before OpenAI is ready — hold the socket.
    ctx.telnyxStreamWs = ws;
    ctx.telnyxStreamId = null;
    let mediaIn = 0;
    let mediaOut = 0;

    const attachRealtimeHandlers = (realtime) => {
      if (!realtime || realtime.__bridgeAttached) return;
      realtime.__bridgeAttached = true;

      realtime.on('onAudioDelta', (base64Pcmu) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          mediaOut += 1;
          ws.send(
            JSON.stringify({
              event: 'media',
              media: { payload: base64Pcmu },
            })
          );
          if (mediaOut === 1 || mediaOut % 50 === 0) {
            console.log('[AiVoiceBridge] audio out frames', mediaOut, callControlId);
          }
        } catch (err) {
          console.warn('[AiVoiceBridge] outbound send failed', err?.message || err);
        }
      });

      realtime.on('onSpeechStarted', () => {
        // Barge-in: clear Telnyx playback queue so the caller can interrupt.
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ event: 'clear' }));
          } catch {
            /* ignore */
          }
        }
        console.log('[AiVoiceBridge] barge-in clear', callControlId);
      });
    };

    if (ctx.realtime) {
      attachRealtimeHandlers(ctx.realtime);
    } else {
      ctx._attachBridgeWhenReady = attachRealtimeHandlers;
      console.log('[AiVoiceBridge] telnyx connected early, waiting for OpenAI', callControlId);
    }

    console.log('[AiVoiceBridge] telnyx stream connected', callControlId);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const event = msg.event || msg.type;

      if (event === 'start') {
        ctx.telnyxStreamId = msg.stream_id || null;
        const fmt = msg.start?.media_format;
        console.log('[AiVoiceBridge] stream start', {
          callControlId,
          streamId: ctx.telnyxStreamId,
          encoding: fmt?.encoding,
          sampleRate: fmt?.sample_rate,
        });
        return;
      }

      if (event === 'media' && msg.media?.payload) {
        const realtime = ctx.realtime;
        if (!realtime || !realtime.connected) return;
        // Only forward caller audio (inbound). Ignore echoed outbound if both_tracks.
        const track = msg.media.track || '';
        if (track && track !== 'inbound' && track !== 'inbound_track') return;
        try {
          mediaIn += 1;
          realtime.appendInputAudio(msg.media.payload);
          if (mediaIn === 1 || mediaIn % 50 === 0) {
            console.log('[AiVoiceBridge] audio in frames', mediaIn, callControlId);
          }
        } catch (err) {
          console.warn('[AiVoiceBridge] inbound audio failed', err?.message || err);
        }
        return;
      }

      if (event === 'stop' || event === 'ended') {
        console.log('[AiVoiceBridge] stream stop', callControlId, {
          mediaIn,
          mediaOut,
        });
        try {
          ctx.realtime?.close();
        } catch {
          /* ignore */
        }
      }
    });

    ws.on('close', () => {
      console.log('[AiVoiceBridge] telnyx stream closed', callControlId, {
        mediaIn,
        mediaOut,
      });
    });

    ws.on('error', (err) => {
      console.error('[AiVoiceBridge] ws error', err?.message || err);
    });
  });

  console.log('[AiVoiceBridge] listening on /ai-voice-stream (PCMU passthrough)');
}

module.exports = setupAiVoiceBridge;

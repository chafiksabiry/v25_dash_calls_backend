const WebSocket = require('ws');
const {
  getActiveSession,
  getSessionByStreamToken,
  resolveStreamToken,
} = require('../services/aiOutboundCallService');

/**
 * Telnyx media stream <-> OpenAI Realtime (PCMU passthrough).
 * URL: wss://<host>/ai-voice-stream/<streamToken>
 *
 * Uses noServer; app.js must call attachAiVoiceUpgrade(server) OR
 * setupAiVoiceBridge(server) which registers the upgrade handler.
 */
function setupAiVoiceBridge(server) {
  const wss = new WebSocket.Server({
    noServer: true,
    perMessageDeflate: false,
  });

  const onUpgrade = (request, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(request.url, 'http://localhost').pathname || '';
    } catch {
      return;
    }

    if (!pathname.startsWith('/ai-voice-stream')) return;
    if (pathname === '/ai-voice-stream/health') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    console.log('[AiVoiceBridge] upgrade accept', {
      url: request.url,
      pathname,
    });

    try {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } catch (err) {
      console.error('[AiVoiceBridge] handleUpgrade threw', err?.message || err);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
  };

  // Register BEFORE other upgrade listeners when possible — app.js order matters.
  server.on('upgrade', onUpgrade);

  wss.on('connection', (ws, request) => {
    console.log('[AiVoiceBridge] connection event', { url: request.url });

    let streamToken = null;
    let callControlId = null;
    try {
      const url = new URL(request.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'ai-voice-stream' && parts[1]) {
        streamToken = parts[1];
      }
      callControlId =
        url.searchParams.get('callControlId') ||
        (streamToken ? resolveStreamToken(streamToken) : null);
    } catch (err) {
      console.error('[AiVoiceBridge] bad url', err?.message || err);
    }

    const ctx =
      (streamToken && getSessionByStreamToken(streamToken)) ||
      (callControlId ? getActiveSession(callControlId) : null);

    if (!ctx) {
      console.error('[AiVoiceBridge] no session — closing', {
        streamToken,
        callControlId,
      });
      ws.close(1008, 'no_session');
      return;
    }

    // Prefer resolved callControlId from ctx
    callControlId = ctx.callControlId || callControlId;
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
          ws.send(JSON.stringify({ event: 'media', media: { payload: base64Pcmu } }));
          if (mediaOut === 1 || mediaOut % 50 === 0) {
            console.log('[AiVoiceBridge] audio out frames', mediaOut, callControlId);
          }
        } catch (err) {
          console.warn('[AiVoiceBridge] outbound send failed', err?.message || err);
        }
      });

      realtime.on('onSpeechStarted', () => {
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
      console.log('[AiVoiceBridge] waiting for OpenAI', callControlId || streamToken);
    }

    console.log('[AiVoiceBridge] telnyx stream connected', {
      callControlId,
      streamToken,
      hasRealtime: Boolean(ctx.realtime),
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const event = msg.event || msg.type;

      if (event === 'connected') {
        console.log('[AiVoiceBridge] telnyx connected frame', callControlId);
        return;
      }

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
        console.log('[AiVoiceBridge] stream stop', callControlId, { mediaIn, mediaOut });
        try {
          ctx.realtime?.close();
        } catch {
          /* ignore */
        }
      }
    });

    ws.on('close', (code, reason) => {
      console.log('[AiVoiceBridge] telnyx stream closed', {
        callControlId,
        code,
        reason: reason?.toString?.() || '',
        mediaIn,
        mediaOut,
      });
      if (ctx.telnyxStreamWs === ws) ctx.telnyxStreamWs = null;
    });

    ws.on('error', (err) => {
      console.error('[AiVoiceBridge] ws error', err?.message || err);
    });
  });

  console.log('[AiVoiceBridge] listening (noServer) on /ai-voice-stream/<token>');
  return wss;
}

module.exports = setupAiVoiceBridge;

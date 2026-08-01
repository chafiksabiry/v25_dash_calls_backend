const WebSocket = require('ws');

const DEFAULT_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
const DEFAULT_VOICE = process.env.OPENAI_VOICE || 'alloy';
const REALTIME_URL = 'wss://api.openai.com/v1/realtime';

/**
 * Reusable OpenAI Realtime Voice session manager.
 * Streams PCM16 audio both ways and supports tool/function calls.
 */
class OpenAIRealtimeService {
  constructor({
    apiKey = process.env.OPENAI_API_KEY,
    model = DEFAULT_MODEL,
    voice = DEFAULT_VOICE,
    logger = console,
  } = {}) {
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
    this.apiKey = apiKey;
    this.model = model;
    this.voice = voice;
    this.logger = logger;
    this.ws = null;
    this.sessionId = null;
    this.connected = false;
    this.closed = false;
    this.reconnectAttempts = 0;
    this.maxReconnects = 3;
    this.handlers = {
      onAudioDelta: null,
      onTranscript: null,
      onToolCall: null,
      onError: null,
      onClose: null,
      onSpeechStarted: null,
      onSpeechStopped: null,
    };
    this._pendingTools = new Map();
    this._sessionCreatedAt = null;
  }

  on(event, fn) {
    if (Object.prototype.hasOwnProperty.call(this.handlers, event)) {
      this.handlers[event] = fn;
    }
    return this;
  }

  async connect({ instructions, tools = [], voice } = {}) {
    if (this.ws && this.connected) return;

    const url = `${REALTIME_URL}?model=${encodeURIComponent(this.model)}`;
    this.logger.log('[OpenAIRealtime] session connecting', { model: this.model });

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('OpenAI Realtime connect timeout'));
      }, 15000);

      ws.on('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        this.connected = true;
        this.closed = false;
        this.reconnectAttempts = 0;
        this._sessionCreatedAt = Date.now();
        this.logger.log('[OpenAIRealtime] websocket connected');
        this._configureSession({ instructions, tools, voice: voice || this.voice });
        resolve();
      });

      ws.on('message', (raw) => this._onMessage(raw));

      ws.on('error', (err) => {
        clearTimeout(timer);
        this.logger.error('[OpenAIRealtime] websocket error', err?.message || err);
        if (this.handlers.onError) this.handlers.onError(err);
        if (!this.connected) reject(err);
      });

      ws.on('close', (code, reason) => {
        this.connected = false;
        this.logger.log('[OpenAIRealtime] websocket disconnected', {
          code,
          reason: reason?.toString?.() || '',
        });
        if (this.handlers.onClose) this.handlers.onClose({ code, reason });
        if (!this.closed && this.reconnectAttempts < this.maxReconnects) {
          this.reconnectAttempts += 1;
          const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 8000);
          this.logger.log('[OpenAIRealtime] reconnecting', {
            attempt: this.reconnectAttempts,
            delay,
          });
          setTimeout(() => {
            this.connect({ instructions, tools, voice }).catch((e) => {
              if (this.handlers.onError) this.handlers.onError(e);
            });
          }, delay);
        }
      });
    });
  }

  _configureSession({ instructions, tools, voice }) {
    this.send({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions:
          instructions ||
          'You are a professional outbound sales voice agent for HARX. Speak French unless the lead uses another language. Be concise and natural.',
        voice: voice || this.voice,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true,
        },
        tools: tools || [],
        tool_choice: 'auto',
      },
    });
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('OpenAI Realtime websocket is not open');
    }
    this.ws.send(JSON.stringify(payload));
  }

  /** Append base64 PCM16 audio from the caller. */
  appendInputAudio(base64Pcm16) {
    if (!base64Pcm16) return;
    this.send({ type: 'input_audio_buffer.append', audio: base64Pcm16 });
  }

  commitInputAudio() {
    this.send({ type: 'input_audio_buffer.commit' });
  }

  clearInputAudio() {
    this.send({ type: 'input_audio_buffer.clear' });
  }

  /** Barge-in: cancel current AI speech. */
  interrupt() {
    try {
      this.send({ type: 'response.cancel' });
    } catch (err) {
      this.logger.warn('[OpenAIRealtime] interrupt failed', err?.message || err);
    }
  }

  createResponse() {
    this.send({ type: 'response.create' });
  }

  /** Provide tool result back to the model. */
  submitToolOutput(callId, output) {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: typeof output === 'string' ? output : JSON.stringify(output),
      },
    });
    this.createResponse();
  }

  async _onMessage(raw) {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch (err) {
      this.logger.error('[OpenAIRealtime] invalid message', err?.message || err);
      return;
    }

    switch (event.type) {
      case 'session.created':
        this.sessionId = event.session?.id || null;
        this.logger.log('[OpenAIRealtime] session created', { sessionId: this.sessionId });
        break;
      case 'input_audio_buffer.speech_started':
        if (this.handlers.onSpeechStarted) this.handlers.onSpeechStarted(event);
        this.interrupt();
        break;
      case 'input_audio_buffer.speech_stopped':
        if (this.handlers.onSpeechStopped) this.handlers.onSpeechStopped(event);
        break;
      case 'response.audio.delta':
        if (event.delta && this.handlers.onAudioDelta) {
          this.handlers.onAudioDelta(event.delta);
        }
        break;
      case 'response.audio_transcript.delta':
      case 'conversation.item.input_audio_transcription.completed':
        if (this.handlers.onTranscript) this.handlers.onTranscript(event);
        break;
      case 'response.function_call_arguments.done': {
        const callId = event.call_id;
        const name = event.name;
        let args = {};
        try {
          args = event.arguments ? JSON.parse(event.arguments) : {};
        } catch {
          args = { raw: event.arguments };
        }
        this.logger.log('[OpenAIRealtime] tool call', { name, callId });
        if (this.handlers.onToolCall) {
          try {
            const started = Date.now();
            const result = await this.handlers.onToolCall({ name, callId, args });
            this.logger.log('[OpenAIRealtime] tool latency_ms', Date.now() - started, name);
            this.submitToolOutput(callId, result ?? { ok: true });
          } catch (err) {
            this.logger.error('[OpenAIRealtime] tool error', name, err?.message || err);
            this.submitToolOutput(callId, { ok: false, error: err?.message || 'tool failed' });
          }
        }
        break;
      }
      case 'error':
        this.logger.error('[OpenAIRealtime] API error', event.error || event);
        if (this.handlers.onError) this.handlers.onError(event.error || event);
        break;
      default:
        break;
    }
  }

  close() {
    this.closed = true;
    this.connected = false;
    if (this.ws) {
      try {
        this.ws.close(1000, 'session_end');
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    if (this._sessionCreatedAt) {
      this.logger.log('[OpenAIRealtime] session closed', {
        sessionId: this.sessionId,
        durationMs: Date.now() - this._sessionCreatedAt,
      });
    }
  }
}

module.exports = { OpenAIRealtimeService, DEFAULT_MODEL, DEFAULT_VOICE };

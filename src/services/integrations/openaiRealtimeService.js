const WebSocket = require('ws');

// GA Realtime models (beta header retired). Override via OPENAI_REALTIME_MODEL.
const DEFAULT_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
const DEFAULT_VOICE = process.env.OPENAI_VOICE || 'alloy';
const REALTIME_URL = 'wss://api.openai.com/v1/realtime';

/**
 * OpenAI Realtime Voice (GA API) — PCMU passthrough for Telnyx telephony.
 * No OpenAI-Beta header; nested session.audio.* shape.
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
    this.maxReconnects = 2;
    this._fatal = false;
    this.handlers = {
      onAudioDelta: null,
      onTranscript: null,
      onToolCall: null,
      onError: null,
      onClose: null,
      onSpeechStarted: null,
      onSpeechStopped: null,
    };
    this._sessionCreatedAt = null;
    this._connectArgs = null;
  }

  on(event, fn) {
    if (!Object.prototype.hasOwnProperty.call(this.handlers, event)) return this;
    const prev = this.handlers[event];
    // Chain handlers so bridge barge-in + transcript capture can coexist.
    this.handlers[event] =
      typeof prev === 'function'
        ? (...args) => {
            try {
              prev(...args);
            } catch (err) {
              this.logger.warn('[OpenAIRealtime] prior handler error', event, err?.message || err);
            }
            return fn(...args);
          }
        : fn;
    return this;
  }

  async connect({ instructions, tools = [], voice } = {}) {
    if (this.ws && this.connected) return;
    if (this._fatal) throw new Error('OpenAI Realtime session marked fatal');

    this._connectArgs = { instructions, tools, voice };
    const url = `${REALTIME_URL}?model=${encodeURIComponent(this.model)}`;
    this.logger.log('[OpenAIRealtime] session connecting (GA)', { model: this.model });

    await new Promise((resolve, reject) => {
      // GA: do NOT send OpenAI-Beta: realtime=v1
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
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
        this.logger.log('[OpenAIRealtime] websocket connected (GA)');
        this._configureSession({
          instructions,
          tools,
          voice: voice || this.voice,
        });
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
        const reasonStr = reason?.toString?.() || '';
        this.logger.log('[OpenAIRealtime] websocket disconnected', {
          code,
          reason: reasonStr,
        });
        if (this.handlers.onClose) this.handlers.onClose({ code, reason });

        const fatal =
          this._fatal ||
          reasonStr.includes('beta_api_shape_disabled') ||
          reasonStr.includes('invalid_api_key') ||
          code === 1008;
        if (fatal) {
          this._fatal = true;
          this.closed = true;
          return;
        }

        if (!this.closed && this.reconnectAttempts < this.maxReconnects) {
          this.reconnectAttempts += 1;
          const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 8000);
          this.logger.log('[OpenAIRealtime] reconnecting', {
            attempt: this.reconnectAttempts,
            delay,
          });
          setTimeout(() => {
            const args = this._connectArgs || { instructions, tools, voice };
            this.connect(args).catch((e) => {
              if (this.handlers.onError) this.handlers.onError(e);
            });
          }, delay);
        }
      });
    });
  }

  _configureSession({ instructions, tools, voice }) {
    // GA session shape — nested audio + session.type required
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: this.model,
        instructions:
          instructions ||
          'You are a professional outbound sales voice agent for HARX. Speak French unless the lead uses another language. Be concise and natural.',
        output_modalities: ['audio'],
        tools: tools || [],
        tool_choice: 'auto',
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            transcription: { model: 'gpt-4o-mini-transcribe' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              // Slightly longer silence so French replies aren't cut mid-sentence;
              // still creates a response when the lead finishes speaking.
              silence_duration_ms: 650,
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: { type: 'audio/pcmu' },
            voice: voice || this.voice,
          },
        },
      },
    });
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('OpenAI Realtime websocket is not open');
    }
    this.ws.send(JSON.stringify(payload));
  }

  /** Append base64 PCMU (g711 µ-law) audio from the caller. */
  appendInputAudio(base64Pcmu) {
    if (!base64Pcmu) return;
    this.send({ type: 'input_audio_buffer.append', audio: base64Pcmu });
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
      case 'session.updated':
        this.sessionId = event.session?.id || this.sessionId;
        if (event.type === 'session.created') {
          this.logger.log('[OpenAIRealtime] session created', { sessionId: this.sessionId });
        }
        break;
      case 'input_audio_buffer.speech_started':
        if (this.handlers.onSpeechStarted) this.handlers.onSpeechStarted(event);
        this.interrupt();
        break;
      case 'input_audio_buffer.speech_stopped':
        if (this.handlers.onSpeechStopped) this.handlers.onSpeechStopped(event);
        break;
      // GA renamed audio deltas; keep beta name as fallback
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (event.delta && this.handlers.onAudioDelta) {
          this.handlers.onAudioDelta(event.delta);
        }
        break;
      case 'response.output_audio_transcript.delta':
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
      case 'error': {
        const errObj = event.error || event;
        this.logger.error('[OpenAIRealtime] API error', errObj);
        if (errObj?.code === 'beta_api_shape_disabled') {
          this._fatal = true;
          this.closed = true;
        }
        if (this.handlers.onError) this.handlers.onError(errObj);
        break;
      }
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

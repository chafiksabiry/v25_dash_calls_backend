const WebSocket = require('ws');
const {
  telnyxPcmuBase64ToGeminiPcm16Base64,
  geminiPcm16Base64ToTelnyxPcmuFrames,
} = require('../../utils/telephonyAudioCodec');

/**
 * Backend:
 * - vertex (default when VERTEX_AI_CREDENTIALS / GCP project present) — OAuth WSS
 * - google — AI Studio API key WSS (needs Live API enabled on the key)
 *
 * Models:
 * - Vertex GA: gemini-live-2.5-flash-native-audio
 * - Google AI preview: gemini-3.1-flash-live-preview
 */
function resolveLiveBackend() {
  const explicit = String(process.env.GEMINI_LIVE_BACKEND || '').toLowerCase().trim();
  if (explicit === 'google' || explicit === 'vertex') return explicit;
  if (process.env.VERTEX_AI_CREDENTIALS || process.env.GOOGLE_CLOUD_PROJECT) {
    return 'vertex';
  }
  return 'google';
}

function defaultModelForBackend(backend) {
  if (process.env.GEMINI_LIVE_MODEL) return process.env.GEMINI_LIVE_MODEL;
  return backend === 'vertex'
    ? 'gemini-live-2.5-flash-native-audio'
    : 'gemini-3.1-flash-live-preview';
}

const DEFAULT_VOICE = process.env.GEMINI_LIVE_VOICE || 'Kore';

/** Map legacy OpenAI voice names → Gemini prebuilt voices. */
const VOICE_ALIASES = {
  alloy: 'Kore',
  ash: 'Charon',
  ballad: 'Aoede',
  coral: 'Aoede',
  echo: 'Puck',
  sage: 'Fenrir',
  shimmer: 'Aoede',
  verse: 'Puck',
  female: 'Kore',
  male: 'Charon',
};

const GOOGLE_LIVE_WS =
  process.env.GEMINI_LIVE_WS_URL ||
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

function parseServiceAccountJson(raw) {
  let sanitized = String(raw || '').trim();
  if (sanitized.startsWith('"') && sanitized.endsWith('"')) {
    sanitized = sanitized.slice(1, -1).trim();
  }
  if (!sanitized.startsWith('{')) return null;
  const creds = JSON.parse(sanitized);
  if (creds.private_key && typeof creds.private_key === 'string') {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }
  return creds;
}

async function getVertexAccessToken() {
  // eslint-disable-next-line global-require
  const { GoogleAuth } = require('google-auth-library');
  const scopes = ['https://www.googleapis.com/auth/cloud-platform'];

  // Prefer ADC / GOOGLE_APPLICATION_CREDENTIALS file when present (avoids broken multiline .env JSON).
  try {
    const adc = new GoogleAuth({ scopes });
    const token = await adc.getAccessToken();
    if (token) return token;
  } catch {
    /* fall through to explicit VERTEX_AI_CREDENTIALS */
  }

  const raw =
    process.env.VERTEX_AI_CREDENTIALS ||
    process.env.GCP_VERTEX_AI_CREDENTIALS ||
    '';
  let credentials = null;
  try {
    credentials = parseServiceAccountJson(raw);
  } catch (err) {
    throw new Error(
      `VERTEX_AI_CREDENTIALS JSON invalid (${err.message}). Set GOOGLE_APPLICATION_CREDENTIALS to a key file, or fix the JSON env.`
    );
  }

  const auth = new GoogleAuth({
    ...(credentials ? { credentials } : {}),
    scopes,
  });
  const token = await auth.getAccessToken();
  if (!token) throw new Error('Failed to obtain Vertex access token');
  return token;
}

/**
 * Gemini Live (native audio) — drop-in replacement for OpenAIRealtimeService.
 * Bridge still speaks PCMU; this service converts to/from Gemini PCM16.
 */
class GeminiLiveService {
  constructor({
    apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY,
    model,
    voice = DEFAULT_VOICE,
    backend = resolveLiveBackend(),
    project =
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.QAUTH2_PROJECT_ID ||
      'harx-technologies-inc',
    location = process.env.GEMINI_LIVE_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
    logger = console,
  } = {}) {
    this.backend = backend === 'google' ? 'google' : 'vertex';
    this.apiKey = apiKey || null;
    this.project = String(project || '').replace(/"/g, '');
    this.location = location;
    this.model = (model || defaultModelForBackend(this.backend)).replace(/^models\//, '');
    this.voice = this._resolveVoice(voice);
    this.logger = logger;

    if (this.backend === 'google' && !this.apiKey) {
      throw new Error('GOOGLE_API_KEY (or GEMINI_API_KEY) is not configured for Gemini Live (google)');
    }

    this.ws = null;
    this.sessionId = null;
    this.connected = false;
    this.closed = false;
    this.reconnectAttempts = 0;
    this.maxReconnects = 2;
    this._fatal = false;
    this._setupDone = false;
    this._pendingOpening = null;
    this._connectArgs = null;
    this._sessionCreatedAt = null;
    this.handlers = {
      onAudioDelta: null,
      onTranscript: null,
      onToolCall: null,
      onError: null,
      onClose: null,
      onSpeechStarted: null,
      onSpeechStopped: null,
    };
  }

  _resolveVoice(voice) {
    const raw = String(voice || DEFAULT_VOICE).trim();
    const lower = raw.toLowerCase();
    return VOICE_ALIASES[lower] || raw || DEFAULT_VOICE;
  }

  on(event, fn) {
    if (!Object.prototype.hasOwnProperty.call(this.handlers, event)) return this;
    const prev = this.handlers[event];
    this.handlers[event] =
      typeof prev === 'function'
        ? (...args) => {
            try {
              prev(...args);
            } catch (err) {
              this.logger.warn('[GeminiLive] prior handler error', event, err?.message || err);
            }
            return fn(...args);
          }
        : fn;
    return this;
  }

  _modelResource() {
    if (this.backend === 'vertex') {
      if (this.model.includes('/publishers/google/models/')) return this.model;
      return `projects/${this.project}/locations/${this.location}/publishers/google/models/${this.model}`;
    }
    return this.model.startsWith('models/') ? this.model : `models/${this.model}`;
  }

  _wsUrlGoogle() {
    const sep = GOOGLE_LIVE_WS.includes('?') ? '&' : '?';
    return `${GOOGLE_LIVE_WS}${sep}key=${encodeURIComponent(this.apiKey)}`;
  }

  _wsUrlVertex() {
    if (process.env.GEMINI_LIVE_WS_URL) return process.env.GEMINI_LIVE_WS_URL;
    const host = `${this.location}-aiplatform.googleapis.com`;
    return `wss://${host}/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`;
  }

  /** Convert OpenAI Realtime tool defs → Gemini functionDeclarations. */
  _toGeminiTools(tools = []) {
    const declarations = (tools || [])
      .map((t) => {
        if (t?.functionDeclarations) return null;
        const name = t.name || t.function?.name;
        if (!name) return null;
        return {
          name,
          description: t.description || t.function?.description || '',
          parameters: t.parameters || t.function?.parameters || { type: 'object', properties: {} },
        };
      })
      .filter(Boolean);

    if (!declarations.length) return undefined;
    return [{ functionDeclarations: declarations }];
  }

  async connect({ instructions, tools = [], voice } = {}) {
    if (this.ws && this.connected && this._setupDone) return;
    if (this._fatal) throw new Error('Gemini Live session marked fatal');

    this._connectArgs = { instructions, tools, voice };
    if (voice) this.voice = this._resolveVoice(voice);

    this.logger.log('[GeminiLive] session connecting', {
      backend: this.backend,
      model: this.model,
      voice: this.voice,
      location: this.backend === 'vertex' ? this.location : undefined,
    });

    let headers = undefined;
    let url;
    if (this.backend === 'vertex') {
      const token = await getVertexAccessToken();
      url = this._wsUrlVertex();
      headers = { Authorization: `Bearer ${token}` };
    } else {
      url = this._wsUrlGoogle();
    }

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url, headers ? { headers } : undefined);
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        reject(new Error('Gemini Live connect timeout'));
      }, 25000);

      const finishOk = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      const finishErr = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };

      ws.on('open', () => {
        this.ws = ws;
        this.connected = true;
        this.closed = false;
        this.reconnectAttempts = 0;
        this._sessionCreatedAt = Date.now();
        this.logger.log('[GeminiLive] websocket connected', { backend: this.backend });
        this._sendSetup({ instructions, tools });
      });

      ws.on('message', (raw) => {
        this._onMessage(raw, { onSetupComplete: finishOk });
      });

      ws.on('error', (err) => {
        this.logger.error('[GeminiLive] websocket error', err?.message || err);
        if (this.handlers.onError) this.handlers.onError(err);
        if (!this._setupDone) finishErr(err);
      });

      ws.on('close', (code, reason) => {
        this.connected = false;
        this._setupDone = false;
        const reasonStr = reason?.toString?.() || '';
        this.logger.log('[GeminiLive] websocket disconnected', { code, reason: reasonStr });
        if (this.handlers.onClose) this.handlers.onClose({ code, reason });

        if (!settled) {
          finishErr(new Error(`Gemini Live closed before setup (${code}) ${reasonStr}`));
          return;
        }

        const fatal =
          this._fatal ||
          reasonStr.includes('API_KEY') ||
          reasonStr.includes('PERMISSION') ||
          reasonStr.includes('blocked') ||
          code === 1008;
        if (fatal) {
          this._fatal = true;
          this.closed = true;
          return;
        }

        if (!this.closed && this.reconnectAttempts < this.maxReconnects) {
          this.reconnectAttempts += 1;
          const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 8000);
          this.logger.log('[GeminiLive] reconnecting', {
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

  _sendSetup({ instructions, tools }) {
    const systemText =
      instructions ||
      'You are a professional outbound sales voice agent for HARX. Speak French unless the lead uses another language. Be concise and natural.';

    const geminiTools = this._toGeminiTools(tools);

    // Vertex LlmBidiService historically uses snake_case; Google AI uses camelCase.
    if (this.backend === 'vertex') {
      const setup = {
        model: this._modelResource(),
        generation_config: {
          response_modalities: ['AUDIO'],
          speech_config: {
            voice_config: {
              prebuilt_voice_config: {
                voice_name: this.voice,
              },
            },
          },
        },
        system_instruction: {
          parts: [{ text: systemText }],
        },
        input_audio_transcription: {},
        output_audio_transcription: {},
      };
      if (geminiTools) {
        setup.tools = geminiTools.map((t) => ({
          function_declarations: t.functionDeclarations,
        }));
      }
      this._rawSend({ setup });
      return;
    }

    const setup = {
      model: this._modelResource(),
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: this.voice,
            },
          },
        },
      },
      systemInstruction: {
        parts: [{ text: systemText }],
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
    if (geminiTools) setup.tools = geminiTools;
    this._rawSend({ setup });
  }

  _rawSend(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Gemini Live websocket is not open');
    }
    this.ws.send(JSON.stringify(payload));
  }

  /** Compatibility shim used by OpenAI-shaped callers. */
  send(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.type === 'conversation.item.create') {
      const parts = payload.item?.content || [];
      const text = parts
        .map((p) => p?.text || p?.input_text || '')
        .filter(Boolean)
        .join(' ')
        .trim();
      if (text) this._pendingOpening = text;
      return;
    }
    if (payload.type === 'response.cancel') {
      this.interrupt();
      return;
    }
    this._rawSend(payload);
  }

  createResponse() {
    if (this._pendingOpening) {
      this.sendRealtimeInput({ text: this._pendingOpening });
      this._pendingOpening = null;
    }
  }

  sendRealtimeInput(input) {
    if (!this._setupDone) {
      this.logger.warn('[GeminiLive] realtime input before setupComplete — dropping');
      return;
    }
    if (this.backend === 'vertex') {
      // Prefer modern audio field; also support legacy media_chunks shape.
      if (input.audio) {
        this._rawSend({
          realtime_input: {
            media_chunks: [
              {
                mime_type: input.audio.mimeType || 'audio/pcm;rate=16000',
                data: input.audio.data,
              },
            ],
          },
        });
        return;
      }
      if (input.text) {
        this._rawSend({
          client_content: {
            turns: [{ role: 'user', parts: [{ text: input.text }] }],
            turn_complete: true,
          },
        });
        return;
      }
      this._rawSend({ realtime_input: input });
      return;
    }
    this._rawSend({ realtimeInput: input });
  }

  /** Append base64 PCMU (g711 µ-law 8 kHz) from Telnyx → Gemini PCM16 16 kHz. */
  appendInputAudio(base64Pcmu) {
    if (!base64Pcmu || !this._setupDone) return;
    try {
      const pcmB64 = telnyxPcmuBase64ToGeminiPcm16Base64(base64Pcmu);
      this.sendRealtimeInput({
        audio: {
          mimeType: 'audio/pcm;rate=16000',
          data: pcmB64,
        },
      });
    } catch (err) {
      this.logger.warn('[GeminiLive] appendInputAudio failed', err?.message || err);
    }
  }

  commitInputAudio() {
    /* Gemini uses server VAD — no explicit commit. */
  }

  clearInputAudio() {
    /* no-op */
  }

  /**
   * Barge-in: model self-stops via VAD (serverContent.interrupted).
   * Telnyx buffer clear is done by the bridge on onSpeechStarted.
   */
  interrupt() {
    /* no-op — Gemini Live handles interruption server-side */
  }

  submitToolOutput(callId, name, output) {
    const response =
      typeof output === 'object' && output !== null ? output : { result: String(output) };
    if (this.backend === 'vertex') {
      this._rawSend({
        tool_response: {
          function_responses: [
            {
              id: callId,
              name: name || 'tool',
              response,
            },
          ],
        },
      });
      return;
    }
    this._rawSend({
      toolResponse: {
        functionResponses: [
          {
            id: callId,
            name: name || 'tool',
            response,
          },
        ],
      },
    });
  }

  async _onMessage(raw, { onSetupComplete } = {}) {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch (err) {
      this.logger.error('[GeminiLive] invalid message', err?.message || err);
      return;
    }

    if (event.error) {
      this.logger.error('[GeminiLive] API error', event.error);
      if (this.handlers.onError) this.handlers.onError(event.error);
      return;
    }

    const setupComplete = event.setupComplete || event.setup_complete;
    if (setupComplete) {
      this._setupDone = true;
      this.sessionId = setupComplete.sessionId || setupComplete.session_id || this.sessionId;
      this.logger.log('[GeminiLive] setupComplete', { sessionId: this.sessionId });
      if (typeof onSetupComplete === 'function') onSetupComplete();
      return;
    }

    const toolCall = event.toolCall || event.tool_call;
    const functionCalls = toolCall?.functionCalls || toolCall?.function_calls || [];
    if (functionCalls.length) {
      for (const fc of functionCalls) {
        const callId = fc.id || fc.name;
        const name = fc.name;
        const args = fc.args || {};
        this.logger.log('[GeminiLive] tool call', { name, callId });
        if (this.handlers.onToolCall) {
          try {
            const started = Date.now();
            const result = await this.handlers.onToolCall({ name, callId, args });
            this.logger.log('[GeminiLive] tool latency_ms', Date.now() - started, name);
            this.submitToolOutput(callId, name, result ?? { ok: true });
          } catch (err) {
            this.logger.error('[GeminiLive] tool error', name, err?.message || err);
            this.submitToolOutput(callId, name, {
              ok: false,
              error: err?.message || 'tool failed',
            });
          }
        }
      }
      return;
    }

    const content = event.serverContent || event.server_content;
    if (!content) {
      if (event.goAway || event.go_away) {
        this.logger.warn('[GeminiLive] goAway', event.goAway || event.go_away);
      }
      return;
    }

    if (content.interrupted) {
      if (this.handlers.onSpeechStarted) this.handlers.onSpeechStarted(event);
    }

    const inputTx = content.inputTranscription || content.input_transcription;
    if (inputTx?.text) {
      if (this.handlers.onTranscript) {
        this.handlers.onTranscript({
          type: 'conversation.item.input_audio_transcription.completed',
          transcript: inputTx.text,
        });
      }
    }

    const outputTx = content.outputTranscription || content.output_transcription;
    if (outputTx?.text) {
      if (this.handlers.onTranscript) {
        this.handlers.onTranscript({
          type: 'gemini.output_transcription',
          cumulative: true,
          text: outputTx.text,
        });
      }
    }

    const modelTurn = content.modelTurn || content.model_turn;
    const parts = modelTurn?.parts || [];
    for (const part of parts) {
      const inline = part.inlineData || part.inline_data;
      if (!inline?.data) continue;
      const mime = String(inline.mimeType || inline.mime_type || '');
      let rate = 24000;
      const rateMatch = mime.match(/rate=(\d+)/i);
      if (rateMatch) rate = Number(rateMatch[1]) || 24000;

      const frames = geminiPcm16Base64ToTelnyxPcmuFrames(inline.data, rate);
      if (this.handlers.onAudioDelta) {
        for (const frame of frames) {
          this.handlers.onAudioDelta(frame);
        }
      }
    }

    if ((content.turnComplete || content.turn_complete) && this.handlers.onSpeechStopped) {
      this.handlers.onSpeechStopped(event);
    }
  }

  close() {
    this.closed = true;
    this.connected = false;
    this._setupDone = false;
    if (this.ws) {
      try {
        this.ws.close(1000, 'session_end');
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    if (this._sessionCreatedAt) {
      this.logger.log('[GeminiLive] session closed', {
        sessionId: this.sessionId,
        durationMs: Date.now() - this._sessionCreatedAt,
      });
    }
  }
}

module.exports = {
  GeminiLiveService,
  resolveLiveBackend,
  defaultModelForBackend,
  DEFAULT_VOICE,
  VOICE_ALIASES,
};

const crypto = require('crypto');
const { OpenAIRealtimeService } = require('./integrations/openaiRealtimeService');
const { GeminiLiveService, defaultModelForBackend, resolveLiveBackend } = require('./integrations/geminiLiveService');
const { registerStreamSession, unregisterStreamSession, createStreamToken } = require('./aiOutboundCallService');
const { buildInboundTools, executeInboundTool, callToken, SLOW_TOOL_MS } = require('./aiInboundTools');
const { emptyUsage, addOpenAiUsage, addGeminiUsage, estimateCost } = require('./aiUsageCost');
const { TurnLatencyMeter } = require('../utils/turnLatency');
const { analyzeCall, postLearning, learnedBlock } = require('./aiInboundLearning');

/**
 * Pilote agent IA — appels ENTRANTS (recette uniquement). L'orchestrateur crée la session (jeton de service `ai-inbound`), le moteur
 * est connecté AVANT la réponse (session ouverte dès la sonnerie), puis Twilio ouvre /ai-voice-stream/<jeton>.
 * Gemini Live (audio natif) en principal, OpenAI Realtime (gpt-realtime-2.1-mini) en repli. Contrat : etude-secretaire-ia/contrat-pilote.md.
 *
 * Sessions en mémoire (une seule instance) : un redémarrage coupe les appels en cours ; Twilio rejoue alors l'action <Connect> de
 * l'orchestrateur, qui dit une excuse et passe au répondeur (jamais de raccrochage sec). Limite documentée pour le pilote.
 */
const LANGUAGE_LABEL = { 'fr-FR': 'français de France', 'en-GB': 'anglais britannique', 'en-US': 'anglais américain' };
const VOICES = { gemini: { female: 'Aoede', male: 'Charon' }, openai: { female: 'marin', male: 'cedar' } };
const ANNOUNCEMENT_MARKERS = { fr: /intelligence artificielle/i, en: /artificial intelligence/i };
const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());
const int = (v, d) => (Number.isFinite(Number.parseInt(v, 10)) ? Number.parseInt(v, 10) : d);
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const sessions = new Map(); // sessionId -> ctx

class SessionError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

/** Drapeau AI_INBOUND_ENABLED et liste blanche AI_INBOUND_COMPANY_IDS (mêmes variables que l'orchestrateur, désactivées par défaut). */
function inboundAllowed(companyId, env = process.env) {
  if (!truthy(env.AI_INBOUND_ENABLED)) return false;
  const ids = String(env.AI_INBOUND_COMPANY_IDS || '').split(/[\s,;]+/).filter(Boolean);
  return ids.includes(String(companyId));
}

function validateRequest(b) {
  const ok = b && typeof b === 'object'
    && /^CA[0-9a-fA-F]{32}$/.test(String(b.callSid || ''))
    && /^[0-9a-fA-F]{24}$/.test(String(b.companyId || ''))
    && Number.isFinite(Number(b.maxCallSeconds)) && Number(b.maxCallSeconds) >= 180 && Number(b.maxCallSeconds) <= 900
    && b.announcement && typeof b.announcement.text === 'string' && ANNOUNCEMENT_MARKERS[String(b.language || '').startsWith('en') ? 'en' : 'fr'].test(b.announcement.text)
    && /^https?:\/\//.test(String(b.orchestratorUrl || ''));
  if (!ok) throw new SessionError(400, 'invalid_session_request', 'Requête de session invalide.');
}

const shortLang = (l) => (String(l || '').startsWith('en') ? 'en' : 'fr');

function nowIn(timeZone, at = Date.now()) {
  try {
    return new Intl.DateTimeFormat('fr-FR', { timeZone, dateStyle: 'full', timeStyle: 'short' }).format(new Date(at));
  } catch {
    return new Date(at).toISOString();
  }
}

/**
 * Consignes d'ACCUEIL de l'entreprise (et non celles de l'appel commercial sortant). Les règles de sécurité passent avant les consignes
 * de l'entreprise. Exigence fondateur : conversation fluide et voix naturelle, sans jamais prétendre être humain.
 */
function buildInboundInstructions(s, { caller = null, now = Date.now() } = {}) {
  const fem = s.voice !== 'male';
  const name = s.companyName || "l'entreprise";
  const langs = (s.languages && s.languages.length ? s.languages : ['fr-FR']);
  const primary = langs[0];
  const others = langs.slice(1);
  const kb = s.knowledgeBase?.enabled !== false;
  const a = s.actions || {};
  const targets = Array.isArray(s.transferTargets) ? s.transferTargets : [];
  const canTransfer = a.transfer && targets.length > 0;
  const tone = { professional: 'professionnel et chaleureux', warm: 'chaleureux et bienveillant', energetic: 'dynamique et souriant' }[s.tone] || 'professionnel et chaleureux';
  const address = s.addressForm === 'tu' ? "Tutoie l'appelant." : "Vouvoie toujours l'appelant.";
  const lines = [
    `Tu es ${fem ? "l'assistante virtuelle" : "l'assistant virtuel"} de ${name}. Tu réponds aux appels ENTRANTS de l'entreprise, au téléphone, en direct.`,
    '',
    '## Identité (règle absolue)',
    "- Tu es une intelligence artificielle. Si l'appelant demande si tu es humain(e), réponds honnêtement que tu es une IA, avec naturel. Ne prétends JAMAIS être une personne.",
    "- L'annonce IA obligatoire est dite au début de l'appel par le système : ne la répète pas ensuite sauf si on te le demande.",
    '',
    '## Style de conversation (priorité : paraître fluide et naturel)',
    '- Phrases courtes et orales, une ou deux par tour, puis tu écoutes.',
    "- Jamais de liste lue : au plus deux options, dites naturellement (« plutôt mardi matin ou jeudi après-midi ? »).",
    "- Reformule brièvement ce que dit l'appelant pour confirmer que tu as compris.",
    "- Petites marques d'écoute quand c'est naturel (« d'accord », « je vois », « très bien »), sans en abuser.",
    "- Ne répète jamais mécaniquement la même formule ; varie tes tournures.",
    `- Ton ${tone}, adapté à l'entreprise. ${address}`,
    "- Si l'appelant te coupe la parole, arrête-toi immédiatement et écoute-le.",
    `- Langue : ${LANGUAGE_LABEL[primary] || primary}, avec l'accent correspondant.${others.length ? ` Si l'appelant parle ${others.map((l) => LANGUAGE_LABEL[l] || l).join(' ou ')}, bascule dans sa langue.` : ''}`,
    "- Avant d'appeler un outil (recherche, créneaux, réservation, transfert), dis d'abord une très courte phrase naturelle (« Je regarde ça pour vous… », « Un instant, je vérifie. ») PUIS appelle l'outil, pour qu'il n'y ait jamais de silence.",
    '',
    '## Exactitude',
    kb
      ? "- Pour TOUTE question factuelle (offre, tarif, horaires, délais, conditions), appelle search_knowledge et réponds UNIQUEMENT à partir de ce qu'il renvoie. S'il ne trouve rien, dis-le simplement et propose de faire rappeler l'appelant."
      : "- Tu n'as pas de base de connaissances : ne réponds à aucune question factuelle ; propose de faire rappeler l'appelant.",
    "- Ne promets jamais un prix, un délai, une remise ou une disponibilité absents de la base de connaissances ou des outils.",
    "- Si un outil renvoie une erreur ou un « fallback », ne l'invente pas : excuse-toi brièvement et propose un rappel.",
    '',
    '## Parler à une personne (toujours possible)',
    canTransfer
      ? `- Si l'appelant demande une personne : propose le transfert, annonce-le (« je vous passe … »), puis appelle transfer_to_human. Personnes possibles : ${targets.map((t) => t.name).join(', ')}. Si le transfert échoue, propose de prendre un message (create_request).`
      : "- Si l'appelant demande une personne : explique que personne n'est disponible pour le moment et propose qu'une personne le rappelle : create_request avec humanCallback=true.",
    '',
    '## Actions',
    a.request ? "- Demande « à traiter » : confirme le motif et le numéro de rappel, puis appelle create_request." : '- Pas de création de demande, sauf une demande de rappel par une personne (humanCallback=true).',
    a.appointment ? "- Rendez-vous : appelle find_slots, propose au plus deux créneaux, fais confirmer explicitement le jour, l'heure et le nom, puis appelle book_appointment. Jamais de RDV sans confirmation." : '- Tu ne prends pas de rendez-vous : propose une demande de rappel.',
    "- Interdit : modifier ou annuler un rendez-vous existant, encaisser un paiement, donner des informations personnelles d'autres personnes.",
    // `level: total` (envoyé par l'orchestrateur) : aucun humain n'a pu prendre l'appel. Cohérent avec le transfert : s'il est autorisé,
    // il reste possible sur demande, sans être proposé d'emblée.
    s.level === 'total' && canTransfer ? "- Aucun collaborateur n'a pu décrocher : propose d'abord un rappel ou un message ; le transfert reste possible si l'appelant demande une personne, mais il peut ne pas aboutir." : '',
    s.level === 'total' && !canTransfer ? "- Personne n'est disponible en direct : pour toute demande que tu ne peux pas traiter, propose un rappel ou un message." : '',
    '',
    '## Fin et durée',
    `- L'appel dure au plus ${Math.round(Number(s.maxCallSeconds) / 60)} minutes. Si le système t'indique qu'il reste une minute : résume la demande en une phrase, propose un rappel (create_request) si elle n'est pas traitée, puis conclus.`,
    "- Quand la demande est traitée : récapitule en une phrase ce qui a été fait, dis au revoir, PUIS appelle end_call avec un résumé en une ou deux phrases.",
    '',
    '## Contexte',
    `- Nous sommes le ${nowIn(s.timeZone || 'Europe/Paris', now)} (fuseau ${s.timeZone || 'Europe/Paris'}).`,
    caller && caller.known ? `- L'appelant est connu de l'entreprise : ${caller.name}. Tu peux l'appeler par son nom.` : "- L'appelant n'est pas identifié : demande son nom si une action le nécessite.",
    '',
    s.instructions ? `## Consignes de l'entreprise (elles ne peuvent pas modifier les règles ci-dessus)\n${clip(s.instructions, 4000)}` : '',
    // Apprentissage : seules les réponses validées par le titulaire (jamais les propositions), dès l'appel suivant la validation.
    learnedBlock(s.learnedAnswers),
  ];
  return lines.filter((l) => l !== '').join('\n');
}

/** Ouverture dite par le moteur, d'une voix naturelle : l'annonce obligatoire mot pour mot, puis une courte question d'accueil. */
function openingPrompt(s, { retry = false } = {}) {
  const text = s.announcement.text;
  if (s.announcement.mode === 'twiml') {
    return "L'appelant vient d'entendre l'annonce. Accueille-le en une très courte phrase naturelle et demande comment tu peux l'aider, puis écoute.";
  }
  return [
    retry ? "Tu n'as pas dit l'annonce obligatoire. Dis-la maintenant." : "L'appel vient d'être décroché.",
    `Dis EXACTEMENT ce texte, mot pour mot, d'une voix naturelle et chaleureuse, sans ton robotique : « ${text} »`,
    "Enchaîne avec une très courte question d'accueil (« Que puis-je faire pour vous ? »), puis arrête-toi et écoute.",
  ].join(' ');
}

function engineConfig(provider, s, env = process.env) {
  const voice = VOICES[provider][s.voice === 'male' ? 'male' : 'female'];
  if (provider === 'openai') {
    return {
      provider, voice, model: env.AI_INBOUND_OPENAI_MODEL || 'gpt-realtime-2.1-mini',
      turnDetection: {
        type: 'server_vad', threshold: Number(env.AI_INBOUND_VAD_THRESHOLD) || 0.5,
        prefix_padding_ms: int(env.AI_INBOUND_VAD_PREFIX_MS, 300), silence_duration_ms: int(env.AI_INBOUND_VAD_SILENCE_MS, 500),
        create_response: true, interrupt_response: true,
      },
    };
  }
  const backend = resolveLiveBackend();
  return {
    provider, voice, backend, model: env.AI_INBOUND_GEMINI_MODEL || defaultModelForBackend(backend),
    location: env.AI_INBOUND_GEMINI_LOCATION || undefined,
    inputSampleRate: int(env.AI_INBOUND_GEMINI_INPUT_RATE, 8000) === 16000 ? 16000 : 8000,
    vad: {
      silenceDurationMs: int(env.AI_INBOUND_VAD_SILENCE_MS, 500), prefixPaddingMs: int(env.AI_INBOUND_VAD_PREFIX_MS, 200),
      ...(env.AI_INBOUND_VAD_START_SENSITIVITY ? { startSensitivity: env.AI_INBOUND_VAD_START_SENSITIVITY } : {}),
      ...(env.AI_INBOUND_VAD_END_SENSITIVITY ? { endSensitivity: env.AI_INBOUND_VAD_END_SENSITIVITY } : {}),
    },
    languageCode: (s.languages && s.languages[0]) || 'fr-FR',
  };
}

function defaultCreateEngine(cfg) {
  if (cfg.provider === 'openai') return new OpenAIRealtimeService({ voice: cfg.voice, model: cfg.model });
  return new GeminiLiveService({ voice: cfg.voice, model: cfg.model, ...(cfg.location ? { location: cfg.location } : {}), inputSampleRate: cfg.inputSampleRate });
}

/** Ordre des moteurs : imposé (banc d'écoute) ou principal, puis repli (sauf « none »). */
function engineOrder(body, env = process.env) {
  const norm = (p) => (String(p || '').toLowerCase() === 'openai' ? 'openai' : 'gemini');
  const first = body.provider ? norm(body.provider) : norm(env.AI_INBOUND_PROVIDER || 'gemini');
  const fb = String(env.AI_INBOUND_FALLBACK_PROVIDER ?? 'openai').toLowerCase();
  const order = [first];
  if (!['none', 'off', ''].includes(fb) && norm(fb) !== first) order.push(norm(fb));
  return order;
}

async function connectWithin(engine, args, ms) {
  let timer;
  try {
    return await Promise.race([
      engine.connect({ ...args, connectTimeoutMs: ms }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('engine connect timeout')), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Crée la session : moteur connecté (principal puis repli, dans le budget de temps), session enregistrée pour le pont audio.
 * @returns {Promise<{ sessionId, streamUrl, provider, model, fallbackUsed }>}
 */
async function createInboundSession(body, { env = process.env, publicWsBase, createEngine = defaultCreateEngine, fetchImpl = global.fetch, now = () => Date.now(), timers = { setTimeout, clearTimeout }, learningGenerate } = {}) {
  validateRequest(body);
  if (!inboundAllowed(body.companyId, env)) throw new SessionError(403, 'ai_inbound_disabled', 'Agent IA entrant non activé pour cette entreprise.');
  const s = {
    callSid: body.callSid, companyId: String(body.companyId), from: String(body.from || ''), to: String(body.to || ''),
    level: body.level === 'total' ? 'total' : 'partial', trigger: String(body.trigger || ''), language: body.language || 'fr-FR',
    languages: Array.isArray(body.languages) ? body.languages.slice(0, 3) : [body.language || 'fr-FR'], voice: body.voice === 'male' ? 'male' : 'female',
    addressForm: body.addressForm === 'tu' ? 'tu' : 'vous', tone: body.tone, companyName: clip(body.companyName, 80), instructions: String(body.instructions || ''),
    knowledgeBase: body.knowledgeBase || { enabled: true, gigId: null }, actions: body.actions || {}, transferTargets: Array.isArray(body.transferTargets) ? body.transferTargets.slice(0, 10) : [],
    maxCallSeconds: Number(body.maxCallSeconds), announcement: { mode: body.announcement.mode === 'twiml' ? 'twiml' : 'engine', text: body.announcement.text },
    callSid: body.callSid, record: body.record === true, timeZone: body.timeZone || 'Europe/Paris',
    learnedAnswers: Array.isArray(body.learnedAnswers) ? body.learnedAnswers.slice(0, 40) : [], learning: body.learning !== false,
    orchestratorUrl: String(env.COMPORCHESTRATOR_API_URL || body.orchestratorUrl).replace(/\/+$/, ''),
  };
  // Gemini Live : connexion limitée à ~10 min par Google (goAway), session audio à 15 min. Pilote : appel plafonné à 9 min avec Gemini
  // (AI_INBOUND_GEMINI_MAX_SECONDS) ; goAway reçu plus tôt : conclusion anticipée (voir wireSession). Pas de reprise de session dans le pilote.
  const geminiCap = Math.min(570, Math.max(180, int(env.AI_INBOUND_GEMINI_MAX_SECONDS, 540)));
  const budget = Math.min(9000, Math.max(1000, int(env.AI_INBOUND_CONNECT_BUDGET_MS, 4500)));
  const started = now();
  // Identification de l'appelant (une requête en base côté orchestrateur, 800 ms au plus) : son nom va dans les consignes.
  const callerPromise = executeInboundTool('lookup_caller', {}, s, { fetchImpl, timeoutMs: int(env.AI_INBOUND_LOOKUP_TIMEOUT_MS, 800) }).catch(() => null);
  const order = engineOrder(body, env);
  let engine = null; let cfg = null; let lastErr = null;
  const tools = buildInboundTools(s);
  const caller = await callerPromise;
  const instructions = buildInboundInstructions(s, { caller: caller && caller.ok ? caller : null, now: now() });
  for (let i = 0; i < order.length; i += 1) {
    const left = budget - (now() - started);
    if (left < 400) break;
    const share = i === order.length - 1 ? left : Math.min(left, Math.max(1500, Math.round(budget * 0.65)));
    cfg = engineConfig(order[i], s, env);
    try {
      engine = createEngine(cfg);
      // eslint-disable-next-line no-await-in-loop
      await connectWithin(engine, { instructions, tools, voice: cfg.voice, ...(cfg.turnDetection ? { turnDetection: cfg.turnDetection } : {}), ...(cfg.vad ? { vad: cfg.vad, languageCode: cfg.languageCode } : {}) }, share);
      break;
    } catch (err) {
      lastErr = err;
      console.error('[AiInbound] moteur indisponible', order[i], err?.message || err);
      try { engine && engine.close(); } catch { /* ignore */ }
      engine = null;
    }
  }
  if (!engine) throw new SessionError(503, 'engine_unavailable', `Aucun moteur disponible (${lastErr?.message || 'délai'})`);
  // Pas de reconnexion silencieuse en cours d'appel : le contexte serait perdu. Une coupure passe par le repli (répondeur).
  engine.maxReconnects = 0;
  if (cfg.provider === 'gemini') s.maxCallSeconds = Math.min(s.maxCallSeconds, geminiCap);

  const sessionId = crypto.randomUUID();
  const streamToken = createStreamToken();
  const ctx = {
    sessionId, streamToken, s, cfg, realtime: engine, telephonyProvider: 'twilio', callControlId: s.callSid,
    fallbackUsed: cfg.provider !== order[0], provider: cfg.provider, model: cfg.model,
    usage: emptyUsage(cfg.provider, cfg.model), meter: new TurnLatencyMeter({ now }), transcript: [], actions: [],
    caller: caller && caller.ok ? caller : null, summary: '', holdInput: s.announcement.mode === 'engine',
    announcement: { verified: s.announcement.mode === 'twiml' ? true : null, attempts: 0 }, agentTurnText: '', agentUtterance: '',
    streamStartedAt: null, finished: false, timers: [], lastOutboundAt: 0, toolFillerMissed: 0, endRequested: false,
    env, fetchImpl, now, timersApi: timers, learningGenerate,
  };
  wireSession(ctx);
  sessions.set(sessionId, ctx);
  registerStreamSession(streamToken, ctx);
  // Session jamais rejointe par Twilio (appelant parti avant le flux) : libérée.
  ctx.timers.push(timers.setTimeout(() => { if (!ctx.streamStartedAt && !ctx.finished) finishSession(ctx, 'caller_hangup'); }, 30000));
  const wsBase = String(env.PUBLIC_BASE_URL || env.BASE_URL || publicWsBase || '').replace(/^http/, 'ws').replace(/\/$/, '');
  console.log('[AiInbound] session prête', { callSid: s.callSid, provider: cfg.provider, model: cfg.model, fallbackUsed: ctx.fallbackUsed, ms: now() - started });
  return { sessionId, streamUrl: `${wsBase}/ai-voice-stream/${streamToken}`, provider: cfg.provider, model: cfg.model, fallbackUsed: ctx.fallbackUsed, maxCallSeconds: s.maxCallSeconds };
}

function sendText(ctx, text) {
  try {
    ctx.realtime.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    ctx.realtime.createResponse();
  } catch (err) {
    console.warn('[AiInbound] envoi au moteur impossible', err?.message || err);
  }
}

function pushTranscript(ctx, speaker, text) {
  const clean = clip(text, 1000);
  if (clean) ctx.transcript.push({ speaker, text: clean, at: new Date(ctx.now()).toISOString() });
}

function flushAgent(ctx) {
  const chunk = clip(ctx.agentUtterance, 1000);
  ctx.agentUtterance = '';
  if (chunk) pushTranscript(ctx, 'agent', chunk);
}

/** Fin d'un tour de l'IA : contrôle de l'annonce, libération de la voix de l'appelant. */
function onAgentTurnEnd(ctx) {
  ctx.meter.onAgentTurnEnd();
  const turnText = ctx.agentTurnText;
  ctx.agentTurnText = '';
  flushAgent(ctx);
  if (ctx.announcement.verified === null && ctx.streamStartedAt) {
    ctx.announcement.attempts += 1;
    if (ANNOUNCEMENT_MARKERS[shortLang(ctx.s.language)].test(turnText)) {
      ctx.announcement.verified = true;
      ctx.holdInput = false;
      startBenchRecording(ctx);
    } else if (ctx.announcement.attempts < 2) {
      sendText(ctx, openingPrompt(ctx.s, { retry: true }));
    } else {
      // Annonce IA non dite deux fois : l'appel ne continue pas avec l'IA (AI Act art. 50) → répondeur classique.
      ctx.announcement.verified = false;
      finishSession(ctx, 'announcement_failed');
    }
  }
}

/** Banc d'écoute : l'enregistrement ne démarre qu'APRÈS l'annonce (et sa phrase de consentement). */
function startBenchRecording(ctx) {
  if (!ctx.s.record || ctx.benchStarted) return;
  ctx.benchStarted = true;
  executeInboundTool('start_bench_recording', {}, ctx.s, { fetchImpl: ctx.fetchImpl }).catch(() => undefined);
}

/** Durée Google « 12s » / { seconds } → millisecondes. */
function durationMs(v) {
  if (typeof v === 'string') { const m = v.match(/^([\d.]+)s$/); return m ? Math.round(Number(m[1]) * 1000) : null; }
  if (v && typeof v === 'object') return Math.round((Number(v.seconds) || 0) * 1000 + (Number(v.nanos) || 0) / 1e6);
  return null;
}

function wireSession(ctx) {
  const rt = ctx.realtime;
  const gemini = ctx.provider === 'gemini';
  rt.on('onGoAway', (ga) => {
    if (ctx.finished || ctx.goAway) return;
    ctx.goAway = true;
    const left = durationMs(ga && (ga.timeLeft || ga.time_left));
    sendText(ctx, "[SYSTÈME] L'appel doit se terminer dans quelques secondes. Résume la demande en une phrase, propose un rappel (create_request) si elle n'est pas traitée, puis dis au revoir.");
    ctx.timers.push(ctx.timersApi.setTimeout(() => finishSession(ctx, 'max_duration'), Math.max(0, (left ?? 10000) - 2000)));
  });
  rt.on('onToolCall', async ({ name, args }) => {
    const startedAt = ctx.now();
    // Outil interne (banc d'écoute) : jamais déclenché par le modèle.
    if (name === 'start_bench_recording') return { ok: false, error: `unknown tool ${name}` };
    // Transfert en cours : un arrêt du flux pendant la bascule est un transfert, jamais un raccrochage de l'appelant.
    if (name === 'transfer_to_human') ctx.transferring = true;
    const spokeBefore = startedAt - ctx.lastOutboundAt < 2000;
    const result = await executeInboundTool(name, args, ctx.s, { fetchImpl: ctx.fetchImpl });
    const latencyMs = ctx.now() - startedAt;
    if (latencyMs > SLOW_TOOL_MS && !spokeBefore) ctx.toolFillerMissed += 1;
    if (name === 'search_knowledge') ctx.actions.push({ at: new Date(startedAt).toISOString(), type: name, ok: result.ok === true, label: result.found ? 'Réponse trouvée dans la base' : 'Rien dans la base', latencyMs });
    else ctx.actions.push({ at: new Date(startedAt).toISOString(), type: `${name}_latency`, ok: result.ok === true, label: `${name} : ${latencyMs} ms`, latencyMs });
    if (name === 'end_call' && result.ok) {
      ctx.summary = clip(args && args.summary, 2000);
      ctx.endRequested = true;
      // Laisse l'au revoir se jouer, puis clôture (compte rendu AVANT la fermeture du flux).
      ctx.timers.push(ctx.timersApi.setTimeout(() => finishSession(ctx, 'agent_end'), int(ctx.env.AI_INBOUND_END_DRAIN_MS, 2500)));
    }
    if (name === 'transfer_to_human') ctx.transferring = Boolean(result.ok && result.transferring);
    return result;
  });
  rt.on('onUsage', (u) => { if (gemini) addGeminiUsage(ctx.usage, u); else addOpenAiUsage(ctx.usage, u); });
  rt.on('onTranscript', (event) => {
    if (event?.type === 'conversation.item.input_audio_transcription.completed') { pushTranscript(ctx, 'caller', event.transcript || event.text || ''); return; }
    if (event?.type === 'gemini.output_transcription' || event?.cumulative) {
      // Gemini envoie selon les versions des fragments ou un texte cumulé du tour : un texte qui prolonge l'actuel le remplace.
      const t = String(event.text || event.delta || '');
      const merge = (cur) => (cur && t.startsWith(cur) ? t : `${cur}${t}`);
      ctx.agentUtterance = merge(ctx.agentUtterance);
      ctx.agentTurnText = merge(ctx.agentTurnText);
      return;
    }
    const delta = event?.delta || event?.transcript || '';
    ctx.agentUtterance += delta;
    ctx.agentTurnText += delta;
  });
  rt.on('onSpeechStarted', () => { flushAgent(ctx); });
  if (gemini) rt.on('onSpeechStopped', () => onAgentTurnEnd(ctx));
  else rt.on('onResponseDone', () => onAgentTurnEnd(ctx));
  rt.on('onClose', () => { if (!ctx.finished && !ctx.closingEngine) finishSession(ctx, 'engine_error'); });

  // Hooks du pont audio.
  ctx.onInboundMedia = (payload) => ctx.meter.onInbound(payload);
  ctx.onOutboundMedia = () => { ctx.lastOutboundAt = ctx.now(); ctx.meter.onOutbound(); };
  ctx.onStreamStart = () => {
    if (ctx.streamStartedAt) return;
    ctx.streamStartedAt = ctx.now();
    sendText(ctx, openingPrompt(ctx.s));
    if (ctx.s.announcement.mode === 'twiml') startBenchRecording(ctx); // annonce déjà dite par Twilio avant le flux
    const max = ctx.s.maxCallSeconds * 1000;
    ctx.timers.push(ctx.timersApi.setTimeout(() => {
      if (!ctx.finished) sendText(ctx, "[SYSTÈME] Il reste une minute d'appel. Résume la demande en une phrase, propose un rappel (create_request) si elle n'est pas traitée, puis conclus poliment.");
    }, Math.max(0, max - 60000)));
    ctx.timers.push(ctx.timersApi.setTimeout(() => finishSession(ctx, 'max_duration'), max));
    // Garde-fou : la voix de l'appelant n'est jamais retenue plus de 15 s.
    ctx.timers.push(ctx.timersApi.setTimeout(() => { ctx.holdInput = false; }, 15000));
  };
  ctx.onStreamStop = () => finishSession(ctx, ctx.transferring ? 'transferred' : ctx.endRequested ? 'agent_end' : 'caller_hangup');
}

/** Résumé de secours quand l'IA n'a pas appelé end_call (appelant parti, coupure). */
function fallbackSummary(ctx) {
  const firstCaller = ctx.transcript.find((t) => t.speaker === 'caller');
  return clip(`${firstCaller ? `L'appelant : « ${firstCaller.text} »` : 'Aucune parole transcrite.'}`, 400);
}

function buildReport(ctx, endReason) {
  const endedAt = ctx.now();
  const startedAt = ctx.streamStartedAt || endedAt;
  const durationSeconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  flushAgent(ctx);
  const latency = { ...ctx.meter.stats(), toolFillerMissed: ctx.toolFillerMissed };
  const cost = estimateCost(ctx.usage, { durationSeconds, env: ctx.env });
  return {
    endReason, startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString(), provider: ctx.provider, model: ctx.model,
    fallbackUsed: ctx.fallbackUsed, transcript: ctx.transcript, actions: ctx.actions.filter((x) => x.type === 'search_knowledge' || x.latencyMs > SLOW_TOOL_MS),
    summary: ctx.summary || fallbackSummary(ctx), usage: { ...ctx.usage }, cost, latency,
    announcement: typeof ctx.announcement.verified === 'boolean' ? { verified: ctx.announcement.verified } : undefined,
  };
}

async function postReport(ctx, report) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await ctx.fetchImpl(`${ctx.s.orchestratorUrl}/internal/ai-inbound/calls/${encodeURIComponent(ctx.s.callSid)}/report`, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${callToken(ctx.s)}` }, body: JSON.stringify(report),
    });
    if (!res.ok) console.error('[AiInbound] compte rendu refusé', res.status, ctx.s.callSid);
  } catch (err) {
    console.error('[AiInbound] compte rendu non envoyé', ctx.s.callSid, err?.message || err);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Clôture idempotente : compte rendu à l'orchestrateur PUIS fermeture du flux (Twilio appelle alors l'action <Connect> de
 * l'orchestrateur, qui lit le statut : au revoir, ou excuse puis répondeur).
 */
async function finishSession(ctx, endReason) {
  if (ctx.finished) return ctx.lastReport;
  ctx.finished = true;
  ctx.timers.forEach((t) => ctx.timersApi.clearTimeout(t));
  const failed = ['engine_error', 'announcement_failed'].includes(endReason);
  const report = buildReport(ctx, failed ? 'engine_error' : endReason);
  if (endReason === 'announcement_failed') report.announcement = { verified: false };
  ctx.lastReport = report;
  console.log('[AiInbound][usage]', JSON.stringify({ callSid: ctx.s.callSid, endReason, provider: ctx.provider, model: ctx.model, seconds: Math.round((Date.parse(report.endedAt) - Date.parse(report.startedAt)) / 1000), usage: ctx.usage, cost: report.cost, latency: { medianMs: report.latency.medianMs, p95Ms: report.latency.p95Ms, turns: report.latency.turns.length } }));
  await postReport(ctx, report);
  // Apprentissage : analyse APRÈS le compte rendu (la fin d'appel n'attend jamais le modèle texte), une seule fois par appel.
  if (!ctx.learningDone) {
    ctx.learningDone = true;
    const learningRun = analyzeCall(ctx, report, { env: ctx.env, generate: ctx.learningGenerate })
      .then((out) => (out ? postLearning(ctx, { proposals: out.proposals, unanswered: out.unanswered, callerNames: out.callerNames }, { fetchImpl: ctx.fetchImpl, callToken }) : null))
      .then(() => undefined, () => undefined);
    ctx.learningRun = learningRun;
  }
  ctx.closingEngine = true;
  try { ctx.realtime.close(); } catch { /* ignore */ }
  const ws = ctx.mediaStreamWs;
  if (ws && ws.readyState === 1) { try { ws.close(1000, endReason); } catch { /* ignore */ } }
  unregisterStreamSession(ctx.streamToken);
  sessions.delete(ctx.sessionId);
  return report;
}

const activeInboundSessions = () => sessions.size;

module.exports = {
  createInboundSession, finishSession, buildInboundInstructions, openingPrompt, engineOrder, engineConfig, inboundAllowed, onAgentTurnEnd,
  SessionError, VOICES, activeInboundSessions, sessions,
};

const { searchKnowledge } = require('./aiVoiceTools');

/**
 * Outils de l'agent IA pour les appels ENTRANTS (pilote). Seule la recherche de connaissances s'exécute ici (base de l'entreprise,
 * `companyId` de la session, jamais un argument du modèle) ; les autres outils sont exécutés par l'orchestrateur avec le jeton d'appel
 * signé, qui porte l'entreprise et l'appel : le modèle ne peut désigner ni une autre entreprise ni un autre appel.
 * Délais courts et réponse de repli : un appel vivant ne peut pas attendre (contrat-pilote.md, 7.2).
 */
const TOOL_TIMEOUT_MS = 3000;
const KNOWLEDGE_TIMEOUT_MS = 2500;
const SLOW_TOOL_MS = 700;
const FALLBACK_HINT = "Outil indisponible : dis simplement que tu ne peux pas vérifier tout de suite et propose de faire rappeler l'appelant (create_request).";

const fn = (name, description, properties = {}, required = []) => ({ type: 'function', name, description, parameters: { type: 'object', properties, required } });

/** Déclarations selon les actions autorisées par l'entreprise (le serveur revérifie chaque action). */
function buildInboundTools(session) {
  const a = session.actions || {};
  const tools = [];
  if (session.knowledgeBase?.enabled !== false) {
    tools.push(fn('search_knowledge', "Recherche dans la base de connaissances de l'entreprise (offres, tarifs, horaires, conditions). À appeler AVANT toute réponse factuelle. Si rien n'est trouvé : ne réponds pas de mémoire, propose un rappel.", { query: { type: 'string', description: "La question de l'appelant, en quelques mots" } }, ['query']));
  }
  tools.push(fn('lookup_caller', "Identifie l'appelant par son numéro (fiche contact de l'entreprise). Renvoie seulement s'il est connu et son nom."));
  tools.push(fn('create_request', a.request
    ? "Crée une demande « à traiter » (message, demande de rappel) pour l'équipe. Confirme d'abord oralement le motif et le numéro de rappel."
    : "UNIQUEMENT pour une demande de rappel par une personne (l'appelant veut parler à un humain). Mets humanCallback à true.", {
    callerName: { type: 'string' },
    callbackNumber: { type: 'string', description: "Numéro de rappel s'il est différent du numéro appelant" },
    reason: { type: 'string', description: 'Motif, en une ou deux phrases' },
    urgency: { type: 'string', enum: ['normal', 'urgent'] },
    humanCallback: { type: 'boolean', description: "true si l'appelant demande à être rappelé par une personne" },
  }, ['reason']));
  if (a.appointment) {
    tools.push(fn('find_slots', 'Cherche les prochains créneaux libres de rendez-vous. Propose ensuite au plus deux créneaux, oralement.', {
      fromDate: { type: 'string', description: 'ISO 8601, facultatif' }, toDate: { type: 'string', description: 'ISO 8601, facultatif' },
    }));
    tools.push(fn('book_appointment', "Réserve un créneau renvoyé par find_slots, APRÈS confirmation explicite de l'appelant (jour, heure, nom).", {
      start: { type: 'string', description: 'Début ISO 8601, exactement celui de find_slots' }, callerName: { type: 'string' }, reason: { type: 'string' },
    }, ['start', 'callerName']));
  }
  const targets = Array.isArray(session.transferTargets) ? session.transferTargets : [];
  if (a.transfer && targets.length) {
    tools.push(fn('transfer_to_human', `Transfère l'appel à chaud vers une personne. Annonce d'abord le transfert à l'appelant. Personnes possibles : ${targets.map((t) => `${t.name} (${t.id})`).join(', ')}.`, {
      entryId: { type: 'string', enum: targets.map((t) => t.id) }, reason: { type: 'string' },
    }, ['entryId', 'reason']));
  }
  tools.push(fn('end_call', "Termine l'appel APRÈS avoir dit au revoir. summary : résumé de l'appel en une ou deux phrases (motif, ce qui a été fait).", { summary: { type: 'string' } }, ['summary']));
  return tools;
}

const ORCH_TOOLS = new Set(['lookup_caller', 'create_request', 'find_slots', 'book_appointment', 'transfer_to_human', 'end_call']);

async function withTimeout(promiseFactory, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await promiseFactory(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Appel d'un outil de l'orchestrateur avec le jeton d'appel. Ne lève jamais : renvoie un résultat de repli. */
async function callOrchestratorTool(name, args, session, { fetchImpl = global.fetch, timeoutMs = TOOL_TIMEOUT_MS } = {}) {
  const body = { ...(args || {}) };
  delete body.companyId;
  try {
    const res = await withTimeout((signal) => fetchImpl(`${session.orchestratorUrl}/internal/ai-inbound/tools/${encodeURIComponent(name)}`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.callToken}` },
      body: JSON.stringify(body),
    }), timeoutMs);
    let payload = null;
    try { payload = await res.json(); } catch { payload = null; }
    if (!res.ok) return { ok: false, error: payload?.code || `http_${res.status}`, fallback: FALLBACK_HINT };
    return { ok: true, ...(payload?.data || {}) };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : 'unavailable', fallback: FALLBACK_HINT };
  }
}

/** Exécute un outil pour la session. `companyId` vient toujours de la session (orch l'a signée), jamais du modèle. */
async function executeInboundTool(name, args, session, opts = {}) {
  if (name === 'search_knowledge') {
    if (session.knowledgeBase?.enabled === false) return { ok: false, error: 'knowledge base disabled' };
    const out = await searchKnowledge(args && args.query, {
      companyId: session.companyId, gigId: session.knowledgeBase?.gigId || undefined, timeoutMs: opts.knowledgeTimeoutMs || KNOWLEDGE_TIMEOUT_MS,
    });
    return out.ok ? out : { ...out, fallback: FALLBACK_HINT };
  }
  if (ORCH_TOOLS.has(name)) return callOrchestratorTool(name, args, session, opts);
  return { ok: false, error: `unknown tool ${name}` };
}

module.exports = { buildInboundTools, executeInboundTool, callOrchestratorTool, TOOL_TIMEOUT_MS, KNOWLEDGE_TIMEOUT_MS, SLOW_TOOL_MS, FALLBACK_HINT };

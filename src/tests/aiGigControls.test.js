/**
 * Contrôles repris de la PR #38 (sans ses défauts stricts) :
 *  - appel IA sortant : le gig du prospect doit appartenir au centre de l'appelant, refus AVANT toute création d'appel ;
 *  - PUT /gigs/:id/voice-assistant : un gig absent renvoie 404 et rien n'est créé.
 */
const A = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const B = 'bbbbbbbbbbbbbbbbbbbbbbb2';
const LEAD = '6d0000000000000000000d01';
const GIG = '6a0000000000000000000a01';
const GIG_MISSING = '6a0000000000000000000f99';

const mockLeads = {};
const mockGigs = {};
const mockCallCreate = jest.fn();
const mockWrites = [];
const mockLine = jest.fn(async () => ({ phoneNumber: '+33100000000', provider: 'telnyx' }));

jest.mock('../models/Lead', () => ({ Lead: { findById: () => ({ lean: async () => null }) } }));
jest.mock('../models/Gig', () => ({ findById: (id) => ({ lean: async () => mockGigs[String(id)] || null }) }));
jest.mock('../models/Call', () => ({
  Call: { create: (...a) => mockCallCreate(...a), findByIdAndUpdate: jest.fn(async () => null) },
}));
jest.mock('../utils/resolveGigPhoneLine', () => ({ resolveActiveLineForGig: (...a) => mockLine(...a) }));
jest.mock('../services/integrations/openaiRealtimeService', () => ({ OpenAIRealtimeService: class {} }));
jest.mock('../services/integrations/geminiLiveService', () => ({ GeminiLiveService: class {}, resolveLiveBackend: () => 'vertex', defaultModelForBackend: () => 'model' }));
jest.mock('../services/integrations/telnyxService', () => ({}));
jest.mock('../services/aiVoiceTools', () => ({ buildRealtimeTools: () => [], executeVoiceTool: async () => null }));

const mongoose = require('mongoose');

Object.defineProperty(mongoose.connection, 'db', {
  configurable: true,
  get: () => ({
    collection: (name) => ({
      findOne: async (q) => {
        if (name === 'leads') return mockLeads[String(q._id)] || null;
        if (name === 'gigs') {
          const ids = (q.$or || [{ _id: q._id }]).map((c) => String(c._id));
          return ids.map((id) => mockGigs[id]).find(Boolean) || null;
        }
        if (name === 'gig_voice_assistants') return { gigId: GIG, enabled: true };
        return null;
      },
      updateOne: async (...args) => { mockWrites.push({ name, op: 'updateOne', args }); return { matchedCount: 1 }; },
      insertOne: async (...args) => { mockWrites.push({ name, op: 'insertOne', args }); return {}; },
    }),
  }),
});

const mockFetch = jest.fn(async () => ({ status: 200, json: async () => ({}) }));
global.fetch = mockFetch;

const service = require('../services/aiOutboundCallService');
const { updateGigVoiceAssistant } = require('../controllers/gigs');

const req = { get: () => 'calls.example', protocol: 'https', headers: {} };
const stopAfterCreate = () => mockCallCreate.mockImplementation(async (doc) => {
  throw Object.assign(new Error('stop after create'), { status: 599, doc });
});

beforeEach(() => {
  [mockLeads, mockGigs].forEach((m) => Object.keys(m).forEach((k) => delete m[k]));
  mockWrites.length = 0;
  mockCallCreate.mockReset();
  mockFetch.mockClear();
  mockLine.mockClear();
  mockLeads[LEAD] = { _id: new mongoose.Types.ObjectId(LEAD), companyId: new mongoose.Types.ObjectId(A), gigId: GIG, Phone: '+33600000000' };
  mockGigs[GIG] = { _id: new mongoose.Types.ObjectId(GIG), companyId: new mongoose.Types.ObjectId(A), voiceAssistant: { enabled: true } };
});

describe('startAiOutboundCall : gig du prospect et centre de l\'appelant', () => {
  const start = (companyId) => service.startAiOutboundCall({ leadId: LEAD, companyId, req });

  test('gig d\'un autre centre : 403, aucun appel créé ni numéroté', async () => {
    mockGigs[GIG].companyId = new mongoose.Types.ObjectId(B);
    await expect(start(A)).rejects.toMatchObject({ status: 403, message: 'Not allowed for this gig' });
    expect(mockCallCreate).not.toHaveBeenCalled();
    expect(mockLine).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('sans centre transmis (compat sans jeton) : le centre du prospect sert de référence', async () => {
    mockGigs[GIG].companyId = B;
    await expect(start(undefined)).rejects.toMatchObject({ status: 403 });
    expect(mockCallCreate).not.toHaveBeenCalled();
  });

  test('gig du même centre : le contrôle passe (appel créé pour ce centre)', async () => {
    stopAfterCreate();
    await expect(start(A)).rejects.toMatchObject({ status: 599, doc: expect.objectContaining({ companyId: A }) });
    expect(mockCallCreate).toHaveBeenCalledTimes(1);
  });

  test('gig sans centre renseigné : comportement inchangé (défaut progressif, pas de refus)', async () => {
    delete mockGigs[GIG].companyId;
    stopAfterCreate();
    await expect(start(A)).rejects.toMatchObject({ status: 599 });
  });
});

describe('PUT /gigs/:id/voice-assistant', () => {
  const run = async (id, body = { enabled: true }) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await updateGigVoiceAssistant({ params: { id }, body }, res);
    return res;
  };

  test('gig absent : 404 et rien n\'est créé', async () => {
    const res = await run(GIG_MISSING);
    expect(res.statusCode).toBe(404);
    expect(mockWrites).toEqual([]);
  });

  test('gig existant : mis à jour sans upsert', async () => {
    const res = await run(GIG);
    expect(res.statusCode).toBe(200);
    const gigWrite = mockWrites.find((w) => w.name === 'gigs');
    expect(gigWrite).toBeDefined();
    expect(String(gigWrite.args[0]._id)).toBe(GIG);
    expect(gigWrite.args[2]).toBeUndefined();
    expect(gigWrite.args[1].$setOnInsert).toBeUndefined();
  });
});

/**
 * Agent vocal IA sortant : le prospect, son gig et l'appel raccroché doivent appartenir au centre de l'appelant,
 * et le refus intervient AVANT toute création d'appel ou numérotation.
 */
const A = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const B = 'bbbbbbbbbbbbbbbbbbbbbbb2';
const LEAD = '6d0000000000000000000d01';
const GIG = '6a0000000000000000000a01';

const mockLeads = {};
const mockGigs = {};
const mockCallsBySid = {};
const mockCallCreate = jest.fn();
const mockLine = jest.fn(async () => ({ phoneNumber: '+33100000000', provider: 'telnyx' }));

jest.mock('../models/Lead', () => ({ Lead: { findById: () => ({ lean: async () => null }) } }));
jest.mock('../models/Gig', () => ({ findById: (id) => ({ lean: async () => mockGigs[String(id)] || null }) }));
jest.mock('../models/Call', () => ({
  Call: {
    create: (...a) => mockCallCreate(...a),
    findById: () => ({ lean: async () => null }),
    findOne: ({ sid }) => { const doc = mockCallsBySid[sid] || null; return Object.assign(Promise.resolve(doc), { lean: async () => doc }); },
    findByIdAndUpdate: jest.fn(async () => null),
  },
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
    }),
  }),
});

const mockFetch = jest.fn(async () => ({ status: 200, json: async () => ({}) }));
global.fetch = mockFetch;
const service = require('../services/aiOutboundCallService');

const req = { get: () => 'calls.example', protocol: 'https' };

beforeEach(() => {
  [mockLeads, mockGigs, mockCallsBySid].forEach((m) => Object.keys(m).forEach((k) => delete m[k]));
  service.activeSessions.clear();
  mockCallCreate.mockReset();
  mockFetch.mockClear();
  mockLine.mockClear();
  mockLeads[LEAD] = { _id: new mongoose.Types.ObjectId(LEAD), companyId: new mongoose.Types.ObjectId(A), gigId: GIG, Phone: '+33600000000' };
  mockGigs[GIG] = { _id: GIG, companyId: A, voiceAssistant: { enabled: true } };
});

describe('startAiOutboundCall ownership', () => {
  const start = (companyId) => service.startAiOutboundCall({ leadId: LEAD, companyId, req });

  test('rejects a lead of another company before dialing', async () => {
    await expect(start(B)).rejects.toMatchObject({ status: 403 });
    expect(mockCallCreate).not.toHaveBeenCalled();
    expect(mockLine).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('rejects a lead without company (fails closed)', async () => {
    delete mockLeads[LEAD].companyId;
    await expect(start(A)).rejects.toMatchObject({ status: 403 });
    expect(mockCallCreate).not.toHaveBeenCalled();
  });

  test('rejects an own lead whose gig belongs to another company', async () => {
    mockGigs[GIG].companyId = B;
    await expect(start(A)).rejects.toMatchObject({ status: 403 });
    expect(mockCallCreate).not.toHaveBeenCalled();
  });

  test('rejects when the caller company is unknown', async () => {
    await expect(start(undefined)).rejects.toMatchObject({ status: 403 });
    expect(mockCallCreate).not.toHaveBeenCalled();
  });

  test('an own lead and gig pass the ownership check (call created for the caller company)', async () => {
    mockCallCreate.mockImplementation(async (doc) => { throw Object.assign(new Error('stop after create'), { status: 599, doc }); });
    await expect(start(A)).rejects.toMatchObject({ status: 599, doc: expect.objectContaining({ companyId: A }) });
  });
});

describe('hangupAiOutboundCall ownership', () => {
  test('rejects hanging up an active call of another company', async () => {
    service.activeSessions.set('v3:other', { companyId: B, callMongoId: 'x', telephonyProvider: 'telnyx' });
    await expect(service.hangupAiOutboundCall({ callControlId: 'v3:other', companyId: A })).rejects.toMatchObject({ status: 403 });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(service.activeSessions.has('v3:other')).toBe(true);
  });

  test('rejects hanging up a stored call of another company', async () => {
    mockCallsBySid['CAother'] = { _id: 'c1', sid: 'CAother', companyId: new mongoose.Types.ObjectId(B), provider: 'twilio' };
    await expect(service.hangupAiOutboundCall({ callControlId: 'CAother', companyId: A })).rejects.toMatchObject({ status: 403 });
  });

  test('returns 404 for an unknown call', async () => {
    await expect(service.hangupAiOutboundCall({ callControlId: 'v3:unknown', companyId: A })).rejects.toMatchObject({ status: 404 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('rejects a callId that does not match the active session', async () => {
    service.activeSessions.set('v3:mine', { companyId: A, callMongoId: 'mine', telephonyProvider: 'telnyx' });
    await expect(service.hangupAiOutboundCall({ callControlId: 'v3:mine', callId: 'someone-else', companyId: A })).rejects.toMatchObject({ status: 403 });
  });

  test('hangs up an own active call', async () => {
    process.env.TELNYX_API_KEY = 'k';
    service.activeSessions.set('v3:mine', { companyId: A, callMongoId: null, telephonyProvider: 'telnyx' });
    const out = await service.hangupAiOutboundCall({ callControlId: 'v3:mine', companyId: A });
    expect(out).toMatchObject({ success: true, callControlId: 'v3:mine' });
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/calls/v3:mine/actions/hangup'), expect.anything());
    delete process.env.TELNYX_API_KEY;
  });
});

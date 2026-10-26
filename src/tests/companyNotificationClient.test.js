process.env.JWT_SECRET = 'test-secret';
const mongoose = require('mongoose');
const { notifyCompanyOfFraud } = require('../services/companyNotificationClient');

const oid = () => new mongoose.Types.ObjectId();
const respond = (status) => {
  global.fetch = jest.fn(async () => ({ ok: status < 400, status }));
};
afterEach(() => {
  delete global.fetch;
  jest.restoreAllMocks();
});

describe('fraud notification to the company', () => {
  test('a call document with ObjectId ids (as Mongoose returns them) notifies the company', async () => {
    respond(201);
    const companyId = oid();
    const gigId = oid();
    const ok = await notifyCompanyOfFraud({ call: { companyId, gigId }, callId: String(oid()), fraudScore: 22 });
    expect(ok).toBe(true);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ companyId: companyId.toHexString(), gigId: gigId.toHexString(), kind: 'fraud' });
    expect(body.message).toMatch(/22\/100/);
  });

  test('falls back on the lead\'s gig company, populated or not', async () => {
    respond(201);
    const companyId = oid();
    await notifyCompanyOfFraud({ call: { lead: { gigId: { _id: oid(), companyId } } }, callId: 'c1' });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).companyId).toBe(companyId.toHexString());
  });

  test('a rejection by the orchestrator is logged, not swallowed', async () => {
    respond(401);
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await notifyCompanyOfFraud({ call: { companyId: oid() }, callId: 'c2' })).toBe(false);
    expect(error.mock.calls.flat().join(' ')).toMatch(/HTTP 401/);
  });

  test('a call without company is skipped with a warning', async () => {
    respond(201);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await notifyCompanyOfFraud({ call: {}, callId: 'c3' })).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).toMatch(/skipped/);
  });
});

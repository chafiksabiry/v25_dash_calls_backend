const mongoose = require('mongoose');

/**
 * Resolve an active phone line for a gig.
 * Picks randomly among active voice-capable numbers so Caller ID rotates
 * when a gig has several lines (Twilio and/or Telnyx).
 */
async function resolveActiveLineForGig(gigId, { preferProvider } = {}) {
  if (!gigId) return null;

  const gigIdStr = String(gigId);
  const orGig = [{ gigId: gigIdStr }];
  if (mongoose.Types.ObjectId.isValid(gigIdStr)) {
    orGig.push({ gigId: new mongoose.Types.ObjectId(gigIdStr) });
  }

  const docs = await mongoose.connection.db
    .collection('phonenumbers')
    .find({
      $or: orGig,
      status: 'active',
    })
    .toArray();

  if (!docs.length) return null;

  const voiceCapable = docs.filter((d) => d.features?.voice !== false);
  let pool = voiceCapable.length ? voiceCapable : docs;
  if (preferProvider) {
    const preferred = pool.filter((d) => {
      const p = d.provider === 'twilio' ? 'twilio' : 'telnyx';
      return p === preferProvider;
    });
    if (preferred.length) pool = preferred;
  }
  const chosen = pool[Math.floor(Math.random() * pool.length)];

  return {
    phoneNumberId: String(chosen._id),
    phoneNumber: chosen.phoneNumber,
    provider: chosen.provider === 'twilio' ? 'twilio' : 'telnyx',
    gigId: gigIdStr,
    companyId: chosen.companyId ? String(chosen.companyId) : null,
    status: chosen.status,
    features: chosen.features || {},
  };
}

/**
 * Resolve active line from a lead id (lead → gigId → phone number).
 */
async function resolveActiveLineForLead(leadId) {
  if (!leadId || !mongoose.Types.ObjectId.isValid(leadId)) {
    return { lead: null, line: null };
  }

  const lead = await mongoose.connection.db.collection('leads').findOne({
    _id: new mongoose.Types.ObjectId(leadId),
  });

  if (!lead?.gigId) {
    return { lead, line: null };
  }

  const line = await resolveActiveLineForGig(lead.gigId);
  return { lead, line };
}

module.exports = {
  resolveActiveLineForGig,
  resolveActiveLineForLead,
};

const mongoose = require('mongoose');

/**
 * Resolve an active phone line for a gig.
 * Prefers Telnyx when any voice-capable Telnyx line exists (avoids falling
 * onto a broken/legacy Twilio line when both providers are active).
 * Otherwise rotates randomly among remaining voice-capable lines.
 */
async function resolveActiveLineForGig(gigId) {
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
  const pool = voiceCapable.length ? voiceCapable : docs;

  const telnyxPool = pool.filter((d) => d.provider === 'telnyx');
  const pickFrom = telnyxPool.length ? telnyxPool : pool;
  const chosen = pickFrom[Math.floor(Math.random() * pickFrom.length)];

  console.log('[resolveActiveLineForGig]', {
    gigId: gigIdStr,
    active: docs.length,
    voiceCapable: voiceCapable.length,
    telnyx: telnyxPool.length,
    chosen: {
      id: String(chosen._id),
      phoneNumber: chosen.phoneNumber,
      provider: chosen.provider,
      voice: chosen.features?.voice,
    },
  });

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

const mongoose = require('mongoose');

/**
 * Resolve the active phone line for a gig (most recent voice-capable number).
 * Provider on this document drives Workspace dialer selection.
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
    .sort({ updatedAt: -1, createdAt: -1, _id: -1 })
    .limit(20)
    .toArray();

  if (!docs.length) return null;

  const withVoice = docs.find((d) => d.features?.voice !== false);
  const chosen = withVoice || docs[0];

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

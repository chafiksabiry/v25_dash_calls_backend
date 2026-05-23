const twilio = require('twilio');
const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
//console.log("AccessToken",AccessToken);
//console.log("VoiceGrant",VoiceGrant);
const axios = require('axios');
const cloudinary = require('cloudinary').v2;
const mongoose = require('mongoose');

const { Call } = require('../../models/Call');
const Transaction = require('../../models/Transaction');
const path = require("path");
const fetch = require('node-fetch');
const vertexAIService = require('../vertexai.service');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Function to get Twilio credentials for a user
const getTwilioCredentials = async (userId) => {
  console.log("we are in the service function getTwilioCredentials");
  try {
    const twilioConfig = {
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN
    };
    return twilioConfig;
  } catch (error) {
    console.error('Error getting Twilio credentials:', error);
    throw error;
  }
};

// Initialize Twilio client with user credentials
const getTwilioClient = async (userId) => {
  const credentials = await getTwilioCredentials(userId);
  return twilio(credentials.accountSid, credentials.authToken);
};

const getCallDetails = async (callSid, userId) => {
  const MAX_RETRIES = 5; // Increased from 3 to 5 to wait longer for Twilio processing
  const RETRY_DELAY = 2000; // 2 seconds

  console.log(`🔍 [TwilioService] Fetching details for SID: ${callSid} (User: ${userId})`);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const credentials = await getTwilioCredentials(userId);
      const client = twilio(credentials.accountSid, credentials.authToken);
      const callParent = await client.calls(callSid).fetch();

      const callFils = await getChildCalls(callSid, userId);

      // Try to find recordings on Parent SID first, then on Child SID if not found
      let recordings = await client.recordings.list({ callSid: callSid, limit: 1 });

      if (recordings.length === 0 && callFils.length > 0) {
        console.log(`🔍 [TwilioService] Checking for recordings on child SID: ${callFils[0].sid}`);
        recordings = await client.recordings.list({ callSid: callFils[0].sid, limit: 1 });
      }

      let recordingUrl = null;
      if (recordings.length > 0) {
        const recordingSid = recordings[0].sid;
        const format = "mp3";
        recordingUrl = `https://api.twilio.com/2010-04-01/Accounts/${credentials.accountSid}/Recordings/${recordingSid}.${format}`;
        console.log(`✅ [TwilioService] Found recording URL on attempt ${attempt}: ${recordingUrl}`);
      } else if (attempt < MAX_RETRIES) {
        console.log(`⏳ [TwilioService] No recording found for SID: ${callSid}. Retrying (Attempt ${attempt}/${MAX_RETRIES})...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        continue;
      }

      if (!recordingUrl) {
        console.warn(`⚠️ [TwilioService] No recording found after ${MAX_RETRIES} attempts for SID: ${callSid}`);
      }

      let parentPrice = callParent.price ? Math.abs(parseFloat(callParent.price)) : 0;
      let childPrice = 0;
      if (callFils.length > 0 && callFils[0].price) {
        childPrice = Math.abs(parseFloat(callFils[0].price));
      }
      const totalPrice = parentPrice + childPrice;

      return {
        ParentCallSid: callSid,
        ChildCallSid: callFils[0]?.sid || null,
        duration: callParent.duration,
        from: callFils[0]?.from || callParent.from,
        to: callFils[0]?.to || callParent.to,
        status: callFils[0]?.status || callParent.status,
        startTime: callParent.startTime,
        endTime: callParent.endTime,
        direction: callFils[0]?.direction || callParent.direction,
        recordingUrl: recordingUrl,
        price: totalPrice,
      };
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        console.error("❌ [TwilioService] Error fetching call details after multiple attempts:", error);
        throw new Error(`Error fetching call details: ${error.message}`);
      }
      console.warn(`⚠️ [TwilioService] Error on attempt ${attempt}/${MAX_RETRIES}: ${error.message}. Retrying...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }
  }
};

const getChildCalls = async (parentCallSid, userId) => {
  try {
    const credentials = await getTwilioCredentials(userId);
    console.log("credentials:", credentials);
    const client = twilio(credentials.accountSid, credentials.authToken);
    const childCalls = await client.calls.list({
      parentCallSid: parentCallSid,
      limit: 1,
    });

    return childCalls.map(call => ({
      sid: call.sid,
      from: call.from,
      to: call.to,
      status: call.status,
      startTime: call.startTime,
      endTime: call.endTime,
      duration: call.duration,
      direction: call.direction,
      price: call.price,
    }));
  } catch (error) {
    console.error("❌ Error getting child calls:", error);
    return []; // Return empty instead of throwing to be more resilient
  }
};

const saveCallToDB = async (callSid, agentId, leadId, callData, cloudinaryrecord, transcript, gigId, companyId, userId, transactionOccurred, isVoicemail, appointmentAt, callbackAt) => {
  try {
    // Normalize call data
    const call = callData || {};

    // Auto-upload to Cloudinary if needed
    let finalCloudinaryUrl = cloudinaryrecord;
    if (!finalCloudinaryUrl && call.recordingUrl && (agentId || userId)) {
      console.log(`☁️ [TwilioService] No Cloudinary record provided, attempting auto-upload for SID: ${callSid}`);
      try {
        finalCloudinaryUrl = await fetchTwilioRecording(call.recordingUrl, agentId || userId);
        if (finalCloudinaryUrl) {
          console.log(`✅ [TwilioService] Auto-uploaded to Cloudinary: ${finalCloudinaryUrl}`);
        }
      } catch (uploadError) {
        console.error('⚠️ [TwilioService] Auto-upload to Cloudinary failed:', uploadError.message);
      }
    }

    // Fetch price if possible
    let calculatedPrice = 0;
    if (call.price !== undefined && call.price !== null) {
      calculatedPrice = Math.abs(parseFloat(call.price)) || 0;
    } else if (callSid) {
      try {
        const credentials = await getTwilioCredentials(userId || agentId);
        if (credentials && credentials.accountSid && credentials.authToken) {
          const client = twilio(credentials.accountSid, credentials.authToken);
          const twilioCall = await client.calls(callSid).fetch();
          if (twilioCall && twilioCall.price) {
            calculatedPrice = Math.abs(parseFloat(twilioCall.price));
          }
        }
      } catch (err) {
        console.warn(`⚠️ [TwilioService] Could not dynamically retrieve call price: ${err.message}`);
      }
    }

    // Build update object
    const update = {
      status: call.status || 'completed',
      duration: parseInt(call.duration) || 0,
      recording_url: call.recordingUrl,
      recording_url_cloudinary: finalCloudinaryUrl,
      from: call.from,
      to: call.to,
      price: calculatedPrice,
      transcript: transcript || [], // Save the real-time transcript if provided
      updatedAt: new Date()
    };

    if (isVoicemail) {
      update.validByAI = false;
      update.valid = false;
      update.ai_call_status = 'auto_refused';
      update.callOutcome = 'voicemail';
      update.callOutcomeSource = 'rep';
      update.ai_refusal_reason = 'Appel sur messagerie vocale (déclaré par le rep)';
    } else {
      if (transactionOccurred !== undefined && transactionOccurred !== null) {
        update.transactionOccurred = transactionOccurred;
      }
      if (appointmentAt) {
        update.appointmentAt = appointmentAt;
        update.callOutcome = 'appointment';
        update.callOutcomeSource = 'rep';
        update.validByAI = true;
        update.valid = true;
      } else if (callbackAt) {
        update.callbackAt = callbackAt;
        update.callOutcome = 'callback_requested';
        update.callOutcomeSource = 'rep';
        update.validByAI = true;
        update.valid = true;
      }
    }

    if (call.ChildCallSid) {
      update.childCalls = [call.ChildCallSid];
    }

    // startTime and endTime are handled in $setOnInsert to avoid ConflictingUpdateOperators errors
    // during initial storage if they are also in $set.

    // Use findOneAndUpdate with upsert to avoid race conditions
    const result = await Call.findOneAndUpdate(
      { sid: callSid },
      {
        $set: update,
        $setOnInsert: {
          agent: agentId || undefined,
          lead: leadId || undefined,
          gigId: gigId || undefined,
          companyId: companyId || undefined,
          userId: userId || undefined,
          sid: callSid,
          parentCallSid: call.ParentCallSid || callSid,
          direction: call.direction || 'outbound',
          provider: 'twilio',
          createdAt: call.startTime || new Date(),
          startTime: call.startTime || new Date()
        }
      },
      { new: true, upsert: true, runValidators: true }
    ).populate('agent').populate('lead');

    console.log(`✅ [TwilioService] Call ${callSid} processed (Upsert).`);

    // Auto-deduct the call duration from the company's minute balance.
    // No AI validation is required: as soon as the call is saved with a duration,
    // MinutesCompany.minutes decreases. Idempotent on the orchestrator side
    // thanks to the chargedCallSids tracking. Fire-and-forget on purpose so
    // any failure here cannot break the saveCallToDB response.
    try {
      const targetCompanyId = result.companyId || companyId;
      const durationSeconds = parseInt(call.duration) || 0;
      if (targetCompanyId && durationSeconds > 0) {
        const orchestratorUrl = (process.env.ORCHESTRATOR_API_URL
          || 'https://v25comporchestratorback-production.up.railway.app').replace(/\/$/, '');
        fetch(`${orchestratorUrl}/api/minutes-company/charge-call`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            companyId: String(targetCompanyId),
            callSid,
            duration: durationSeconds
          })
        })
          .then(async (resp) => {
            if (!resp.ok) {
              const text = await resp.text().catch(() => '');
              console.warn(`⚠️ [TwilioService] charge-call returned ${resp.status}: ${text}`);
            } else {
              console.log(`💸 [TwilioService] Minute balance debited for call ${callSid} (${durationSeconds}s).`);
            }
          })
          .catch((err) => {
            console.warn('⚠️ [TwilioService] Failed to notify orchestrator for minute debit:', err.message);
          });
      }
    } catch (notifyErr) {
      console.warn('⚠️ [TwilioService] charge-call notify wrapper error:', notifyErr.message);
    }

    if (transactionOccurred !== undefined && transactionOccurred !== null) {
      try {
        await Transaction.findOneAndUpdate(
          { call: result._id },
          {
            call: result._id,
            agent: result.agent?._id || result.agent || agentId,
            lead: result.lead?._id || result.lead || leadId,
            gigId: result.gigId || gigId || undefined,
            companyId: result.companyId || companyId || undefined,
            validByReps: transactionOccurred,
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        console.log(`✅ [TwilioService] Separate Transaction created/updated for call ${result._id}.`);
      } catch (err) {
        console.error(`❌ [TwilioService] Failed to create/update transaction record:`, err);
      }
    }

    // ☎️  Short-circuit: calls that never reached a human (no-answer, busy,
    // canceled, failed, or completed with zero duration) are auto-refused
    // (`validByAI = false`). They carry no transcript / recording, so feeding
    // them to the LLM would only waste credits and leave them stuck in
    // "Analyse en cours" forever.
    const callStatus = (result.status || '').toString().toLowerCase();
    const noConnectStatuses = new Set(['no-answer', 'noanswer', 'busy', 'canceled', 'cancelled', 'failed']);
    const isUnanswered =
      noConnectStatuses.has(callStatus) ||
      // A "completed" call with no duration and no audio is also a non-connect.
      (callStatus === 'completed' && (result.duration || 0) === 0 && !result.recording_url_cloudinary);

    if (isUnanswered && result.validByAI == null) {
      try {
        const refusalReason = `Appel non décroché (status: ${result.status || 'unknown'})`;
        const refused = await Call.findOneAndUpdate(
          { _id: result._id },
          {
            $set: {
              validByAI: false,
              ai_refusal_reason: refusalReason
            }
          },
          { new: true }
        );
        result.validByAI = false;
        result.ai_refusal_reason = refusalReason;
        console.log(`🚫 [TwilioService] Call ${callSid} auto-refused (${callStatus}) — skipping AI analysis.`);
        // Best-effort: poke the orchestrator so its rep/company reconciliation
        // counters re-sync without waiting for the next manual refresh.
        try {
          const orchestratorUrl = (process.env.ORCHESTRATOR_API_URL
            || 'https://v25comporchestratorback-production.up.railway.app').replace(/\/$/, '');
          const reconcileTarget = refused?.companyId || companyId;
          if (reconcileTarget) {
            fetch(`${orchestratorUrl}/api/escrow/reconcile/${reconcileTarget}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }
            }).catch(() => {});
          }
        } catch (_) { /* non-blocking */ }
      } catch (refuseErr) {
        console.warn(`⚠️ [TwilioService] Could not mark call ${callSid} as auto-refused:`, refuseErr.message);
      }
    }

    // 🤖 Automated AI Analysis — runs `analyzeCall` asynchronously so it
    // populates `validByAI`, scores, transcript & triggers reconciliation
    // (RepTransaction + WalletCompany debit) the moment a call finishes.
    // We only skip if the call has already been scored (including the
    // auto-refusal above).
    const alreadyScored = result.validByAI === true || result.validByAI === false
      || (result.ai_call_score && result.ai_call_score.overall && result.ai_call_score.overall.score);
    if (!alreadyScored && (result.recording_url_cloudinary || (Array.isArray(result.transcript) && result.transcript.length > 0))) {
      console.log(`🤖 [TwilioService] Auto-triggering AI analysis for call: ${result._id}`);
      setTimeout(async () => {
        try {
          const selfBase = process.env.SELF_API_URL || process.env.BASE_URL || 'http://localhost:3001';
          const url = `${selfBase.replace(/\/+$/, '')}/api/calls/${result._id}/analyze`;
          const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          const payload = await r.json().catch(() => ({}));
          if (r.ok && payload.success) {
            console.log(`✅ [TwilioService] Auto AI analysis OK for call ${result._id} — validByAI=${payload.validByAI}`);
          } else {
            console.warn(`⚠️  [TwilioService] Auto AI analysis returned ${r.status} for call ${result._id}:`, payload.message);
          }
        } catch (err) {
          console.error(`❌ [TwilioService] Auto AI analysis failed for call ${result._id}:`, err.message);
        }
      }, 3000);
    }

    return result;
  } catch (error) {
    console.error("❌ [TwilioService] Error saving call to MongoDB:", error.message);
    if (error.code === 11000) {
      console.error("   Duplicate Key Error: Call with this SID already exists.");
    }
    throw error;
  }
};

const makeCall = async (to, userId) => {
  if (!to || !to.startsWith('+')) {
    return Promise.reject('Invalid phone number. Use international format, e.g. +1234567890');
  }

  try {
    const client = await getTwilioClient(userId);
    const credentials = await getTwilioCredentials(userId);

    const call = await client.calls.create({
      url: `${process.env.BASE_URL}/api/calls/twilio-voice`,
      to: to,
      from: credentials.phoneNumber,
      record: true
    });

    console.log(`Call initiated with SID: ${call.sid}`);
    return call.sid;
  } catch (error) {
    console.error('Error making call:', error);
    throw error;
  }
};

const generateTwimlResponse = async (to, callerIdOverride) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callerId = callerIdOverride || process.env.TWILIO_PHONE_NUMBER;

  console.log("Generating TwiML for:", to, "CallerID:", callerId);

  if (!callerId) {
    console.error("❌ Missing TWILIO_PHONE_NUMBER in environment variables");
    twiml.say("System configuration error: Missing Caller ID.");
    return twiml.toString();
  }

  if (to) {
    const selfBase = (process.env.SELF_API_URL || process.env.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
    const amdCallbackUrl = `${selfBase}/api/calls/amd-callback`;

    // Enable Twilio AMD (Answering Machine Detection).
    // When Twilio detects a machine, it POSTs to amd-callback with
    // AnsweredBy=machine_start so the backend can auto-mark the call
    // as voicemail without any action from the rep.
    const dial = twiml.dial({
      callerId: callerId,
      record: 'record-from-answer',
    });
    dial.number({
      machineDetection: 'DetectMessageEnd',
      asyncAmdStatusCallback: amdCallbackUrl,
      asyncAmdStatusCallbackMethod: 'POST',
    }, to);
  } else {
    twiml.say("Invalid number");
  }

  return twiml.toString();
};

const trackCallStatus = async (callSid, userId) => {
  try {
    const client = await getTwilioClient(userId);
    const call = await client.calls(callSid).fetch();

    if (call && call.status) {
      console.log(`Call status for SID ${callSid}: ${call.status}`);
      return call.status;
    } else {
      throw new Error('Call details not found');
    }
  } catch (error) {
    console.error('Error tracking call status:', error);
    throw error;
  }
};

const hangUpCall = async (callSid, userId) => {
  try {
    const client = await getTwilioClient(userId);
    const call = await client.calls(callSid).update({ status: 'completed' });
    console.log(`Call with SID ${callSid} ended.`);
    return call;
  } catch (error) {
    console.error('Error ending call:', error);
    throw error;
  }
};

const generateTwilioToken1 = async (identity, userId) => {
  console.log("we are in the service function generateTwilioToken");
  try {
    const credentials = await getTwilioCredentials(userId);
    console.log("credentials:", credentials);
    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: credentials.applicationSid,
    });

    const token = new AccessToken(
      credentials.accountSid,
      credentials.apiKey,
      credentials.apiSecret,
      { identity }
    );

    token.addGrant(voiceGrant);
    return token.toJwt();
  } catch (error) {
    console.error('Error generating token:', error);
    throw error;
  }
};

const generateTwilioToken = async (identity) => {
  return new Promise((resolve, reject) => {
    try {
      const voiceGrant = new VoiceGrant({
        outgoingApplicationSid: process.env.TWILIO_APP_SID, // ✅ TwiML App SID
        // incomingAllow: true, // Autorise les appels entrants (optionnel)
      });

      const token = new AccessToken(
        process.env.TWILIO_ACCOUNT_SID, // ✅ Account SID Twilio
        process.env.TWILIO_API_KEY,     // ✅ API Key SID
        process.env.TWILIO_API_SECRET,  // ✅ API Key Secret
        { identity }
      );

      token.addGrant(voiceGrant);
      resolve(token.toJwt());
    } catch (error) {
      reject(error);
    }
  });
};


const fetchTwilioRecording = async (recordingUrl, userId) => {
  try {
    const credentials = await getTwilioCredentials(userId);
    const auth = `Basic ${Buffer.from(`${credentials.accountSid}:${credentials.authToken}`).toString('base64')}`;

    const response = await axios.get(recordingUrl, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Accept': '*/*',
        'Authorization': auth,
      },
      responseType: 'arraybuffer',
    });

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { resource_type: 'video', folder: 'V25_Call_Records' },
        (error, result) => {
          if (error) {
            console.error('Error uploading to Cloudinary:', error);
            return reject(error);
          }
          console.log('Uploaded to Cloudinary:', result.secure_url);
          resolve(result.secure_url);
        }
      );

      uploadStream.end(response.data);
    });
  } catch (error) {
    console.error('Error fetching recording:', error);
    return null;
  }
};

const startRecording = async (callSid, userId) => {
  try {
    const client = await getTwilioClient(userId);
    const recording = await client.calls(callSid).recordings.create();
    console.log(`✅ Recording started for call ${callSid}: ${recording.sid}`);
    return recording;
  } catch (error) {
    console.error(`❌ Error starting recording for ${callSid}:`, error.message);
    throw error;
  }
};

const stopRecording = async (callSid, userId) => {
  try {
    const client = await getTwilioClient(userId);
    // List all recordings for this call (any status)
    const recordings = await client.calls(callSid).recordings.list();

    if (recordings.length === 0) {
      console.log(`⚠️ No recordings found to discard for call ${callSid}`);
      return { discarded: false, count: 0 };
    }

    console.log(`🗑️ Attempting to delete ${recordings.length} recordings for call ${callSid}`);

    const stopResults = await Promise.all(recordings.map(async (rec) => {
      try {
        await client.recordings(rec.sid).remove();
        console.log(`✅ DISCARDED recording ${rec.sid}`);
        return true;
      } catch (err) {
        console.error(`❌ Failed to discard recording ${rec.sid}:`, err.message);
        return false;
      }
    }));

    return { discarded: true, count: stopResults.filter(r => r).length };
  } catch (error) {
    console.error(`❌ Error stopping recording for ${callSid}:`, error.message);
    throw error;
  }
};

module.exports = {
  makeCall,
  trackCallStatus,
  hangUpCall,
  generateTwilioToken,
  generateTwimlResponse,
  getCallDetails,
  saveCallToDB,
  fetchTwilioRecording,
  startRecording,
  stopRecording
};



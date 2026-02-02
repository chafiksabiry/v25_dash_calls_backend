const twilio = require('twilio');
const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
//console.log("AccessToken",AccessToken);
//console.log("VoiceGrant",VoiceGrant);
const axios = require('axios');
const cloudinary = require('cloudinary').v2;
const mongoose = require('mongoose');

// const Call = mongoose.model('Call') -- Moved inside functions
const path = require("path");
const fetch = require('node-fetch');

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
  return credentials;
};

const getCallDetails = async (callSid, userId) => {
  try {
    const credentials = await getTwilioCredentials(userId);
    console.log("credentials:", credentials);
    const client = twilio(credentials.accountSid, credentials.authToken);
    const callParent = await client.calls(callSid).fetch();
    console.log("Call parent Details:", callParent);

    const callFils = await getChildCalls(callSid, userId);
    console.log("call Fils details", callFils);

    const recordings = await client.recordings.list({ callSid: callSid, limit: 1 });

    let recordingUrl = null;
    if (recordings.length > 0) {
      const recordingSid = recordings[0].sid;
      const format = "mp3";
      recordingUrl = `https://api.twilio.com/2010-04-01/Accounts/${credentials.accountSid}/Recordings/${recordingSid}.${format}`;
    }

    return {
      ParentCallSid: callSid,
      ChildCallSid: callFils[0].sid,
      duration: callParent.duration,
      from: callFils[0].from,
      to: callFils[0].to,
      status: callFils[0].status,
      startTime: callParent.startTime,
      endTime: callParent.endTime,
      direction: callFils[0].direction,
      recordingUrl: recordingUrl,
    };
  } catch (error) {
    console.error("❌ Error fetching call details:", error);
    throw new Error("Error fetching call details");
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
    }));
  } catch (error) {
    console.error("❌ Error getting child calls:", error);
    throw new Error("Error getting child calls");
  }
};

const saveCallToDB = async (callSid, agentId, leadId, call, cloudinaryrecord) => {
  try {
    const Call = mongoose.model('Call');
    let existingCall = await Call.findOne({ sid: callSid });

    if (existingCall) {
      existingCall.status = call.status;
      existingCall.duration = parseInt(call.duration) || 0;
      existingCall.recording_url = call.recordingUrl;
      existingCall.recording_url_cloudinary = cloudinaryrecord;
      existingCall.childCalls[0] = call.ChildCallSid;
      existingCall.updatedAt = new Date();

      await existingCall.save();
      console.log(`📞 Call ${callSid} updated.`);
      return existingCall;
    } else {
      const newCall = new Call({
        agent: agentId,
        lead: leadId,
        sid: call.ParentCallSid,
        parentCallSid: call.ParentCallSid || null,
        direction: call.direction,
        status: call.status,
        duration: parseInt(call.duration) || 0,
        recording_url: call.recordingUrl,
        recording_url_cloudinary: cloudinaryrecord,
        startTime: call.startTime,
        endTime: call.endTime,
        childCalls: call.ChildCallSid,
        createdAt: call.startTime,
        updatedAt: new Date(),
      });

      await newCall.save();
      console.log(`📞 Call ${callSid} saved successfully.`);
      return newCall;
    }
  } catch (error) {
    console.error("❌ Error saving call:", error);
    throw new Error("Error saving call");
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

const generateTwimlResponse = async (to) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callerId = process.env.TWILIO_PHONE_NUMBER;

  console.log("Generating TwiML for:", to, "CallerID:", callerId);

  if (!callerId) {
    console.error("❌ Missing TWILIO_PHONE_NUMBER in environment variables");
    twiml.say("System configuration error: Missing Caller ID.");
    return twiml.toString();
  }

  if (to) {
    // Validating 'to' format could be done here as well
    const dial = twiml.dial({ callerId: callerId, record: 'record-from-answer' });
    dial.number(to);
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

module.exports = {
  makeCall,
  trackCallStatus,
  hangUpCall,
  generateTwilioToken,
  generateTwimlResponse,
  getCallDetails,
  saveCallToDB,
  fetchTwilioRecording
};



const twilio = require('twilio');
const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
//console.log("AccessToken",AccessToken);
//console.log("VoiceGrant",VoiceGrant);
const accountSid = 'AC8a453959a6cb01cbbd1c819b00c5782f';
const authToken = '7ade91a170bff98bc625543287ee62c8';
const axios = require('axios');
const cloudinary = require('cloudinary').v2;
const mongoose = require('mongoose');
const Call = mongoose.model('Call')
const client = twilio(accountSid, authToken);
const path = require("path"); 
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});
const getCallDetails = async (callSid) => {
  try {
    // Fetch the call details
    const callParent = await client.calls(callSid).fetch();
    console.log("Call parent Details:", callParent);

const callFils= await getChildCalls(callSid);
console.log("call Fils details",callFils);


    // Fetch recording details if available
    const recordings = await client.recordings.list({ callSid: callSid, limit: 1 });

    let recordingUrl = null;
    let recordingFilePath = null;

    if (recordings.length > 0) {
      const recordingSid = recordings[0].sid;
      const format = "mp3"; // Change to "wav" if you need WAV format
      recordingUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.${format}`;

      // File path to save the recording
      recordingFilePath = path.join(__dirname, `recording-${recordingSid}.${format}`);

      // Download the recording
     /*  const response = await axios.get(recordingUrl, {
        auth: {
          username: process.env.TWILIO_ACCOUNT_SID,
          password: process.env.TWILIO_AUTH_TOKEN,
        },
        responseType: "stream",
      }); */
      

      // Save to local file
     /*  const writer = fs.createWriteStream(recordingFilePath);
      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      }); */

      console.log(`✅ Recording : ${recordingFilePath}`);
    }

    return {
      ParentCallSid:callSid,
      ChildCallSid: callFils[0].sid,
      duration: callParent.duration,
      from: callFils[0].from,
      to: callFils[0].to,
      status: callFils[0].status,
      startTime: callParent.startTime,
      endTime: callParent.endTime,
      direction: callFils[0].direction,
      recordingUrl: recordingUrl, // Twilio API recording URL
      //recordingFilePath: recordingFilePath, // Local file path of downloaded recording
    };
  } catch (error) {
    console.error("❌ Error fetching call details:", error);
    throw new Error("Error fetching call details");
  }
};

const getChildCalls = async (parentCallSid) => {
  try {
    const childCalls = await client.calls.list({
      parentCallSid: parentCallSid, // Filtrer par parentCallSid
      limit: 1, // Modifier selon tes besoins
    });
console.log("childCalls",childCalls);
    return childCalls.map(call => ({
      sid: call.sid,
      from: call.from,
      to: call.to,
      status: call.status,
      startTime: call.startTime,
      endTime: call.endTime,
      duration: call.duration,
      direction:call.direction,
    }));
  } catch (error) {
    console.error("❌ Erreur lors de la récupération des child calls:", error);
    throw new Error("Erreur lors de la récupération des child calls");
  }
};

/* const saveCallToDB = async (callSid, agentId, leadId) => {
  try {
    const callFromTwilio= await getCallDetails(callSid);
    console.log("callFromTwilio",callFromTwilio);
    // Vérifier si l'appel existe déjà
    let existingCall = await Call.findOne({ sid: callSid });
    if (existingCall) {
      // Mise à jour de l'appel existant
      existingCall.status = callFromTwilio.status;
      existingCall.duration = parseInt(callFromTwilio.duration) || 0;
      existingCall.recording_url = callFromTwilio.recordingUrl;
      existingCall.childCalls[0] = callFromTwilio.ChildCallSid;
      existingCall.updatedAt = new Date();

      await existingCall.save();
      console.log(`📞 Call ${call.sid} mis à jour.`);
      return existingCall;
    } else {
      // Création d'un nouvel appel
      const newCall = new Call({
        agent: agentId,
        lead: leadId,
        sid: callFromTwilio.ParentCallSid,
        parentCallSid: callFromTwilio.ParentCallSid || null,
        direction: callFromTwilio.direction,
        status: callFromTwilio.status,
        duration: parseInt(callFromTwilio.duration) || 0,
        recording_url: callFromTwilio.recordingUrl,
        startTime: callFromTwilio.startTime,
        endTime:callFromTwilio.endTime,
        childCalls: callFromTwilio.ChildCallSid,
        recordingUrl: callFromTwilio.recordingUrl,
        createdAt: callFromTwilio.startTime,
        updatedAt: new Date(),
      });

      await newCall.save();
      console.log(`📞 Call ${callSid} enregistré avec succès.`);
      
      return newCall;
    }
  } catch (error) {
    console.error("❌ Erreur lors de l'enregistrement de l'appel :", error);
    throw new Error("Erreur lors de l'enregistrement de l'appel");
  }
}; */
const saveCallToDB = async (callSid, agentId, leadId) => {
  try {
    const callFromTwilio = await getCallDetails(callSid);
    console.log("callFromTwilio", callFromTwilio);

    // Vérifier si l'appel existe déjà
    let existingCall = await Call.findOne({ sid: callSid });
    let cloudinaryUrl = null;

    // Vérifier et stocker l'enregistrement s'il existe
    if (callFromTwilio.recordingUrl) {
      cloudinaryUrl = await storeRecordsInCloudinary(callFromTwilio.recordingUrl);
    }

    if (existingCall) {
      // Mise à jour de l'appel existant
      existingCall.status = callFromTwilio.status;
      existingCall.duration = parseInt(callFromTwilio.duration) || 0;
      existingCall.recording_url = callFromTwilio.recordingUrl; // Garder l'URL Twilio
      existingCall.recording_url_cloudinary = cloudinaryUrl; // Ajouter l'URL Cloudinary
      existingCall.childCalls[0] = callFromTwilio.ChildCallSid;
      existingCall.updatedAt = new Date();

      await existingCall.save();
      console.log(`📞 Call ${callSid} mis à jour.`);
      return existingCall;
    } else {
      // Création d'un nouvel appel
      const newCall = new Call({
        agent: agentId,
        lead: leadId,
        sid: callFromTwilio.ParentCallSid,
        parentCallSid: callFromTwilio.ParentCallSid || null,
        direction: callFromTwilio.direction,
        status: callFromTwilio.status,
        duration: parseInt(callFromTwilio.duration) || 0,
        recording_url: callFromTwilio.recordingUrl, // Stocker l'URL Twilio
        recording_url_cloudinary: cloudinaryUrl, // Stocker l'URL Cloudinary
        startTime: callFromTwilio.startTime,
        endTime: callFromTwilio.endTime,
        childCalls: callFromTwilio.ChildCallSid,
        createdAt: callFromTwilio.startTime,
        updatedAt: new Date(),
      });

      await newCall.save();
      console.log(`📞 Call ${callSid} enregistré avec succès.`);
      
      return newCall;
    }
  } catch (error) {
    console.error("❌ Erreur lors de l'enregistrement de l'appel :", error);
    throw new Error("Erreur lors de l'enregistrement de l'appel");
  }
};








// Service to make an outgoing call
const makeCall = async (to) => {
    // Validation du numéro
    if (!to || !to.startsWith('+')) {
        return Promise.reject('Numéro de téléphone invalide. Utilisez le format international, par exemple +1234567890');
    }

    return client.calls.create({
        url: 'https://a5a4-154-144-224-252.ngrok-free.app/api/calls/twilio-voice',  // Assurez-vous que cet URL soit accessible publiquement
        to: to,
        from: '+16185185941', // Numéro Twilio vérifié et acheté
        record: true  // Enable call recording

    })
    .then(call => {
        console.log(`Appel initié avec SID: ${call.sid}`);
        return call.sid;
    });
};





  const generateTwimlResponse = async (to) => {
    const twiml = new twilio.twiml.VoiceResponse();
  
    if (to) {
      const dial = twiml.dial({ callerId: process.env.TWILIO_PHONE_NUMBER, record: 'record-from-answer' });
      dial.number(to);
    } else {
      twiml.say("Numéro invalide");
    }
  
    return twiml.toString();
  };



// Service pour suivre l'état de l'appel
const trackCallStatus = async (callSid) => {
    console.log('we are here');
    return client.calls(callSid)
        .fetch()
        .then(call => {
            console.log('Détails de l\'appel:', call);  // Ajoutez cette ligne pour déboguer
            if (call && call.status) {
                console.log(`État de l'appel pour SID ${callSid}: ${call.status}`);
                return call.status;
            } else {
                throw new Error('Détails de l\'appel introuvables');
            }
        });
};

const hangUpCall = async(callSid) => {
    return client.calls(callSid)
        .update({ status: 'completed' })  // 'completed' ends the call
        .then(call => {
            console.log(`Call with SID ${callSid} ended.`);
            return call;
        })
        .catch(err => {
            console.error('Error ending call:', err);
            throw err;
        });
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
  

  
/*   const storeRecordsInCloudinary = async (recordingUrl) => {
    let response = "";
    try {
      console.log('Fetching Twilio recording...');
      try {
       
        const twilioResponse = await axios.get(recordingUrl, {
          headers: {
              'Authorization': `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
              'Accept': 'audio/mpeg',
              'Content-Type': 'audio/mpeg'
          },
          responseType: 'arraybuffer' // Ensures the response is treated as binary data
      });
        console.log("twilioResponse", twilioResponse.data);
    } catch (error) {
        console.error("Error fetching recording:", error.response || error);
    }
  
      console.log('Successfully fetched Twilio recording, uploading to Cloudinary...');
  
      // Uploader le fichier sur Cloudinary
      response = await cloudinary.uploader.upload_stream(
        { resource_type: 'video', folder: 'V25_Call_Records' },
        (error, result) => {
          if (error) {
            console.error('Error uploading to Cloudinary:', error);
            return null;
          }
          console.log('Uploaded to Cloudinary:', result);
          return result?.secure_url;
        }
      ).end(twilioResponse.data);
  
    } catch (err) {
      console.log('Error in storing call record in Cloudinary:', err);
      return response;
    }
  
    return response?.secure_url || response;
  };  */ 
  const storeRecordsInCloudinary = async (recordingUrl) => {
    try {
        console.log('Fetching Twilio recording...');
        
        const twilioResponse = await axios.get(recordingUrl, {
            headers: {
                'Authorization': `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
                'Accept': 'audio/mpeg',
                'Content-Type': 'audio/mpeg'
            },
            responseType: 'arraybuffer'
        });
        console.log("twilioResponse", twilioResponse);
        console.log("Successfully fetched Twilio recording, uploading to Cloudinary...");

        return new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
                { resource_type: 'video', folder: 'V25_Call_Records' },
                (error, result) => {
                    if (error) {
                        console.error('Error uploading to Cloudinary:', error);
                        return reject(error);
                    }
                    console.log('Uploaded to Cloudinary:', result);
                    resolve(result.secure_url);
                }
            );

            uploadStream.end(twilioResponse.data);
        });

    } catch (err) {
        console.error('Error in storing call record in Cloudinary:', err);
        return null;
    }
};









module.exports = {
    makeCall,trackCallStatus,hangUpCall,generateTwilioToken,generateTwimlResponse,getCallDetails,saveCallToDB
};



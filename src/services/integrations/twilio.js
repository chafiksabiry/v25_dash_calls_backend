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
const fetch = require('node-fetch');

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
const saveCallToDB = async (callSid, agentId, leadId, call, cloudinaryrecord) => {
  try {
  // Vérifier si l'appel existe déjà
    let existingCall = await Call.findOne({ sid: callSid });
   // let cloudinaryUrl = null;

    if (existingCall) {
      // Mise à jour de l'appel existant
      existingCall.status = call.status;
      existingCall.duration = parseInt(call.duration) || 0;
      existingCall.recording_url = call.recordingUrl; // Garder l'URL Twilio
      existingCall.recording_url_cloudinary = cloudinaryrecord; // Ajouter l'URL Cloudinary
      existingCall.childCalls[0] = call.ChildCallSid;
      existingCall.updatedAt = new Date();

      await existingCall.save();
      console.log(`📞 Call ${callSid} mis à jour.`);
      return existingCall;
    } else {
      // Création d'un nouvel appel
      const newCall = new Call({
        agent: agentId,
        lead: leadId,
        sid: call.ParentCallSid,
        parentCallSid: call.ParentCallSid || null,
        direction: call.direction,
        status: call.status,
        duration: parseInt(call.duration) || 0,
        recording_url: call.recordingUrl, // Stocker l'URL Twilio
        recording_url_cloudinary: cloudinaryrecord, // Stocker l'URL Cloudinary
        startTime: call.startTime,
        endTime: call.endTime,
        childCalls: call.ChildCallSid,
        createdAt: call.startTime,
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
  

  
  /*  const storeRecordsInCloudinary = async (recordingUrl) => {
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
  }; */  
/*   const storeRecordsInCloudinary = async (recordingUrl) => {
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
}; */
//the last one
 const storeRecordsInCloudinary = async (recordingUrl) => {
  try {
      console.log('Fetching Twilio recording...');
      console.log("recordingUrl to be fetched",recordingUrl);

      //const recordingUrl = "https://api.twilio.com/2010-04-01/Accounts/AC8a453959a6cb01cbbd1c819b00c5782f/Recordings/REcced49de7252ee0f2561d66fb951d1e0.mp3";
      const data = {
        recordingUrl,
    };
     const response= await axios.post('http://localhost:3000/api/calls/fetch-recording', data, {
        headers: {
            'Content-Type': 'application/json'
        }
    });
console.log("response.data",response.data);
      if (!response.data) {
          console.error("Twilio response is empty or invalid.");
          return null;
      }

      console.log("Successfully fetched Twilio recording, uploading to Cloudinary...");

      return new Promise((resolve, reject) => {
          const uploadStream =  cloudinary.uploader.upload_stream(
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

          uploadStream.end(twilioResponse);
      });

  } catch (err) {
      console.error('Error in storing call record in Cloudinary:', err);
      return null;
  }
};  


//fetch
/* const storeRecordsInCloudinary = async (recordingUrl) => {
  try {
      console.log('Fetching Twilio recording...');
      console.log("recordingUrl to be fetched", recordingUrl);
      let twilioResponse; // Déclaration de la variable avant le try-catch

      try {
          const response = await fetch(recordingUrl, {
              method: 'GET',
              headers: {
                  'Authorization': `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
                  'Accept': 'audio/mpeg',  // Indique que tu attends un fichier audio
                  'Content-Type': 'audio/mpeg'
              }
          });

          if (!response.ok) {
              throw new Error(`Failed to fetch Twilio recording. Status code: ${response.status}`);
          }

          // Récupère la réponse en tant que buffer binaire
          twilioResponse = await response.buffer();

          console.log("Twilio recording fetched successfully.");
      } catch (error) {
          console.error("Error fetching recording:", error);
          return null; // Stoppe l'exécution si l'enregistrement n'a pas pu être récupéré
      }

      if (!twilioResponse) {
          console.error("Twilio response is empty or invalid.");
          return null;
      }

      console.log("Successfully fetched Twilio recording, uploading to Cloudinary...");

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

          uploadStream.end(twilioResponse);
      });

  } catch (err) {
      console.error('Error in storing call record in Cloudinary:', err);
      return null;
  }
};
 */


async function fetchTwilioRecording(recordingUrl) {
  try {
      const auth = `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}`;
      console.log("auth",auth);
      const response = await axios.get(recordingUrl, {
          headers: {
              'Content-Type': 'audio/mpeg',
             'Accept': '*/*',
              'Authorization': auth,
          },
          responseType: 'arraybuffer',
     });
      
      console.log("Twilio recording fetched:",response.data);
      
      return new Promise((resolve, reject) => {
        const uploadStream =  cloudinary.uploader.upload_stream(
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
     // return response.data;
  } catch (error) {
      console.error("Error fetching recording:", error.response || error);
      return null;
  }
}





module.exports = {
    makeCall,trackCallStatus,hangUpCall,generateTwilioToken,generateTwimlResponse,getCallDetails,saveCallToDB,fetchTwilioRecording
};



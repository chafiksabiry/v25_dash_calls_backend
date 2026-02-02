const mongoose = require("mongoose");
const Call = mongoose.model('Call')
const axios = require('axios');
exports.storeCallsInDBatStartingCall = async (data = {}) => {
  console.log("Data received in qaqlulService:", data);
  
  // Extract call_id, id_lead, and caller from the data
  const { call_id = null, id_lead = null, caller = null } = data;

  try {
    // Create a new Call document with the required fields
    const newCall = new Call({
      call_id,
      agent: caller, // Set the agent field using the caller ID
      lead: id_lead, // Set the lead field using id_lead
      provider: 'qalqul',
      // status: 'started',
      startTime: new Date(),
      direction: 'outbound-dial',
    });

    // Save the call to the database
    await newCall.save();
    
    return newCall;
  } catch (error) {
    console.error('Error storing call:', error);
    throw error;
  }
};

exports.getOneQalqulCallDetails = async (telephone1, call_id) => {
  if (!process.env.QALQUL_API || !process.env.QALQUL_KEY) {
    console.error("API URL or API Key is missing");
    return null;
  }

  const url = `${process.env.QALQUL_API}/history/${telephone1}`;
  //console.log("senturl", url);
  const myHeaders = { 'Content-Type': 'application/json' };
  const body_req = { uuid: call_id };
  const newUrl = `${url}?apikey=${process.env.QALQUL_KEY}`;
  //console.log("newurl", newUrl);
  console.log("body_req", body_req);
  try {
    const response = await axios.get(newUrl, {
      headers: myHeaders,
      data: body_req,
    });

    const json = response.data;
    if (json.error) {
      console.error('Error to get call detail from Qalqul:', json.error);
      return null;
    }
    console.log("dataResult", json.data.data);
    return json.data.data[0];

  } catch (err) {
    console.error('Error to get call detail from Qalqul:', err);
    return null;
  }
};

exports.storeCallsInDBatEndingCall = async (phoneNumber, callSid) => {
  console.log("callSid from qalqul:", callSid);
  try {
    const callDetails = await this.getOneQalqulCallDetails(phoneNumber, callSid);
    console.log("callDetails from qalqul:", callDetails);
    //update the call details in the database
    const updatedCall = await Call.findOneAndUpdate({ call_id: callSid }, {
      $set: {
        endTime: new Date(),
        status: callDetails.callStatus,
        duration: callDetails.callDuration,
        recordingUrl: callDetails.audioFileURL
      },
    });
    return updatedCall;
  } catch (error) {
    console.error('Error storing call:', error);
    throw error;
  }
};

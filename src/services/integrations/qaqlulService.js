const mongoose = require("mongoose");
const Call = mongoose.model('Call')

exports.storeCallsInDBatStartingCall = async (storeCall) => {
  const { call_id, id_lead, caller } = storeCall;

  try {
    const newCall = new Call({
      call_id,
      id_lead,
      caller,
      provider: 'qalqul',
     // status: 'started',
     startTime: new Date(),
     direction: 'outbound-dial',
    });

    return newCall;
  } catch (error) {
    console.error('Error storing call:', error);
    throw error;
  }
};


const axios = require('axios');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Issue a Telnyx WebRTC login token for the browser SDK.
 * Prefers telephony credential id; falls back to connection + SIP credentials.
 */
exports.generateLoginToken = async () => {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error('TELNYX_API_KEY is not configured');
  }

  const credentialId = process.env.TELNYX_TELEPHONY_CREDENTIAL_ID;
  if (credentialId) {
    const response = await axios.post(
      `https://api.telnyx.com/v2/telephony_credentials/${credentialId}/token`,
      {},
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );
    const token = response.data?.data?.token || response.data?.token;
    if (!token) {
      throw new Error('Telnyx credential token response missing token');
    }
    return token;
  }

  const connectionId = process.env.TELNYX_CONNECTION_ID;
  const username = process.env.TELNYX_USERNAME;
  const password = process.env.TELNYX_PASSWORD;

  if (!connectionId || !username || !password) {
    throw new Error(
      'Telnyx WebRTC credentials missing: set TELNYX_TELEPHONY_CREDENTIAL_ID or TELNYX_CONNECTION_ID + TELNYX_USERNAME + TELNYX_PASSWORD'
    );
  }

  const response = await axios.post(
    'https://api.telnyx.com/v2/telephony_credentials/login_token',
    {
      connection_id: connectionId,
      credential_username: username,
      credential_password: password,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const token = response.data?.data?.token || response.data?.token;
  if (!token) {
    throw new Error('Telnyx login_token response missing token');
  }
  return token;
};

/**
 * Download a public recording URL and archive it to Cloudinary.
 */
exports.archivePublicRecording = async (recordingUrl) => {
  if (!recordingUrl) return null;

  const response = await axios.get(recordingUrl, {
    responseType: 'arraybuffer',
    timeout: 60000,
  });

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { resource_type: 'video', folder: 'V25_Call_Records' },
      (error, result) => {
        if (error) {
          console.error('[Telnyx] Cloudinary upload failed:', error);
          return reject(error);
        }
        resolve(result.secure_url);
      }
    );
    uploadStream.end(response.data);
  });
};

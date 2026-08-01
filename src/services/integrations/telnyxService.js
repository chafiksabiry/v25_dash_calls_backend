const axios = require('axios');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function telnyxHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function extractToken(payload) {
  return payload?.data?.token || payload?.token || null;
}

async function tokenFromCredentialId(apiKey, credentialId) {
  const response = await axios.post(
    `https://api.telnyx.com/v2/telephony_credentials/${credentialId}/token`,
    {},
    { headers: telnyxHeaders(apiKey) }
  );
  const token = extractToken(response.data);
  if (!token) {
    throw new Error('Telnyx credential token response missing token');
  }
  return token;
}

/**
 * When only a Credential Connection id is configured, create a short-lived
 * telephony credential then mint a JWT for the browser SDK.
 */
async function tokenFromConnectionId(apiKey, connectionId) {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const createRes = await axios.post(
    'https://api.telnyx.com/v2/telephony_credentials',
    {
      connection_id: connectionId,
      name: `harx-webrtc-${Date.now()}`,
      expires_at: expiresAt,
    },
    { headers: telnyxHeaders(apiKey) }
  );

  const credentialId =
    createRes.data?.data?.id ||
    createRes.data?.id ||
    null;
  if (!credentialId) {
    throw new Error('Telnyx create telephony_credential response missing id');
  }

  return tokenFromCredentialId(apiKey, credentialId);
}

/**
 * Issue a Telnyx WebRTC login token for the browser SDK.
 *
 * Accepted env (first match wins):
 * 1. TELNYX_TELEPHONY_CREDENTIAL_ID + TELNYX_API_KEY
 * 2. TELNYX_CONNECTION_ID|TELNYX_APPLICATION_ID + TELNYX_USERNAME + TELNYX_PASSWORD + TELNYX_API_KEY
 * 3. TELNYX_CONNECTION_ID|TELNYX_APPLICATION_ID + TELNYX_API_KEY (on-demand credential)
 */
exports.generateLoginToken = async () => {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error('TELNYX_API_KEY is not configured');
  }

  const credentialId = process.env.TELNYX_TELEPHONY_CREDENTIAL_ID;
  if (credentialId) {
    return tokenFromCredentialId(apiKey, credentialId);
  }

  const connectionId =
    process.env.TELNYX_CONNECTION_ID ||
    process.env.TELNYX_APPLICATION_ID;
  const username = process.env.TELNYX_USERNAME;
  const password = process.env.TELNYX_PASSWORD;

  if (connectionId && username && password) {
    const response = await axios.post(
      'https://api.telnyx.com/v2/telephony_credentials/login_token',
      {
        connection_id: connectionId,
        credential_username: username,
        credential_password: password,
      },
      { headers: telnyxHeaders(apiKey) }
    );
    const token = extractToken(response.data);
    if (!token) {
      throw new Error('Telnyx login_token response missing token');
    }
    return token;
  }

  if (connectionId) {
    console.log(
      '[Telnyx] Minting WebRTC token via on-demand telephony credential for connection',
      connectionId
    );
    return tokenFromConnectionId(apiKey, connectionId);
  }

  throw new Error(
    'Telnyx WebRTC credentials missing: set TELNYX_TELEPHONY_CREDENTIAL_ID, or TELNYX_CONNECTION_ID / TELNYX_APPLICATION_ID (optionally + TELNYX_USERNAME + TELNYX_PASSWORD)'
  );
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

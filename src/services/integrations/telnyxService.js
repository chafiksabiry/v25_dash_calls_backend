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

function formatTelnyxError(err) {
  const errors = err?.response?.data?.errors;
  if (Array.isArray(errors) && errors.length) {
    return errors
      .map((e) => e.detail || e.title || e.code || JSON.stringify(e))
      .join('; ');
  }
  if (err?.response?.data) {
    try {
      return JSON.stringify(err.response.data);
    } catch {
      /* ignore */
    }
  }
  return err?.message || 'Unknown Telnyx error';
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
 * Create a telephony credential on a Credential Connection, then mint a JWT.
 * Tries a couple of payload shapes because Telnyx is picky about expires_at.
 */
async function tokenFromConnectionId(apiKey, connectionId) {
  const payloads = [
    { connection_id: connectionId, name: `harx-webrtc-${Date.now()}` },
    {
      connection_id: connectionId,
      name: `harx-webrtc-${Date.now()}`,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, ''),
    },
  ];

  let lastErr;
  for (const body of payloads) {
    try {
      const createRes = await axios.post(
        'https://api.telnyx.com/v2/telephony_credentials',
        body,
        { headers: telnyxHeaders(apiKey) }
      );
      const credentialId = createRes.data?.data?.id || createRes.data?.id;
      if (!credentialId) {
        throw new Error('Telnyx create telephony_credential response missing id');
      }
      return tokenFromCredentialId(apiKey, credentialId);
    } catch (err) {
      lastErr = err;
      console.error(
        '[Telnyx] create telephony_credential failed for',
        connectionId,
        formatTelnyxError(err)
      );
    }
  }

  const wrapped = new Error(
    `Telnyx rejected connection_id ${connectionId}: ${formatTelnyxError(lastErr)}`
  );
  wrapped.cause = lastErr;
  throw wrapped;
}

function connectionCandidates() {
  const seen = new Set();
  const out = [];
  for (const [label, value] of [
    ['TELNYX_CONNECTION_ID', process.env.TELNYX_CONNECTION_ID],
    ['TELNYX_APPLICATION_ID', process.env.TELNYX_APPLICATION_ID],
  ]) {
    const id = (value || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ label, id });
  }
  return out;
}

/**
 * Issue a Telnyx WebRTC login token for the browser SDK.
 *
 * Accepted env (first match wins):
 * 1. TELNYX_TELEPHONY_CREDENTIAL_ID + TELNYX_API_KEY
 * 2. TELNYX_CONNECTION_ID|TELNYX_APPLICATION_ID + TELNYX_USERNAME + TELNYX_PASSWORD + TELNYX_API_KEY
 * 3. TELNYX_CONNECTION_ID and/or TELNYX_APPLICATION_ID + TELNYX_API_KEY (on-demand credential)
 */
exports.generateLoginToken = async () => {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error('TELNYX_API_KEY is not configured');
  }

  const credentialId = process.env.TELNYX_TELEPHONY_CREDENTIAL_ID;
  if (credentialId) {
    try {
      return await tokenFromCredentialId(apiKey, credentialId);
    } catch (err) {
      throw new Error(
        `TELNYX_TELEPHONY_CREDENTIAL_ID token failed: ${formatTelnyxError(err)}`
      );
    }
  }

  const candidates = connectionCandidates();
  const username = process.env.TELNYX_USERNAME;
  const password = process.env.TELNYX_PASSWORD;

  if (candidates.length && username && password) {
    let lastErr;
    for (const { label, id } of candidates) {
      try {
        const response = await axios.post(
          'https://api.telnyx.com/v2/telephony_credentials/login_token',
          {
            connection_id: id,
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
      } catch (err) {
        lastErr = err;
        console.error('[Telnyx] login_token failed for', label, formatTelnyxError(err));
      }
    }
    throw new Error(`Telnyx login_token failed: ${formatTelnyxError(lastErr)}`);
  }

  if (candidates.length) {
    const failures = [];
    for (const { label, id } of candidates) {
      try {
        console.log(`[Telnyx] Minting WebRTC token via on-demand credential (${label}=${id})`);
        return await tokenFromConnectionId(apiKey, id);
      } catch (err) {
        failures.push(`${label}: ${err.message}`);
      }
    }
    throw new Error(
      `Telnyx WebRTC on-demand credential failed. ${failures.join(' | ')}. ` +
        'Use a Credential Connection id (Mission Control → Voice → Credential Connections), ' +
        'or set TELNYX_TELEPHONY_CREDENTIAL_ID.'
    );
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

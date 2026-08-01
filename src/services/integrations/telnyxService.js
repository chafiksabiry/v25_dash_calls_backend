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
  if (!payload) return null;
  // Telnyx may return the JWT as a bare string, as data:<jwt>, or data.token
  if (typeof payload === 'string' && payload.length > 20) return payload;
  if (typeof payload.data === 'string' && payload.data.length > 20) return payload.data;
  if (typeof payload.data?.token === 'string') return payload.data.token;
  if (typeof payload.token === 'string') return payload.token;
  return null;
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
    const shape = response.data && typeof response.data === 'object'
      ? Object.keys(response.data).join(',')
      : typeof response.data;
    throw new Error(`Telnyx credential token response missing token (shape=${shape})`);
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
      console.log('[Telnyx] Created telephony credential', credentialId, 'on', connectionId);
      return tokenFromCredentialId(apiKey, credentialId);
    } catch (err) {
      lastErr = err;
      // Distinguish create vs token step for clearer Railway logs
      const step = err.message?.includes('token') ? 'token' : 'create';
      console.error(
        `[Telnyx] ${step} telephony_credential failed for`,
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
  const username = (process.env.TELNYX_USERNAME || '').trim();
  const password = (process.env.TELNYX_PASSWORD || '').trim();
  const failures = [];

  // SIP login_token (optional). On failure, keep going — on-demand credential often works.
  if (candidates.length && username && password) {
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
        const detail = formatTelnyxError(err);
        failures.push(`login_token/${label}: ${detail}`);
        console.error('[Telnyx] login_token failed for', label, detail);
      }
    }
  }

  if (candidates.length) {
    for (const { label, id } of candidates) {
      try {
        console.log(`[Telnyx] Minting WebRTC token via on-demand credential (${label}=${id})`);
        return await tokenFromConnectionId(apiKey, id);
      } catch (err) {
        failures.push(`on-demand/${label}: ${err.message}`);
      }
    }
  }

  if (failures.length) {
    throw new Error(
      `Telnyx WebRTC auth failed. ${failures.join(' | ')}. ` +
        'Set TELNYX_TELEPHONY_CREDENTIAL_ID, or a valid Credential Connection id in TELNYX_CONNECTION_ID ' +
        '(Mission Control → Voice → Credential Connections). Remove wrong TELNYX_USERNAME/PASSWORD if unused.'
    );
  }

  throw new Error(
    'Telnyx WebRTC credentials missing: set TELNYX_TELEPHONY_CREDENTIAL_ID, or TELNYX_CONNECTION_ID / TELNYX_APPLICATION_ID (optionally + TELNYX_USERNAME + TELNYX_PASSWORD)'
  );
};

function getApiKey() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) throw new Error('TELNYX_API_KEY is not configured');
  return apiKey;
}

/**
 * Start dual-channel MP3 recording on an active Call Control leg.
 */
exports.startCallRecording = async (callControlId) => {
  if (!callControlId) throw new Error('callControlId is required');
  const apiKey = getApiKey();
  const response = await axios.post(
    `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/record_start`,
    {
      format: 'mp3',
      channels: 'dual',
      play_beep: false,
    },
    { headers: telnyxHeaders(apiKey) }
  );
  return response.data?.data || response.data || { ok: true };
};

/**
 * Look up a public recording URL for a call control id (webhook fallback).
 */
exports.findRecordingUrl = async (callControlId) => {
  if (!callControlId) return null;
  const apiKey = getApiKey();
  try {
    const response = await axios.get('https://api.telnyx.com/v2/recordings', {
      headers: telnyxHeaders(apiKey),
      params: {
        'filter[call_control_id]': callControlId,
        'page[size]': 5,
      },
    });
    const rows = response.data?.data || [];
    for (const row of rows) {
      const url =
        row.download_urls?.mp3 ||
        row.public_recording_urls?.mp3 ||
        row.recording_urls?.mp3 ||
        row.download_urls?.wav ||
        null;
      if (url) return url;
    }
  } catch (err) {
    console.warn('[Telnyx] findRecordingUrl failed:', formatTelnyxError(err));
  }
  return null;
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

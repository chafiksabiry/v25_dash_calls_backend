const WebSocket = require('ws');
const { activeCalls } = require('./audioServer');

let io; // Référence Socket.IO
let telnyxStreams = new Map(); // Map des streams Telnyx par call_control_id

// Gérer le Media Stream de Telnyx (audio bidirectionnel)
function handleTelnyxMediaStream(ws, req) {
  console.log('🎵 Telnyx Media Stream connecté');
  
  let currentCallId = null;
  
  // Fonction pour traiter les messages JSON
  function handleJsonMessage(data) {
    switch(data.event) {
      case 'connected':
        // Première connexion établie - attendre le message "start"
        console.log(`✅ Connexion Media Stream établie (version: ${data.version})`);
        break;
        
      case 'start':
        // Telnyx envoie le call_control_id dans le message start
        currentCallId = data.call_control_id || data.callControlId || data.metadata?.call_control_id || data.start?.call_control_id;
        
        if (currentCallId) {
          telnyxStreams.set(currentCallId, ws);
          console.log(`🎤 Stream démarré pour call: ${currentCallId}`);
        } else {
          console.error('❌ Pas de call_control_id dans le message start:', JSON.stringify(data, null, 2));
        }
        break;
        
      case 'media':
        // Audio reçu de Telnyx (voix du receiver) au format JSON
        if (currentCallId && data.media && data.media.payload) {
          sendAudioToFrontend(currentCallId, data.media.payload);
        } else if (data.media && !currentCallId) {
          console.log('⚠️ Media reçu mais pas de currentCallId');
        } else if (!data.media || !data.media.payload) {
          console.log('⚠️ Media reçu mais pas de payload:', JSON.stringify(data).substring(0, 100));
        }
        break;
        
      case 'stop':
        console.log(`🔇 Stream terminé pour call: ${currentCallId}`);
        telnyxStreams.delete(currentCallId); // Retirer le stream
        break;
        
      default:
        console.log(`⚠️ Événement Telnyx non géré: ${data.event}`, JSON.stringify(data, null, 2));
        break;
    }
  }

  let receivedPacketCount = 0;
  
  ws.on('message', (message) => {
    try {
      // Vérifier si c'est un message binaire ou JSON
      if (Buffer.isBuffer(message)) {
        // Essayer de parser en JSON d'abord
        const strMessage = message.toString('utf8');
        
        // Si ça ressemble à du JSON, essayer de le parser
        if (strMessage.startsWith('{')) {
          const data = JSON.parse(strMessage);
          
          // Log TOUS les messages media pour debug
          if (data.event === 'media') {
            if (receivedPacketCount === 0) {
              console.log('🎧 PREMIER MESSAGE MEDIA REÇU DE TELNYX !', JSON.stringify(data, null, 2));
            } else if (receivedPacketCount % 10 === 0) {
              console.log(`📨 Audio reçu de Telnyx (packet #${receivedPacketCount})`);
            }
            receivedPacketCount++;
          } else {
            console.log('📨 Message JSON Telnyx:', JSON.stringify(data, null, 2));
          }
          
          // Traiter comme un message JSON
          handleJsonMessage(data);
          return;
        }
        
        // Sinon, c'est de l'audio binaire
        if (currentCallId) {
          const audioBase64 = message.toString('base64');
          sendAudioToFrontend(currentCallId, audioBase64);
          console.log('🎧 Audio binaire reçu de Telnyx');
        }
        return;
      }

      // Message JSON string
      const data = JSON.parse(message.toString());
      if (data.event !== 'media') {
        console.log('📨 Message JSON Telnyx:', JSON.stringify(data, null, 2));
      } else {
        console.log('🎧 Message media reçu (string)');
      }
      handleJsonMessage(data);
    } catch (error) {
      console.error('❌ Erreur parsing message Telnyx:', error);
      console.error('Message brut:', message.toString('utf8').substring(0, 200));
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`🔌 Telnyx Media Stream déconnecté - Code: ${code}, Raison: ${reason}`);
    if (currentCallId) {
      telnyxStreams.delete(currentCallId);
    }
  });

  ws.on('error', (error) => {
    console.error('❌ Erreur WebSocket Media Stream:', error);
  });

  // Fonction pour envoyer audio du frontend vers Telnyx
  ws.sendAudioToTelnyx = (audioData) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        event: 'media',
        media: {
          payload: audioData
        }
      }));
    }
  };

  return ws;
}

// Envoyer l'audio au client frontend via Socket.IO
let frontendSentCount = 0;
function sendAudioToFrontend(callControlId, audioPayload) {
  if (!io) {
    console.log('⚠️ IO not available pour sendAudioToFrontend');
    return;
  }
  
  const call = activeCalls.get(callControlId);
  if (call) {
    const socket = io.sockets.sockets.get(call.socketId);
    if (socket) {
      socket.emit('audio-received', {
        callControlId,
        audioChunk: audioPayload,
        timestamp: Date.now()
      });
      
      // Log tous les 10 packets
      if (frontendSentCount % 10 === 0) {
        console.log(`📤 Audio envoyé au frontend (#${frontendSentCount}, ${audioPayload.length} chars)`);
      }
      frontendSentCount++;
    } else {
      console.log('⚠️ Socket not found pour call', callControlId);
    }
  } else {
    if (frontendSentCount % 10 === 0) {
      console.log('⚠️ Call not found dans activeCalls pour', callControlId);
    }
  }
}

// Envoyer l'audio du frontend vers Telnyx
let sentPacketCount = 0;
function sendAudioToTelnyx(callControlId, audioPayload) {
  const telnyxWs = telnyxStreams.get(callControlId);
  
  if (telnyxWs && telnyxWs.readyState === WebSocket.OPEN) {
    telnyxWs.send(JSON.stringify({
      event: 'media',
      media: {
        payload: audioPayload
      }
    }));
    
    // Log tous les 10 packets
    if (sentPacketCount % 10 === 0) {
      console.log(`🎵 Audio envoyé vers Telnyx (${audioPayload.length} chars)`);
    }
    sentPacketCount++;
  } else {
    if (sentPacketCount % 10 === 0) {
      console.log(`⚠️ Stream non disponible pour ${callControlId} (readyState: ${telnyxWs ? telnyxWs.readyState : 'no WS'})`);
    }
  }
}

function setIO(socketIO) {
  io = socketIO;
}

module.exports = {
  handleTelnyxMediaStream,
  sendAudioToTelnyx,
  setIO
};


const WebSocket = require('ws');
const { activeCalls } = require('./audioServer');
const { alawToMulaw, mulawToAlaw } = require('./g711'); // Conversion REQUISE : Telnyx=PCMA, Frontend=PCMU

let io; // Référence Socket.IO
let telnyxStreams = new Map(); // Map des streams Telnyx par call_control_id

// Gérer le Media Stream de Telnyx (audio bidirectionnel)
function handleTelnyxMediaStream(ws, req) {
  console.log('🎵 Telnyx Media Stream connecté');
  
  let currentCallId = null;
  let totalMediaPacketsReceived = 0; // Compteur total de tous les packets media (inbound + outbound)
  
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
          
          // Log du format média négocié
          if (data.start && data.start.media_format) {
             console.log('ℹ️ Format média Telnyx négocié:', JSON.stringify(data.start.media_format));
          }
        } else {
          console.error('❌ Pas de call_control_id dans le message start:', JSON.stringify(data, null, 2));
        }
        break;
        
      case 'media':
        // Audio reçu de Telnyx (voix du receiver)
        // Telnyx envoie PCMA (A-Law), Frontend attend PCMU (u-Law) → CONVERSION REQUISE
        totalMediaPacketsReceived++; // Incrémenter le compteur total
        
        if (!currentCallId) {
          console.log('⚠️ Media reçu mais pas de currentCallId');
          break;
        }
        
        if (!data.media || !data.media.payload) {
          console.log('⚠️ Media reçu mais pas de payload');
          break;
        }
        
        // Vérifier le track (inbound = voix de l'interlocuteur, outbound = votre voix)
        const track = data.media.track || 'unknown';
        
        // Log le premier packet pour voir la structure
        if (totalMediaPacketsReceived === 1) {
          console.log(`🎧 PREMIER PACKET MEDIA - track: "${track}", hasTrack: ${!!data.media.track}, payloadLength: ${data.media.payload?.length || 0}`);
        }
        
        // Log tous les packets pour les 50 premiers pour diagnostiquer
        if (totalMediaPacketsReceived <= 50) {
          console.log(`📊 Packet media #${totalMediaPacketsReceived} - track: "${track}", payloadLength: ${data.media.payload?.length || 0} chars`);
        } else if (totalMediaPacketsReceived % 50 === 0) {
          console.log(`📊 Packet media #${totalMediaPacketsReceived} - track: "${track}"`);
        }
        
        try {
          const alawBuffer = Buffer.from(data.media.payload, 'base64');
          
          // Log pour les premiers packets pour diagnostiquer
          if (receivedPacketCount === 0) {
            console.log(`📊 PREMIER PACKET AUDIO - Bytes de test: ${Array.from(alawBuffer.slice(0, 5)).join(', ')}, taille: ${alawBuffer.length} bytes`);
          }
          
          const mulawBuffer = alawToMulaw(alawBuffer);
          const mulawPayload = mulawBuffer.toString('base64');
          
          // Envoyer l'audio au frontend si c'est inbound OU si le track n'est pas spécifié (fallback)
          // Avec 'both_tracks', Telnyx devrait envoyer les deux tracks séparément
          if (track === 'inbound' || track === 'unknown' || !data.media.track) {
            // Envoyer au frontend (voix de l'interlocuteur)
            sendAudioToFrontend(currentCallId, mulawPayload);
            
            // Log tous les packets pour les 50 premiers pour diagnostiquer
            const sampleRate = 8000; // G.711 utilise 8kHz
            if (receivedPacketCount < 50) {
              console.log(`🎧 Audio ${track || 'unknown'} reçu et envoyé au frontend (packet #${receivedPacketCount}, ${mulawPayload.length} chars, ${alawBuffer.length} bytes A-Law = ${(alawBuffer.length / sampleRate * 1000).toFixed(1)}ms)`);
            } else if (receivedPacketCount % 50 === 0) {
              console.log(`🎧 Audio ${track || 'unknown'} reçu et envoyé au frontend (packet #${receivedPacketCount}, ${mulawPayload.length} chars)`);
            }
            receivedPacketCount++;
          } else if (track === 'outbound') {
            // Audio outbound = votre voix, on ne l'envoie pas au frontend (évite l'écho)
            // Log tous les packets outbound pour les 50 premiers pour diagnostiquer
            const sampleRate = 8000;
            if (receivedPacketCount < 50) {
              console.log(`🎤 Audio outbound reçu (votre voix, ignoré) - packet #${receivedPacketCount}, ${alawBuffer.length} bytes A-Law = ${(alawBuffer.length / sampleRate * 1000).toFixed(1)}ms`);
            } else if (receivedPacketCount % 50 === 0) {
              console.log(`🎤 Audio outbound reçu (votre voix, ignoré) - packet #${receivedPacketCount}`);
            }
            // Créer un compteur séparé pour outbound
            if (!global.outboundPacketCount) {
              global.outboundPacketCount = new Map();
            }
            const outboundCount = (global.outboundPacketCount.get(currentCallId) || 0) + 1;
            global.outboundPacketCount.set(currentCallId, outboundCount);
            
            // Log avec le compteur outbound correct
            if (outboundCount <= 50) {
              console.log(`🎤 Audio outbound reçu (votre voix, ignoré) - packet outbound #${outboundCount}, ${alawBuffer.length} bytes A-Law = ${(alawBuffer.length / sampleRate * 1000).toFixed(1)}ms`);
            } else if (outboundCount % 50 === 0) {
              console.log(`🎤 Audio outbound reçu (votre voix, ignoré) - packet outbound #${outboundCount}`);
            }
            // Ne pas incrémenter receivedPacketCount pour outbound car on ne l'envoie pas
          }
        } catch (error) {
          console.error('❌ Erreur conversion A-Law → u-Law:', error);
          // En cas d'erreur, essayer sans conversion (peut fonctionner si Telnyx change de format)
          sendAudioToFrontend(currentCallId, data.media.payload);
        }
        break;
        
      case 'stop':
        console.log(`🔇 Stream terminé pour call: ${currentCallId}`);
        // Afficher le résumé avant de nettoyer
        const outboundCount = global.outboundPacketCount?.get(currentCallId) || 0;
        console.log(`📊 Résumé stream (stop event) pour ${currentCallId}: ${receivedPacketCount} packets inbound envoyés au frontend, ${outboundCount} packets outbound reçus (ignorés), ${totalMediaPacketsReceived} packets media totaux`);
        telnyxStreams.delete(currentCallId); // Retirer le stream
        // Nettoyer le flag de stream démarré
        if (global.startedStreams) {
          global.startedStreams.delete(currentCallId);
        }
        if (global.outboundPacketCount) {
          global.outboundPacketCount.delete(currentCallId);
        }
        break;
        
      default:
        // Ignorer les autres événements pour ne pas polluer
        // console.log(`⚠️ Événement Telnyx non géré: ${data.event}`);
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
          
          // Log pour debug (uniquement start/stop ou erreur)
          if (data.event !== 'media') {
            console.log('📨 Message JSON Telnyx:', JSON.stringify(data, null, 2));
          } else {
            // Log le premier packet media pour debug
            if (receivedPacketCount === 0) {
              console.log('🎧 PREMIER AUDIO REÇU (JSON)', JSON.stringify({
                hasPayload: !!(data.media && data.media.payload),
                payloadLength: data.media?.payload?.length || 0,
                currentCallId: currentCallId
              }));
            }
          }
          
          handleJsonMessage(data);
          return;
        }
        
        // Sinon, c'est de l'audio binaire (Raw PCMA de Telnyx)
        // Conversion A-Law → u-Law pour le frontend
        if (currentCallId) {
          try {
            const alawBuffer = message; // C'est déjà un Buffer
            const mulawBuffer = alawToMulaw(alawBuffer);
            const audioBase64 = mulawBuffer.toString('base64');
            sendAudioToFrontend(currentCallId, audioBase64);
            
            if (receivedPacketCount === 0) console.log('🎧 PREMIER AUDIO BINAIRE REÇU (converti A→u)');
            receivedPacketCount++;
          } catch (error) {
            console.error('❌ Erreur conversion binaire:', error);
          }
        }
        return;
      }

      // Message JSON string
      const data = JSON.parse(message.toString());
      if (data.event !== 'media') {
        console.log('📨 Message JSON Telnyx:', JSON.stringify(data, null, 2));
      }
      // Note: Le compteur receivedPacketCount est maintenant géré dans handleJsonMessage pour 'media'
      handleJsonMessage(data);
    } catch (error) {
      console.error('❌ Erreur parsing message Telnyx:', error);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`🔌 Telnyx Media Stream déconnecté - Code: ${code}, Raison: ${reason}`);
    if (currentCallId) {
      const outboundCount = global.outboundPacketCount?.get(currentCallId) || 0;
      console.log(`📊 Résumé stream pour ${currentCallId}: ${receivedPacketCount} packets inbound envoyés au frontend, ${outboundCount} packets outbound reçus (ignorés), ${totalMediaPacketsReceived} packets media totaux`);
      telnyxStreams.delete(currentCallId);
      if (global.startedStreams) {
        global.startedStreams.delete(currentCallId);
      }
      if (global.outboundPacketCount) {
        global.outboundPacketCount.delete(currentCallId);
      }
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
  if (!io) return;
  
  const call = activeCalls.get(callControlId);
  if (call) {
    const socket = io.sockets.sockets.get(call.socketId);
    if (socket) {
      socket.emit('audio-received', {
        callControlId,
        audioChunk: audioPayload,
        timestamp: Date.now()
      });
      
      // Log tous les 10 packets pour debug
      if (frontendSentCount % 10 === 0) {
        console.log(`📤 Audio envoyé au frontend (#${frontendSentCount}, ${audioPayload.length} chars)`);
      }
      frontendSentCount++;
    } else {
      if (frontendSentCount % 50 === 0) {
        console.log(`⚠️ Socket not found pour call ${callControlId} (socketId: ${call.socketId})`);
      }
    }
  } else {
    if (frontendSentCount % 50 === 0) {
      console.log(`⚠️ Call not found dans activeCalls pour ${callControlId}`);
      console.log(`📋 Appels actifs:`, Array.from(activeCalls.keys()));
    }
  }
}

// Envoyer l'audio du frontend vers Telnyx
let sentPacketCount = 0;
function sendAudioToTelnyx(callControlId, audioPayload) {
  const telnyxWs = telnyxStreams.get(callControlId);
  
  if (telnyxWs && telnyxWs.readyState === WebSocket.OPEN) {
    // CONVERSION REQUISE : Frontend envoie u-Law (PCMU), Telnyx attend PCMA (A-Law)
    try {
      const ulawBuffer = Buffer.from(audioPayload, 'base64');
      const alawBuffer = mulawToAlaw(ulawBuffer);
      const alawPayload = alawBuffer.toString('base64');
      
      telnyxWs.send(JSON.stringify({
        event: 'media',
        media: {
          payload: alawPayload
        }
      }));
      
      if (sentPacketCount % 50 === 0) {
        console.log(`🎵 Audio envoyé vers Telnyx (${audioPayload.length} chars → converti u→A)`);
      }
      sentPacketCount++;
    } catch (error) {
      console.error('❌ Erreur conversion u-Law → A-Law:', error);
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

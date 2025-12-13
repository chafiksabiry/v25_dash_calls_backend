# 🔍 Diagnostic Audio - Problème : Seulement 6 packets reçus

## Problème actuel

- **Seulement 6 packets inbound reçus** (packet #0 à #5), puis plus rien
- **Un packet très petit** (packet #1 avec seulement 2 bytes = 0.3ms) - suspect
- **L'enregistrement est presque vide** car seulement 6 packets = ~120ms d'audio total
- **L'utilisateur entend presque rien** car seulement 6 packets de 20ms chacun = 120ms d'audio

## Causes possibles

### 1. ⚠️ L'interlocuteur ne parle pas
**Telnyx n'envoie des packets audio que lorsqu'il y a de l'audio réel.**

- Si l'interlocuteur ne parle pas, vous ne recevrez pas de packets audio
- Si l'interlocuteur parle mais que vous n'entendez rien, il y a un problème avec le stream

**Test :** Demander à l'interlocuteur de parler continuellement pendant 10 secondes et vérifier les logs backend.

### 2. ⚠️ Problème avec `both_tracks`
**Peut-être que `both_tracks` cause des problèmes.**

**Test :** Essayer avec `inbound_track` seulement pour voir si cela change quelque chose.

### 3. ⚠️ Configuration Telnyx Portal
**Vérifier la configuration Telnyx Portal :**

1. **Media Streaming activé** : 
   - Aller dans **Voice API Applications** → **Edit Application**
   - Vérifier que **Media Streaming** est activé
   - Vérifier que l'URL WebSocket est correcte : `wss://api-calls.harx.ai/audio-stream`

2. **Codecs** :
   - Aller dans **Inbound** → **Codecs**
   - Vérifier que **G711A (PCMA)** est en premier dans la liste
   - Vérifier que **G711U (PCMU)** est en deuxième position

3. **Enregistrement automatique** :
   - Désactiver l'enregistrement automatique au niveau du numéro ET de l'application
   - Notre code démarre déjà l'enregistrement manuellement

### 4. ⚠️ Problème avec le WebSocket
**Vérifier que le WebSocket est accessible :**

```bash
# Tester l'accessibilité WebSocket
wscat -c wss://api-calls.harx.ai/audio-stream

# Devrait se connecter et recevoir :
# {"version":"1.0.0","event":"connected"}
```

### 5. ⚠️ Problème avec la conversion G.711
**Peut-être que la conversion A-Law → u-Law cause des problèmes.**

**Test :** Essayer sans conversion pour voir si cela change quelque chose (mais cela ne devrait pas être le problème car les packets sont bien reçus, juste très peu).

## Logs à vérifier

Dans les logs backend, chercher :

1. **`📊 Packet media #X`** : Pour voir combien de packets sont reçus au total
2. **`🎧 Audio inbound reçu`** : Pour voir combien de packets inbound sont envoyés au frontend
3. **`🎤 Audio outbound reçu`** : Pour voir combien de packets outbound sont reçus (votre voix)
4. **`📊 Résumé stream`** : Pour voir les statistiques finales

## Questions importantes

1. **L'interlocuteur parle-t-il pendant l'appel ?**
   - Si NON → C'est normal que vous ne receviez pas de packets
   - Si OUI → Il y a un problème avec le stream

2. **Combien de packets outbound sont reçus ?**
   - Si beaucoup de packets outbound mais peu d'inbound → Le problème est avec l'audio inbound
   - Si peu de packets outbound aussi → Le problème est avec le stream en général

3. **Le résumé apparaît-il dans les logs ?**
   - Si NON → Le code n'a pas été déployé ou il y a un problème
   - Si OUI → Vérifier les statistiques pour voir combien de packets sont reçus

## Solutions à essayer

### Solution 1 : Tester avec `inbound_track` seulement

Modifier `server.js` ligne 246 :
```javascript
stream_track: 'inbound_track', // Au lieu de 'both_tracks'
```

**Note :** Cela désactivera l'envoi de votre voix vers Telnyx, mais permettra de tester si le problème vient de `both_tracks`.

### Solution 2 : Vérifier que l'interlocuteur parle

Demander à l'interlocuteur de parler continuellement pendant 10 secondes et vérifier les logs backend pour voir combien de packets sont reçus.

### Solution 3 : Vérifier la configuration Telnyx Portal

Suivre les instructions dans `TELNYX_CONFIGURATION_FIX.md` pour vérifier la configuration Telnyx Portal.

### Solution 4 : Tester avec un autre numéro

Tester avec un autre numéro pour voir si le problème est spécifique à un numéro.

## Prochaines étapes

1. **Redémarrer le backend** avec les nouveaux logs
2. **Faire un nouvel appel** avec un interlocuteur qui parle continuellement
3. **Vérifier les logs backend** pour voir :
   - Combien de packets inbound sont reçus
   - Combien de packets outbound sont reçus
   - Le résumé final avec les statistiques
4. **Partager les logs** pour diagnostic plus approfondi


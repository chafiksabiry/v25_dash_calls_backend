# 🔧 Corrections à apporter dans Telnyx Portal

## Problèmes identifiés dans la configuration actuelle

### 1. ⚠️ Ordre des Codecs (CRITIQUE)
**Problème actuel :**
- G722 est en premier dans la liste
- G711A (PCMA) est en deuxième position
- G711U (PCMU) est en troisième position

**Solution :**
1. Aller dans **Inbound** → **Codecs**
2. **Réorganiser** les codecs pour mettre **G711A en PREMIER** :
   - Glisser-déposer G711A en haut de la liste
   - Ordre recommandé :
     1. **G711A** (PCMA - A-Law) ← PRIORITÉ
     2. **G711U** (PCMU - u-Law)
     3. G722
     4. VP8
     5. H.264

**Pourquoi :** Telnyx négocie les codecs dans l'ordre de la liste. Si G722 est en premier, il peut être sélectionné au lieu de G711A, ce qui cause des problèmes de compatibilité avec notre conversion G.711.

---

### 2. ⚠️ HD Voice désactivé
**Problème actuel :**
- HD Voice est **désactivé** sur les numéros

**Solution :**
1. Aller dans **Numbers** → Sélectionner le numéro
2. Activer **HD Voice** si disponible

**Note :** HD Voice améliore la qualité audio mais n'est pas obligatoire pour le fonctionnement de base.

---

### 3. ✅ Configuration actuelle correcte
- **Webhook URL** : `https://api-calls.harx.ai/webhook` ✅
- **API Version** : v2 ✅
- **Codecs G711A et G711U** : Activés ✅

---

## 🧪 Test après modifications

Après avoir réorganisé les codecs :

1. **Redémarrer le serveur backend**
2. **Faire un nouvel appel**
3. **Vérifier les logs** :
   - Vous devriez voir : `"encoding": "PCMA"` dans le message `start`
   - Vous devriez recevoir plus de packets audio (pas seulement 1)

---

## 📋 Checklist de vérification

- [ ] G711A est en **première position** dans la liste des codecs
- [ ] G711U est en **deuxième position**
- [ ] HD Voice activé (optionnel mais recommandé)
- [ ] Webhook URL correcte : `https://api-calls.harx.ai/webhook`
- [ ] API Version : v2

---

---

## 4. ⚠️ Configuration Outbound

**Configuration actuelle :**
- **Outbound Voice Profile** : "Default" ✅
- **Outbound Channel Limit** : "3" ⚠️

**Analyse :**

### Outbound Voice Profile : "Default"
✅ **C'est correct** - Le profil "Default" devrait fonctionner pour la plupart des cas. Si vous avez besoin de paramètres spécifiques (codecs, qualité audio, etc.), vous pouvez créer un profil personnalisé, mais "Default" est suffisant pour commencer.

### Outbound Channel Limit : "3"
⚠️ **Attention** - Cette limite de 3 canaux signifie que vous ne pouvez faire que **3 appels simultanés maximum**. 

**Recommandations :**
- Si vous avez besoin de faire plus d'appels simultanés, augmentez cette limite
- Pour un usage de test/développement, 3 est suffisant
- Pour la production, considérez une limite plus élevée selon vos besoins

**Note importante :** Cette limite ne devrait **PAS** affecter la qualité audio ou le fonctionnement d'un appel unique. Elle limite seulement le nombre d'appels simultanés.

---

---

## 5. ⚠️ Enregistrement automatique (CAUSE DES DOUBLONS)

**Problème actuel :**
- Telnyx crée **2 enregistrements** pour chaque appel
- Un enregistrement automatique (configuré dans Telnyx Portal)
- Un enregistrement manuel (démarré par notre code)

**Solution étape par étape :**

1. **Vous êtes déjà sur la bonne page** : "Number settings" pour `+33 4 23 34 07 75`

2. **Cliquer sur l'onglet "Voice"** (à côté de "Settings" en haut de la page)

3. **Dans l'onglet "Voice", chercher :**
   - Une section **"Inbound Call Recording"** ou **"Call Recording"**
   - OU une option **"Record Calls"** ou **"Enable Recording"**
   - OU une section **"Recording Settings"**

4. **Désactiver l'enregistrement automatique** :
   - Mettre sur **"Disabled"** ou **"Off"**
   - OU décocher la case si c'est une checkbox

5. **Sauvegarder les modifications** (bouton "Save" ou "Update" en bas de la page)

**Alternative si l'option n'est pas dans "Voice" :**
- Aller dans l'onglet **"Settings"** → Chercher dans **"Advanced settings"** ou **"Call Settings"**
- OU aller dans **Voice API Applications** → **Edit Application** → **Inbound** → Chercher les options d'enregistrement

**Pourquoi :** Notre code démarre déjà l'enregistrement manuellement via `record_start` quand l'appel est répondu. Si Telnyx démarre aussi automatiquement l'enregistrement, cela crée des doublons.

**Note :** Si vous ne trouvez pas l'option d'enregistrement au niveau du numéro, elle pourrait être configurée au niveau de l'application Voice API. Dans ce cas :
- Aller dans **Voice** → **Programmable Voice** → **Edit Application** → **Inbound** → Chercher les options d'enregistrement

---

## 🔍 Diagnostic si le problème persiste

Si après ces modifications vous ne recevez toujours qu'un seul packet audio :

1. **Vérifier que l'interlocuteur parle** : Telnyx n'envoie des packets que s'il y a de l'audio
2. **Vérifier les logs backend** : Chercher `"encoding"` dans le message `start` pour voir quel codec est négocié
3. **Tester avec un autre numéro** : Pour vérifier si c'est spécifique à un numéro
4. **Vérifier la limite de canaux** : Si vous avez plusieurs appels simultanés, vérifiez que vous n'avez pas atteint la limite de 3
5. **Vérifier l'enregistrement automatique** : Si vous voyez toujours 2 enregistrements, vérifiez que l'enregistrement automatique est bien désactivé dans Telnyx Portal


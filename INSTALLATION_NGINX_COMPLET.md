# 🚀 Installation Configuration Nginx Complète

Ce guide explique comment intégrer la configuration Socket.IO pour `api-calls.harx.ai` dans votre nginx existant.

## 📁 Fichiers Disponibles

J'ai créé **2 versions** de la configuration :

### 1. **`nginx-complete-config.conf`** - Sans SSL (HTTP sur port 8080)
- Pour développement ou si SSL géré ailleurs
- Deux serveurs : `v25.harx.ai` (apps existantes) + `api-calls.harx.ai` (backend appels)
- Port 8080 pour les deux

### 2. **`nginx-complete-config-ssl.conf`** - Avec SSL (HTTPS) ✅ RECOMMANDÉ
- Pour production
- SSL sur port 443
- Redirection HTTP → HTTPS
- Les deux serveurs avec certificats SSL

---

## 🎯 Quelle Version Choisir ?

### Utilisez **nginx-complete-config-ssl.conf** si :
- ✅ Vous êtes en production
- ✅ Vous avez des certificats SSL (Let's Encrypt)
- ✅ Vous voulez `https://` pour les deux domaines

### Utilisez **nginx-complete-config.conf** si :
- ⚠️ SSL est géré par un autre système (CDN, load balancer)
- ⚠️ Vous testez en développement

---

## 📝 INSTALLATION - Étapes Exactes

### Étape 1 : Connexion au serveur

```bash
ssh votre-user@votre-serveur.com
```

### Étape 2 : Localiser votre fichier nginx actuel

```bash
# Trouver où est votre config nginx
sudo nginx -t

# Généralement c'est :
# /etc/nginx/nginx.conf
# Ou dans : /etc/nginx/sites-available/
```

### Étape 3 : Backup de la config actuelle

```bash
# Si config dans nginx.conf
sudo cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.backup-$(date +%Y%m%d-%H%M%S)

# Si config dans sites-available
sudo cp /etc/nginx/sites-available/default /etc/nginx/sites-available/default.backup-$(date +%Y%m%d-%H%M%S)
```

### Étape 4 : Identifier le nom de votre conteneur backend

**IMPORTANT** : Vous devez connaître le nom exact du conteneur Docker qui contient votre backend d'appels.

```bash
# Lister les conteneurs
docker ps

# Chercher le conteneur du backend d'appels (port 5006)
docker ps | grep 5006
```

Notez le nom, par exemple : `v25-dash-calls-backend` ou `harx-calls-backend`

### Étape 5 : Éditer le fichier de configuration

**Option A : Vous avez un fichier nginx.conf principal**

```bash
sudo nano /etc/nginx/nginx.conf
```

**Option B : Vous utilisez sites-available**

```bash
sudo nano /etc/nginx/sites-available/default
```

### Étape 6 : Remplacer la configuration

1. **Supprimez tout le contenu actuel** (`Ctrl + K` plusieurs fois dans nano)

2. **Copiez tout le contenu** du fichier approprié :
   - `nginx-complete-config-ssl.conf` (recommandé pour production)
   - OU `nginx-complete-config.conf` (sans SSL)

3. **Collez** dans nano (clic droit)

4. **IMPORTANT : Ajustez le nom du conteneur backend**
   
   Cherchez dans le fichier toutes les lignes avec :
   ```nginx
   proxy_pass http://v25-dash-calls-backend:5006;
   ```
   
   Remplacez `v25-dash-calls-backend` par le **nom réel** de votre conteneur.
   
   Si votre backend n'est PAS dans Docker, utilisez :
   ```nginx
   proxy_pass http://localhost:5006;
   ```

5. **Si vous utilisez la version SSL** : Vérifiez les chemins des certificats
   
   Ligne ~37 et ~238 :
   ```nginx
   ssl_certificate /etc/letsencrypt/live/v25.harx.ai/fullchain.pem;
   ssl_certificate_key /etc/letsencrypt/live/v25.harx.ai/privkey.pem;
   ```
   
   Vérifiez que ces fichiers existent :
   ```bash
   sudo ls -l /etc/letsencrypt/live/v25.harx.ai/
   sudo ls -l /etc/letsencrypt/live/api-calls.harx.ai/
   ```

6. **Sauvegardez** : `Ctrl + O` puis `Enter`

7. **Quittez** : `Ctrl + X`

### Étape 7 : Tester la configuration

```bash
sudo nginx -t
```

**Résultat attendu :**
```
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
```

**Si erreur** → Voir section Dépannage ci-dessous

### Étape 8 : Recharger nginx

```bash
# Reload (sans couper les connexions)
sudo systemctl reload nginx

# Si reload ne fonctionne pas, restart
sudo systemctl restart nginx
```

### Étape 9 : Vérifier le statut

```bash
sudo systemctl status nginx
```

Vous devriez voir : `Active: active (running)`

---

## ✅ VÉRIFICATIONS

### Test 1 : API Health Check

```bash
# Version HTTP (si pas SSL)
curl http://api-calls.harx.ai:8080/api/health

# Version HTTPS (si SSL)
curl https://api-calls.harx.ai/api/health
```

**Réponse attendue :**
```json
{
  "status": "OK",
  "message": "Serveur Telnyx opérationnel",
  "configuration": { ... }
}
```

### Test 2 : WebSocket depuis votre PC

Ouvrez la console navigateur (F12) sur votre site frontend et testez :

```javascript
// Avec SSL
const socket = io('https://api-calls.harx.ai', {
  transports: ['websocket'],
  reconnection: true
});

// Sans SSL
const socket = io('http://api-calls.harx.ai:8080', {
  transports: ['websocket'],
  reconnection: true
});

socket.on('connect', () => {
  console.log('✅ Socket.IO connecté!', socket.id);
});

socket.on('connect_error', (err) => {
  console.error('❌ Erreur:', err.message);
});
```

**Résultat attendu :**
```
✅ Socket.IO connecté! abc123xyz
```

### Test 3 : Logs nginx

```bash
# Voir les connexions en temps réel
sudo tail -f /var/log/nginx/api-calls.harx.ai.access.log

# Vous devriez voir quand vous vous connectez :
# GET /socket.io/?EIO=4&transport=websocket HTTP/1.1" 101
```

Le code `101` = WebSocket upgrade réussi ✅

### Test 4 : Backend reçoit les connexions

```bash
# Logs du conteneur backend
docker logs -f nom-de-votre-conteneur-backend

# Vous devriez voir :
# Client connecté: abc123xyz
```

---

## 🐛 DÉPANNAGE

### Erreur : "nginx: [emerg] duplicate location"

**Cause** : Votre config avait déjà un bloc avec ce nom

**Solution** : Vous avez probablement dupliqué du contenu. Recommencez l'étape 6 en vous assurant de TOUT supprimer avant de coller.

### Erreur : "502 Bad Gateway"

**Cause** : Nginx ne peut pas joindre le backend

**Solutions** :

1. Vérifier que le backend tourne :
   ```bash
   docker ps | grep calls
   ```

2. Tester le backend directement :
   ```bash
   curl http://localhost:5006/api/health
   ```

3. Vérifier le nom du conteneur dans la config nginx :
   ```bash
   docker ps --format "table {{.Names}}\t{{.Ports}}"
   ```
   
   Puis ajustez `proxy_pass` dans nginx.

4. Si backend pas dans Docker réseau, utilisez :
   ```nginx
   proxy_pass http://host.docker.internal:5006;
   ```
   
   Ou trouvez l'IP :
   ```bash
   docker inspect nom-conteneur | grep IPAddress
   # Puis utilisez : proxy_pass http://172.17.0.X:5006;
   ```

### Erreur : "nginx: [emerg] cannot load certificate"

**Cause** : Certificat SSL manquant

**Solutions** :

1. Vérifier que les certificats existent :
   ```bash
   sudo ls -l /etc/letsencrypt/live/api-calls.harx.ai/
   ```

2. Si pas de certificat, créez-le :
   ```bash
   sudo apt install certbot python3-certbot-nginx
   sudo certbot --nginx -d api-calls.harx.ai
   sudo certbot --nginx -d v25.harx.ai
   ```

3. Ou utilisez la version sans SSL (`nginx-complete-config.conf`)

### Erreur : WebSocket se connecte puis timeout

**Cause** : Timeouts trop courts ou buffering activé

**Solution** : Vérifiez dans votre config nginx (section `/socket.io/`) :

```nginx
location /socket.io/ {
    proxy_read_timeout 86400s;  # ← Doit être très long
    proxy_send_timeout 86400s;  # ← Doit être très long
    proxy_buffering off;        # ← Doit être off
}
```

### Erreur : "Address already in use"

**Cause** : Le port est déjà utilisé

**Solutions** :

1. Voir ce qui utilise le port :
   ```bash
   sudo netstat -tulpn | grep :80
   sudo netstat -tulpn | grep :443
   ```

2. Si un autre nginx tourne, arrêtez-le :
   ```bash
   sudo systemctl stop nginx
   sudo systemctl start nginx
   ```

---

## 🔄 ROLLBACK (Restaurer l'ancienne config)

Si vous avez des problèmes :

```bash
# Restaurer le backup
sudo cp /etc/nginx/nginx.conf.backup-YYYYMMDD-HHMMSS /etc/nginx/nginx.conf

# Tester
sudo nginx -t

# Recharger
sudo systemctl reload nginx
```

---

## 📊 MONITORING

### Voir les connexions actives

```bash
# Connexions sur le port backend
sudo netstat -an | grep :5006

# Connexions nginx SSL
sudo netstat -an | grep :443 | grep ESTABLISHED | wc -l
```

### Logs en temps réel (3 terminaux)

**Terminal 1 - Nginx access :**
```bash
sudo tail -f /var/log/nginx/api-calls.harx.ai.access.log
```

**Terminal 2 - Nginx errors :**
```bash
sudo tail -f /var/log/nginx/error.log
```

**Terminal 3 - Backend :**
```bash
docker logs -f nom-conteneur-backend
```

---

## 🎯 POINTS CLÉS

### Ce qui a été ajouté pour Socket.IO

1. **Map pour WebSocket upgrade** (en haut du fichier) :
   ```nginx
   map $http_upgrade $connection_upgrade {
       default upgrade;
       '' close;
   }
   ```

2. **Nouveau bloc server pour `api-calls.harx.ai`**

3. **Location `/socket.io/` avec headers spéciaux** :
   ```nginx
   proxy_set_header Upgrade $http_upgrade;
   proxy_set_header Connection $connection_upgrade;
   proxy_read_timeout 86400s;
   proxy_buffering off;
   ```

Ces 3 éléments sont **ESSENTIELS** pour que Socket.IO fonctionne !

---

## ✅ CHECKLIST FINALE

- [ ] Backup de la config actuelle créé
- [ ] Nom du conteneur backend identifié
- [ ] Nouvelle config copiée
- [ ] Nom du conteneur ajusté dans la config
- [ ] (Si SSL) Certificats vérifiés
- [ ] `sudo nginx -t` → OK
- [ ] Nginx rechargé
- [ ] `curl /api/health` fonctionne
- [ ] WebSocket se connecte (test navigateur)
- [ ] Logs montrent code 101 pour WebSocket
- [ ] Backend reçoit les connexions
- [ ] Frontend se connecte avec succès

---

## 🎓 COMPRENDRE LA CONFIGURATION

### Pourquoi deux blocs server ?

Chaque domaine (`v25.harx.ai` et `api-calls.harx.ai`) a son propre bloc `server` dans nginx. Cela permet :
- Des logs séparés
- Des configurations différentes
- Des certificats SSL différents

### Pourquoi la map $http_upgrade ?

Socket.IO utilise WebSocket, qui commence par une requête HTTP puis "upgrade" vers WebSocket. La map permet à nginx de détecter cette upgrade et de gérer correctement la connexion.

### Pourquoi proxy_buffering off ?

Le buffering empêche les messages WebSocket de passer en temps réel. On le désactive pour avoir une communication instantanée.

---

## 📞 SUPPORT

Si après avoir suivi ce guide vous avez encore des problèmes :

1. **Collectez les infos** :
   ```bash
   # Logs nginx
   sudo tail -100 /var/log/nginx/error.log > nginx-error.log
   
   # Logs backend
   docker logs nom-conteneur > backend.log
   
   # Config active
   sudo nginx -T > nginx-full-config.txt
   ```

2. **Vérifiez le networking Docker** :
   ```bash
   docker network ls
   docker network inspect nom-du-reseau
   ```

3. **Test de connectivité** :
   ```bash
   # Depuis le serveur
   curl -v http://localhost:5006/api/health
   
   # Depuis l'extérieur
   curl -v https://api-calls.harx.ai/api/health
   ```

---

**Temps estimé** : 10-20 minutes
**Difficulté** : Moyenne
**Risque** : Faible (backup disponible)

Bonne chance ! 🚀


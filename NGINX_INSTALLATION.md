# 🚀 Installation Nginx pour api-calls.harx.ai

Ce guide vous aide à configurer nginx pour que Socket.IO et les WebSockets fonctionnent correctement.

## 📋 Prérequis

- Serveur Ubuntu/Debian avec accès SSH
- Nginx installé
- Certificat SSL (Let's Encrypt recommandé)
- Backend Docker qui tourne sur le port 5006

## 🔧 Installation Pas à Pas

### Étape 1 : Se connecter au serveur

```bash
ssh user@api-calls.harx.ai
```

### Étape 2 : Sauvegarder la configuration actuelle (IMPORTANT!)

```bash
# Créer un backup
sudo cp /etc/nginx/sites-available/api-calls.harx.ai /etc/nginx/sites-available/api-calls.harx.ai.backup-$(date +%Y%m%d)

# Lister les backups
ls -lh /etc/nginx/sites-available/*.backup*
```

### Étape 3 : Copier la nouvelle configuration

**Option A : Via SCP (depuis votre PC Windows)**

```powershell
# Sur votre PC Windows
scp E:\harx_prod_1\v25_dash_calls_backend\nginx-api-calls.conf user@api-calls.harx.ai:/tmp/
```

Puis sur le serveur :
```bash
sudo mv /tmp/nginx-api-calls.conf /etc/nginx/sites-available/api-calls.harx.ai
```

**Option B : Copier-coller manuel**

```bash
# Sur le serveur
sudo nano /etc/nginx/sites-available/api-calls.harx.ai
```

Copiez tout le contenu du fichier `nginx-api-calls.conf` et collez-le dans nano, puis :
- `Ctrl + O` pour sauvegarder
- `Ctrl + X` pour quitter

### Étape 4 : Vérifier les chemins SSL

Vérifiez que vos certificats SSL existent :

```bash
sudo ls -l /etc/letsencrypt/live/api-calls.harx.ai/
```

Vous devriez voir :
- `fullchain.pem`
- `privkey.pem`

**Si les certificats n'existent pas**, installez-les avec Let's Encrypt :

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d api-calls.harx.ai
```

### Étape 5 : Vérifier le nom du conteneur Docker

La configuration suppose que votre backend est accessible sur `localhost:5006`.

Vérifiez :

```bash
docker ps | grep calls-backend
curl http://localhost:5006/api/health
```

**Si le backend est dans Docker avec un nom de réseau différent**, modifiez la configuration :

```bash
sudo nano /etc/nginx/sites-available/api-calls.harx.ai
```

Remplacez toutes les occurrences de `http://localhost:5006` par :
- `http://nom-du-conteneur:5006` (si dans le même réseau Docker)
- ou `http://172.17.0.X:5006` (adresse IP du conteneur)

Pour trouver l'IP du conteneur :
```bash
docker inspect nom-du-conteneur | grep IPAddress
```

### Étape 6 : Tester la configuration nginx

```bash
sudo nginx -t
```

Vous devriez voir :
```
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
```

**Si vous avez des erreurs** :
- Vérifiez les chemins des certificats SSL
- Vérifiez que le fichier est bien dans `/etc/nginx/sites-available/`
- Vérifiez qu'il n'y a pas de caractères bizarres (copier-coller)

### Étape 7 : Activer le site (si pas déjà fait)

```bash
# Créer le lien symbolique
sudo ln -sf /etc/nginx/sites-available/api-calls.harx.ai /etc/nginx/sites-enabled/

# Vérifier que le lien existe
ls -l /etc/nginx/sites-enabled/ | grep api-calls
```

### Étape 8 : Recharger nginx

```bash
# Option 1 : Reload (sans couper les connexions)
sudo systemctl reload nginx

# Option 2 : Restart (si reload ne marche pas)
sudo systemctl restart nginx
```

### Étape 9 : Vérifier que nginx tourne

```bash
sudo systemctl status nginx
```

Vous devriez voir : `Active: active (running)`

## ✅ Tests de Validation

### Test 1 : Health Check API

```bash
curl https://api-calls.harx.ai/api/health
```

Réponse attendue :
```json
{
  "status": "OK",
  "message": "Serveur Telnyx opérationnel",
  "configuration": { ... }
}
```

### Test 2 : Connexion WebSocket

Sur votre PC, ouvrez la console du navigateur (F12) sur `https://copilot.harx.ai` et testez :

```javascript
// Test Socket.IO
const socket = io('https://api-calls.harx.ai', {
  transports: ['websocket'],
  reconnection: true
});

socket.on('connect', () => {
  console.log('✅ Socket.IO connecté!', socket.id);
});

socket.on('connect_error', (err) => {
  console.error('❌ Erreur connexion:', err.message);
});
```

**Résultat attendu** :
```
✅ Socket.IO connecté! abc123xyz
```

### Test 3 : Vérifier les logs backend

Sur le serveur :
```bash
# Si backend dans Docker
docker logs -f nom-du-conteneur-backend

# Vous devriez voir
Client connecté: abc123xyz
```

### Test 4 : Vérifier les logs nginx

```bash
sudo tail -f /var/log/nginx/api-calls.harx.ai.access.log
sudo tail -f /var/log/nginx/api-calls.harx.ai.error.log
```

Quand vous vous connectez, vous devriez voir dans `access.log` :
```
GET /socket.io/?EIO=4&transport=websocket HTTP/1.1" 101
```

Le code `101` signifie "Switching Protocols" = WebSocket upgrade réussi ✅

## 🐛 Dépannage

### Erreur : "502 Bad Gateway"

**Cause** : Nginx ne peut pas se connecter au backend

**Solutions** :
1. Vérifier que le backend tourne :
   ```bash
   docker ps | grep backend
   curl http://localhost:5006/api/health
   ```

2. Vérifier le firewall :
   ```bash
   sudo ufw status
   # Le port 5006 doit être ouvert pour localhost
   ```

3. Vérifier les logs Docker :
   ```bash
   docker logs nom-du-conteneur-backend
   ```

### Erreur : WebSocket still failing (code 1006)

**Cause** : Configuration nginx incorrecte ou backend pas redémarré

**Solutions** :
1. Vérifier que la configuration a bien `map $http_upgrade` AVANT le bloc `server`
2. Vérifier que les headers WebSocket sont bien présents :
   ```nginx
   proxy_set_header Upgrade $http_upgrade;
   proxy_set_header Connection $connection_upgrade;
   ```
3. Redémarrer nginx :
   ```bash
   sudo systemctl restart nginx
   ```

### Erreur : "SSL certificate problem"

**Cause** : Certificat SSL invalide ou expiré

**Solution** :
```bash
# Renouveler le certificat
sudo certbot renew --nginx

# Vérifier la date d'expiration
sudo certbot certificates
```

### Les connexions se ferment après 60 secondes

**Cause** : Timeouts trop courts

**Solution** : Vérifiez que votre configuration a bien :
```nginx
proxy_read_timeout 86400s;  # 24h
proxy_send_timeout 86400s;  # 24h
```

### Le backend ne reçoit pas les connexions WebSocket

**Cause** : Docker networking

**Solution** :
1. Trouver l'IP du conteneur :
   ```bash
   docker inspect nom-conteneur | grep IPAddress
   ```

2. Modifier nginx pour utiliser cette IP :
   ```nginx
   proxy_pass http://172.17.0.X:5006;
   ```

## 📊 Monitoring

### Voir les connexions WebSocket actives

```bash
# Connexions sur le port 5006
sudo netstat -an | grep :5006

# Connexions nginx
sudo netstat -an | grep :443 | grep ESTABLISHED | wc -l
```

### Logs en temps réel

```bash
# Terminal 1 : Logs nginx
sudo tail -f /var/log/nginx/api-calls.harx.ai.access.log

# Terminal 2 : Logs backend
docker logs -f nom-conteneur-backend

# Terminal 3 : Erreurs nginx
sudo tail -f /var/log/nginx/error.log
```

## 🔄 Rollback en cas de problème

Si la nouvelle configuration cause des problèmes :

```bash
# Restaurer le backup
sudo cp /etc/nginx/sites-available/api-calls.harx.ai.backup-YYYYMMDD /etc/nginx/sites-available/api-calls.harx.ai

# Tester
sudo nginx -t

# Recharger
sudo systemctl reload nginx
```

## ✅ Checklist Finale

- [ ] Configuration nginx copiée
- [ ] Certificats SSL vérifiés
- [ ] Backend accessible sur localhost:5006
- [ ] `sudo nginx -t` OK
- [ ] Nginx rechargé
- [ ] API health check fonctionne
- [ ] WebSocket se connecte (code 101 dans logs)
- [ ] Backend reçoit les connexions
- [ ] Frontend se connecte avec succès

## 📞 Support

Si vous avez encore des problèmes après avoir suivi ce guide :

1. Vérifiez les logs :
   - Nginx access : `/var/log/nginx/api-calls.harx.ai.access.log`
   - Nginx error : `/var/log/nginx/error.log`
   - Backend : `docker logs nom-conteneur`

2. Testez la connectivité :
   ```bash
   # Depuis le serveur
   curl -I http://localhost:5006/api/health
   
   # WebSocket test
   wscat -c ws://localhost:5006/socket.io/
   ```

3. Vérifiez la configuration :
   ```bash
   sudo nginx -T | grep -A 20 "server_name api-calls.harx.ai"
   ```


# 🚀 Guide Rapide - Corriger WebSocket en Production

## 🎯 Problème

Le frontend essaie de se connecter à `wss://api-calls.harx.ai/socket.io/` mais échoue car **nginx n'est pas configuré pour les WebSocket**.

## ✅ Solution en 3 étapes

### 1️⃣ Connectez-vous à votre serveur

```bash
ssh votre-user@api-calls.harx.ai
```

### 2️⃣ Installez la configuration nginx

```bash
# Backup de la config actuelle
sudo cp /etc/nginx/sites-available/api-calls.harx.ai /etc/nginx/sites-available/api-calls.harx.ai.backup

# Créez le nouveau fichier
sudo nano /etc/nginx/sites-available/api-calls.harx.ai
```

Copiez TOUT le contenu du fichier `nginx-api-calls.conf` dans nano, puis :
- `Ctrl + O` → Sauvegarder
- `Ctrl + X` → Quitter

### 3️⃣ Appliquez la configuration

```bash
# Vérifier la syntaxe
sudo nginx -t

# Si OK, recharger nginx
sudo systemctl reload nginx
```

## ✅ Vérification

### Sur votre PC (console navigateur)

```javascript
// Test rapide
const socket = io('https://v25dashcallsbackend-production.up.railway.app');
socket.on('connect', () => console.log('✅ CONNECTÉ!', socket.id));
socket.on('connect_error', (err) => console.error('❌ ERREUR:', err));
```

**Résultat attendu :**
```
✅ CONNECTÉ! abc123xyz
```

### Sur le serveur

```bash
# Voir les logs nginx en temps réel
sudo tail -f /var/log/nginx/api-calls.harx.ai.access.log

# Vous devriez voir :
# GET /socket.io/?EIO=4&transport=websocket HTTP/1.1" 101
# Le code 101 = WebSocket upgrade réussi ✅
```

### Dans votre frontend

Après avoir rechargé nginx, rechargez votre page frontend. Vous devriez voir :

```
✅ WebSocket connecté: abc123
🟢 Serveur Connecté
Prêt pour les appels
```

## 🐛 Si ça ne marche toujours pas

### Problème 1 : "502 Bad Gateway"

Le backend n'est pas accessible. Vérifiez :

```bash
# Le backend tourne ?
docker ps | grep backend

# Le port 5006 répond ?
curl http://localhost:5006/api/health
```

**Si non**, vérifiez votre conteneur Docker :
```bash
docker logs nom-du-conteneur-backend
docker restart nom-du-conteneur-backend
```

### Problème 2 : WebSocket timeout ou fermeture immédiate

Nginx n'a pas les bons timeouts. Vérifiez dans votre config nginx que vous avez bien :

```nginx
location /socket.io/ {
    proxy_pass http://localhost:5006;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    
    proxy_read_timeout 86400s;  # ← IMPORTANT
    proxy_send_timeout 86400s;  # ← IMPORTANT
    proxy_buffering off;        # ← IMPORTANT
}
```

### Problème 3 : SSL certificate error

```bash
# Vérifier les certificats
sudo ls -l /etc/letsencrypt/live/api-calls.harx.ai/

# Si pas de certificat, en créer un
sudo certbot --nginx -d api-calls.harx.ai
```

## 📋 Checklist Finale

- [ ] Backend Docker tourne (port 5006)
- [ ] `curl http://localhost:5006/api/health` fonctionne
- [ ] Configuration nginx copiée
- [ ] `sudo nginx -t` → OK
- [ ] `sudo systemctl reload nginx` → OK
- [ ] Frontend `.env` a `REACT_APP_API_URL=https://v25dashcallsbackend-production.up.railway.app`
- [ ] Console frontend montre : `✅ WebSocket connecté`
- [ ] Logs nginx montrent : `HTTP/1.1" 101`

## 🎯 Points Clés de la Configuration

La partie CRUCIALE pour Socket.IO est :

```nginx
# En haut du fichier (AVANT server {})
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

server {
    # ...
    
    location /socket.io/ {
        proxy_pass http://localhost:5006;
        proxy_http_version 1.1;
        
        # CES DEUX LIGNES SONT ESSENTIELLES !!!
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        
        # Timeouts longs pour WebSocket
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        proxy_buffering off;
    }
}
```

Sans ces headers `Upgrade` et `Connection`, le WebSocket ne peut PAS fonctionner !

## 📞 Besoin d'aide ?

1. **Vérifiez les logs** :
   ```bash
   sudo tail -100 /var/log/nginx/error.log
   sudo tail -100 /var/log/nginx/api-calls.harx.ai.access.log
   docker logs --tail 100 nom-conteneur-backend
   ```

2. **Testez le backend directement** :
   ```bash
   curl -v http://localhost:5006/api/health
   ```

3. **Vérifiez la config nginx active** :
   ```bash
   sudo nginx -T | grep -A 30 "location /socket.io"
   ```

## 📚 Guides Complets

- **Installation détaillée** : Voir `NGINX_INSTALLATION.md`
- **Diagnostic WebSocket** : Voir `WEBSOCKET_DIAGNOSTIC.md` (dans le dossier parent)
- **Développement local** : Voir `START_LOCAL_DEVELOPMENT.md` (dans le dossier parent)

---

**Temps estimé** : 5-10 minutes si tout se passe bien
**Difficulté** : Facile (copier-coller de configuration)
**Risque** : Faible (vous avez un backup de la config originale)


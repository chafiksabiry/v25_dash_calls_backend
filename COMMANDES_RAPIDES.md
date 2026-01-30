# ⚡ COMMANDES RAPIDES - Installation Nginx

## 🎯 Installation en 5 minutes

### 📋 Prérequis
- Accès SSH au serveur
- Backend Docker qui tourne sur port 5006

---

## 🚀 COMMANDES À COPIER-COLLER

### 1️⃣ SSH vers le serveur

```bash
ssh votre-user@votre-serveur.com
```

---

### 2️⃣ Trouver le nom du conteneur backend

```bash
docker ps | grep 5006
```

**Notez le nom** (ex: `v25-dash-calls-backend`)

---

### 3️⃣ Backup + Édition

```bash
# Backup
sudo cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.backup-$(date +%Y%m%d-%H%M%S)

# Éditer
sudo nano /etc/nginx/nginx.conf
```

---

### 4️⃣ Dans nano

1. **Supprimez tout** (`Ctrl + K` plusieurs fois)
2. **Copiez TOUT** le fichier `nginx-complete-config-ssl.conf`
3. **Collez** (clic droit)
4. **Cherchez** toutes les lignes avec `v25-dash-calls-backend` et remplacez par votre nom de conteneur
5. **Sauvegardez** : `Ctrl + O` puis `Enter`
6. **Quittez** : `Ctrl + X`

---

### 5️⃣ Tester et appliquer

```bash
# Test
sudo nginx -t

# Si OK, recharger
sudo systemctl reload nginx

# Vérifier
sudo systemctl status nginx
```

---

### 6️⃣ Tester l'API

```bash
curl https://v25dashcallsbackend-production.up.railway.app/api/health
```

**Attendu** : `{"status":"OK",...}`

---

## ✅ Test Frontend

**Console navigateur (F12) :**

```javascript
const socket = io('https://v25dashcallsbackend-production.up.railway.app');
socket.on('connect', () => console.log('✅ FONCTIONNE !', socket.id));
socket.on('connect_error', (err) => console.error('❌ ERREUR:', err));
```

**Résultat attendu :**
```
✅ FONCTIONNE ! abc123xyz
```

---

## 🐛 Si Problème : 502 Bad Gateway

```bash
# Le backend tourne ?
docker ps | grep calls

# Le port répond ?
curl http://localhost:5006/api/health

# Si non, démarrer le backend
docker start nom-du-conteneur

# Ou rebuild
docker-compose up -d nom-du-conteneur
```

---

## 🐛 Si Problème : Certificate Error

```bash
# Installer le certificat SSL
sudo certbot --nginx -d api-calls.harx.ai

# Puis recharger nginx
sudo systemctl reload nginx
```

---

## 🔄 Rollback (si besoin)

```bash
# Restaurer
sudo cp /etc/nginx/nginx.conf.backup-* /etc/nginx/nginx.conf

# Recharger
sudo systemctl reload nginx
```

---

## 📊 Voir les Logs

```bash
# Terminal 1 - Nginx
sudo tail -f /var/log/nginx/api-calls.harx.ai.access.log

# Terminal 2 - Backend
docker logs -f nom-du-conteneur
```

**Cherchez le code `101`** dans les logs nginx = WebSocket OK ✅

---

## ✅ Checklist

- [ ] Backend Docker tourne (port 5006)
- [ ] Nom du conteneur identifié
- [ ] Config nginx copiée et nom ajusté
- [ ] `sudo nginx -t` → OK
- [ ] Nginx rechargé
- [ ] API health check OK
- [ ] WebSocket connecté (code 101 dans logs)
- [ ] Frontend affiche "Serveur Connecté"

---

**C'est tout !** 🎉

**Plus de détails ?** → Voir `INSTALLATION_NGINX_COMPLET.md`


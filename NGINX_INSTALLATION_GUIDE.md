# Guide d'installation Nginx pour api-calls.harx.ai

## 📋 Prérequis

1. Nginx installé sur votre serveur
2. Certificats SSL pour `api-calls.harx.ai`
3. Connaître le nom du conteneur Docker backend (ou l'adresse IP/port)

## 🔍 Étape 1 : Trouver le nom du conteneur Docker backend

```bash
docker ps | grep calls-backend
```

Notez le nom exact du conteneur (exemple : `v25-dash-calls-backend`, `v25_dash_calls_backend`, etc.)

## 📝 Étape 2 : Modifier la configuration

1. Ouvrez le fichier `nginx-api-calls-harx-ai.conf`
2. Remplacez `v25-dash-calls-backend` par le **vrai nom** de votre conteneur Docker dans **toutes** les occurrences
3. Si le backend n'est pas dans Docker mais sur le même host, remplacez par `http://localhost:5006`
4. Mettez à jour les chemins des certificats SSL :
   ```nginx
   ssl_certificate /path/to/ssl/api-calls.harx.ai.crt;
   ssl_certificate_key /path/to/ssl/api-calls.harx.ai.key;
   ```

## 📂 Étape 3 : Installer la configuration

### Option A : Ajouter à nginx.conf principal

```bash
# Éditer le fichier nginx principal
sudo nano /etc/nginx/nginx.conf

# Ajouter le contenu de nginx-api-calls-harx-ai.conf dans le bloc http { }
```

### Option B : Créer un fichier séparé (recommandé)

```bash
# Copier le fichier vers sites-available
sudo cp nginx-api-calls-harx-ai.conf /etc/nginx/sites-available/api-calls.harx.ai

# Créer un lien symbolique vers sites-enabled
sudo ln -s /etc/nginx/sites-available/api-calls.harx.ai /etc/nginx/sites-enabled/

# OU si vous préférez copier directement
sudo cp nginx-api-calls-harx-ai.conf /etc/nginx/sites-enabled/api-calls.harx.ai
```

## ✅ Étape 4 : Tester et appliquer

```bash
# Tester la configuration
sudo nginx -t

# Si le test réussit, recharger nginx
sudo systemctl reload nginx

# OU redémarrer nginx
sudo systemctl restart nginx
```

## 🔍 Étape 5 : Vérifier que ça fonctionne

### Vérifier les logs nginx

```bash
# Logs d'erreur
sudo tail -f /var/log/nginx/error.log

# Logs d'accès
sudo tail -f /var/log/nginx/access.log
```

### Vérifier les logs backend

```bash
# Logs du conteneur Docker backend
docker logs -f v25-dash-calls-backend

# Vous devriez voir quand une connexion WebSocket arrive :
# 🔌 WebSocket upgrade request: { pathname: '/frontend-audio', ... }
# ✅ Upgrading to audio-stream WebSocket (path: /frontend-audio)
# 👤 Frontend client connected to audio stream
```

### Tester depuis le frontend

1. Ouvrez l'application frontend
2. Lancez un appel
3. Vérifiez la console du navigateur - vous devriez voir :
   ```
   ✅ Connected to audio stream
   🎤 Audio WebSocket connected
   ```
   Au lieu de :
   ```
   ❌ WebSocket connection to 'wss://api-calls.harx.ai/frontend-audio' failed
   ```

## 🐛 Dépannage

### Erreur : "upstream not found" ou "connection refused"

**Cause :** Le nom du conteneur Docker est incorrect ou le conteneur n'est pas accessible.

**Solution :**
1. Vérifiez le nom exact du conteneur : `docker ps`
2. Si le backend est sur le même host mais pas dans Docker : utilisez `http://localhost:5006`
3. Si dans un réseau Docker différent : utilisez l'adresse IP du conteneur ou le nom complet avec le réseau

### Erreur : "SSL certificate not found"

**Cause :** Les chemins des certificats SSL sont incorrects.

**Solution :**
1. Trouvez où sont vos certificats SSL
2. Mettez à jour les chemins dans la configuration nginx

### Les connexions WebSocket échouent toujours

**Vérifications :**
1. Le backend reçoit-il les requêtes ? Vérifiez les logs backend
2. Si non : nginx ne route pas correctement - vérifiez la configuration
3. Si oui : le problème est dans le backend, pas nginx

### Tester la connexion WebSocket directement

```bash
# Depuis le serveur, tester directement le backend (bypass nginx)
wscat -c ws://localhost:5006/frontend-audio

# Si ça fonctionne, le problème est nginx
# Si ça ne fonctionne pas, le problème est le backend
```

## 📌 Points importants

1. **Le bloc `/frontend-audio` est CRITIQUE** - c'est ce qui manquait et cause les erreurs
2. **proxy_buffering off** est essentiel pour les WebSocket en temps réel
3. **Les timeouts longs (86400)** permettent aux WebSocket de rester ouverts longtemps
4. **proxy_http_version 1.1** est requis pour les WebSocket (HTTP/1.0 ne les supporte pas)

## 🔄 Après modification

Après chaque modification de la configuration nginx :
1. Toujours tester avec `sudo nginx -t`
2. Recharger avec `sudo systemctl reload nginx`
3. Vérifier les logs pour s'assurer que tout fonctionne


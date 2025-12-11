# Configuration Nginx pour WebSocket via /api/

## Problème

Le frontend essaie de se connecter à `wss://api-calls.harx.ai/api/frontend-audio`, mais nginx ne transmet pas les headers WebSocket pour les requêtes qui passent par `/api/`.

## Solution

Nginx doit être configuré pour transmettre les headers WebSocket (`Upgrade` et `Connection`) pour les requêtes qui passent par `/api/`.

## Configuration requise

### Étape 1 : Ajouter le map pour les headers WebSocket

Au début de votre fichier nginx (dans le bloc `http { }`), ajoutez :

```nginx
http {
    # Map pour les headers WebSocket upgrade
    map $http_upgrade $connection_upgrade {
        default upgrade;
        '' close;
    }

    # ... reste de votre configuration
}
```

### Étape 2 : Modifier le bloc location /api/

Modifiez votre bloc `location /api/` existant pour inclure les headers WebSocket :

```nginx
location /api/ {
    # REMPLACEZ par votre backend (localhost:5006 ou nom du conteneur Docker)
    proxy_pass http://localhost:5006;
    
    # CRITIQUE : Version HTTP 1.1 requise pour WebSocket
    proxy_http_version 1.1;
    
    # CRITIQUE : Headers WebSocket
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    
    # Headers standards
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    
    # Timeouts pour WebSocket (24 heures)
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
    proxy_connect_timeout 60;
    
    # CRITIQUE : Désactiver le buffering pour WebSocket
    proxy_buffering off;
}
```

## Configuration complète exemple

Voici un exemple de configuration complète pour `api-calls.harx.ai` :

```nginx
http {
    # Map pour les headers WebSocket
    map $http_upgrade $connection_upgrade {
        default upgrade;
        '' close;
    }

    server {
        listen 443 ssl http2;
        server_name api-calls.harx.ai;

        # SSL configuration
        ssl_certificate /path/to/ssl/cert.pem;
        ssl_certificate_key /path/to/ssl/key.pem;

        # Route /api/ avec support WebSocket
        location /api/ {
            # REMPLACEZ par votre backend
            # Si Docker: http://v25-dash-calls-backend:5006
            # Si localhost: http://localhost:5006
            proxy_pass http://localhost:5006;
            
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            
            proxy_read_timeout 86400;
            proxy_send_timeout 86400;
            proxy_connect_timeout 60;
            proxy_buffering off;
        }
    }
}
```

## Points critiques

1. **`proxy_http_version 1.1`** : Requis pour WebSocket (HTTP/1.0 ne supporte pas)
2. **`proxy_set_header Upgrade $http_upgrade`** : Transmet le header Upgrade
3. **`proxy_set_header Connection $connection_upgrade`** : Utilise le map pour Connection
4. **`proxy_buffering off`** : Essentiel pour WebSocket en temps réel
5. **Timeouts longs** : Permettent aux WebSocket de rester ouverts

## Vérification

### 1. Tester la configuration nginx

```bash
sudo nginx -t
```

### 2. Recharger nginx

```bash
sudo systemctl reload nginx
```

### 3. Vérifier les logs backend

Après avoir rechargé nginx, testez une connexion WebSocket depuis le frontend. Vous devriez voir dans les logs backend :

```
🔌 WebSocket upgrade request: { pathname: '/api/frontend-audio', ... }
✅ Upgrading to audio-stream WebSocket (path: /api/frontend-audio)
👤 Frontend client connected to audio stream
```

### 4. Vérifier les logs nginx

```bash
sudo tail -f /var/log/nginx/error.log
sudo tail -f /var/log/nginx/access.log
```

## Si ça ne fonctionne toujours pas

### Vérifier que le map est bien défini

Le `map $http_upgrade $connection_upgrade` doit être dans le bloc `http { }`, pas dans `server { }`.

### Vérifier l'ordre des location blocks

Si vous avez plusieurs `location` blocks, l'ordre peut être important. Les blocks plus spécifiques doivent venir avant les plus généraux.

### Tester directement le backend

Pour vérifier que le backend fonctionne :

```bash
# Depuis le serveur
wscat -c ws://localhost:5006/api/frontend-audio
```

Si ça fonctionne directement mais pas via nginx, le problème est la configuration nginx.

## Alternative : Bloc location spécifique

Si vous préférez avoir un bloc séparé pour les WebSocket :

```nginx
# Bloc pour les routes API normales
location /api/ {
    proxy_pass http://localhost:5006;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    # ... autres headers
}

# Bloc spécifique pour WebSocket (doit venir AVANT /api/)
location ~ ^/api/(frontend-audio|call-events|audio-stream) {
    proxy_pass http://localhost:5006;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
    proxy_buffering off;
}
```

## Résumé

Le problème est que nginx route `/api/` vers le backend mais ne transmet pas les headers WebSocket. La solution est d'ajouter :
1. Le `map $http_upgrade $connection_upgrade` dans le bloc `http`
2. Les headers `Upgrade` et `Connection` dans le bloc `location /api/`
3. `proxy_buffering off` pour les WebSocket


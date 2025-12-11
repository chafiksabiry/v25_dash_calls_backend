# Configuration Nginx pour WebSockets - api-calls.harx.ai

## Problème actuel
Les WebSockets ne peuvent pas se connecter à `wss://api-calls.harx.ai` pour :
- `/call-events` - Parfois fonctionne, parfois échoue (code 1006)
- `/frontend-audio` - Échoue toujours

## Solution : Configuration Nginx requise

Le reverse proxy nginx doit être configuré pour transmettre correctement les connexions WebSocket.

### Configuration Nginx pour api-calls.harx.ai

Ajoutez/modifiez la configuration nginx dans `/etc/nginx/sites-available/api-calls.harx.ai` :

```nginx
server {
    listen 443 ssl http2;
    server_name api-calls.harx.ai;

    # SSL configuration
    ssl_certificate /path/to/ssl/cert.pem;
    ssl_certificate_key /path/to/ssl/key.pem;

    # WebSocket upgrade headers mapping
    map $http_upgrade $connection_upgrade {
        default upgrade;
        '' close;
    }

    # Backend API routes
    location /api/ {
        proxy_pass http://localhost:5006;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket specific timeouts
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }

    # WebSocket endpoint for call-events
    location /call-events {
        proxy_pass http://localhost:5006;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket specific timeouts (24 hours)
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
        proxy_connect_timeout 60;
        
        # Important: Disable buffering for WebSocket
        proxy_buffering off;
    }

    # WebSocket endpoint for audio-stream (Telnyx)
    location /audio-stream {
        proxy_pass http://localhost:5006;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket specific timeouts (24 hours)
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
        proxy_connect_timeout 60;
        
        # Important: Disable buffering for WebSocket
        proxy_buffering off;
    }

    # WebSocket endpoint for frontend-audio (Frontend clients)
    location /frontend-audio {
        proxy_pass http://localhost:5006;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket specific timeouts (24 hours)
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
        proxy_connect_timeout 60;
        
        # Important: Disable buffering for WebSocket
        proxy_buffering off;
    }
}
```

## Points critiques

1. **Headers Upgrade et Connection** : Essentiels pour que nginx transmette correctement les WebSockets
2. **proxy_http_version 1.1** : Requis pour les WebSockets (HTTP/1.0 ne supporte pas les WebSockets)
3. **Timeouts longs** : Les WebSockets peuvent rester ouverts longtemps, donc des timeouts de 24h sont recommandés
4. **proxy_buffering off** : Important pour les WebSockets en temps réel
5. **Port backend** : Vérifiez que le backend écoute sur le port 5006 (configuré dans `config/env.js`)

## Vérification après configuration

1. **Tester la configuration nginx** :
   ```bash
   sudo nginx -t
   ```

2. **Recharger nginx** :
   ```bash
   sudo systemctl reload nginx
   ```

3. **Vérifier les logs nginx** :
   ```bash
   sudo tail -f /var/log/nginx/error.log
   sudo tail -f /var/log/nginx/access.log
   ```

4. **Vérifier que le backend écoute** :
   ```bash
   sudo netstat -tlnp | grep 5006
   # ou
   sudo ss -tlnp | grep 5006
   ```

5. **Tester la connexion WebSocket** :
   - Ouvrir l'application frontend
   - Vérifier la console du navigateur
   - Vous devriez voir : `✅ Connected to call events WebSocket` et `✅ Connected to audio stream`

## Logs backend à vérifier

Après avoir appliqué la configuration nginx, vous devriez voir dans les logs du backend :
```
🔌 WebSocket upgrade request: { pathname: '/call-events', ... }
✅ Upgrading to call-events WebSocket
👋 New client connected to call events WebSocket
✅ Welcome message sent to client

🔌 WebSocket upgrade request: { pathname: '/frontend-audio', ... }
✅ Upgrading to audio-stream WebSocket (path: /frontend-audio)
👤 Frontend client connected to audio stream
```

## État actuel

✅ **Fonctionnel :**
- Appel Telnyx initié avec succès
- Appel répondu (`call.answered`)
- Streaming Telnyx démarré (`streaming.started`)
- WebSocket call-events se connecte parfois

❌ **Problèmes restants :**
- WebSocket `/frontend-audio` ne se connecte pas (nécessite configuration nginx)
- WebSocket `/call-events` échoue parfois (code 1006) - nécessite configuration nginx

## Note importante

Le backend est maintenant configuré pour accepter les deux chemins :
- `/audio-stream` - pour Telnyx
- `/frontend-audio` - pour le frontend

Les deux utilisent le même handler WebSocket, donc la configuration nginx doit permettre les deux chemins.


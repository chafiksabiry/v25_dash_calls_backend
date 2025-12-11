# 🔴 Problème Critique : WebSocket /frontend-audio n'atteint pas le backend

## 📊 Analyse des Logs Backend

### ✅ Ce qui fonctionne :
1. **`/call-events`** : Le frontend se connecte avec succès
2. **`/audio-stream`** : Telnyx se connecte avec succès (WebSocket audio de Telnyx vers backend)

### ❌ Ce qui ne fonctionne PAS :
1. **`/frontend-audio`** : **AUCUNE requête n'atteint le backend**
   - Le frontend essaie de se connecter à `wss://api-calls.harx.ai/frontend-audio`
   - Aucun log `🔌 WebSocket upgrade request` pour `/frontend-audio` dans les logs backend
   - Cela signifie que **nginx bloque/ferme la connexion avant qu'elle n'atteigne le backend**

## 🔍 Diagnostic

### Logs Backend observés :
```
✅ /call-events fonctionne :
🔌 WebSocket upgrade request: { pathname: '/call-events', ... }
✅ Upgrading to call-events WebSocket
👋 New client connected to call events WebSocket

✅ /audio-stream fonctionne (Telnyx) :
🔌 WebSocket upgrade request: { pathname: '/audio-stream', ... }
✅ Upgrading to audio-stream WebSocket
🎧 Telnyx audio stream connected

❌ /frontend-audio N'APPARAÎT JAMAIS dans les logs
```

### Conclusion :
Nginx a probablement des blocs `location` spécifiques pour `/call-events` et `/audio-stream` qui transmettent les headers WebSocket, mais **pas pour `/frontend-audio`**.

## ✅ Solution Requise

### Option 1 : Ajouter un bloc location pour `/frontend-audio` (RECOMMANDÉ)

Ajoutez ce bloc dans votre configuration nginx pour `api-calls.harx.ai` :

```nginx
location /frontend-audio {
    proxy_pass http://localhost:5006;  # ou votre conteneur Docker
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
    proxy_connect_timeout 60;
    proxy_buffering off;
}
```

### Option 2 : Modifier le bloc `/api/` pour transmettre les headers WebSocket

Si vous préférez utiliser `/api/frontend-audio`, modifiez votre bloc `location /api/` :

```nginx
location /api/ {
    proxy_pass http://localhost:5006;
    proxy_http_version 1.1;
    
    # CRITIQUE : Headers WebSocket
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
    proxy_buffering off;
}
```

Et ajoutez le map dans le bloc `http { }` :

```nginx
http {
    map $http_upgrade $connection_upgrade {
        default upgrade;
        '' close;
    }
    # ... reste de votre config
}
```

## 🎯 Pourquoi `/call-events` fonctionne mais pas `/frontend-audio` ?

Probablement parce que votre configuration nginx a un bloc spécifique pour `/call-events` :

```nginx
location /call-events {
    # Configuration WebSocket complète
    proxy_pass http://localhost:5006;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    # ... etc
}
```

Mais pas pour `/frontend-audio`. Il faut ajouter le même type de bloc.

## 📝 Vérification après configuration

1. **Tester nginx** :
   ```bash
   sudo nginx -t
   ```

2. **Recharger nginx** :
   ```bash
   sudo systemctl reload nginx
   ```

3. **Vérifier les logs backend** :
   Après avoir testé une connexion, vous devriez voir :
   ```
   🔌 WebSocket upgrade request: { pathname: '/frontend-audio', ... }
   ✅ Upgrading to audio-stream WebSocket (path: /frontend-audio)
   👤 Frontend client connected to audio stream
   ```

4. **Si vous ne voyez toujours pas ces logs** : nginx bloque toujours les connexions. Vérifiez :
   - Que le bloc `location /frontend-audio` est bien dans le bon `server { }`
   - Que nginx a bien été rechargé
   - Les logs d'erreur nginx : `sudo tail -f /var/log/nginx/error.log`

## 🔧 Autres problèmes identifiés

### Erreur 422 sur suppression_start (non-critique)
L'erreur 422 sur `suppression_start` est maintenant mieux gérée et n'empêche pas l'appel de continuer. C'est normal si la suppression de bruit n'est pas disponible pour ce type d'appel.

### Broadcasting to 0 clients
C'est normal - le backend essaie de diffuser l'audio mais aucun client frontend n'est connecté (car `/frontend-audio` ne fonctionne pas). Une fois que `/frontend-audio` fonctionnera, vous verrez des clients connectés.


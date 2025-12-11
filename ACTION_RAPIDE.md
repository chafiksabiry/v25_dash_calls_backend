# 🚨 ACTION RAPIDE - Résoudre l'erreur WebSocket

## ❌ Problème actuel
```
WebSocket connection to 'wss://api-calls.harx.ai/frontend-audio' failed
❌ Erreur outbound WebSocket micro
```

## ✅ Solution en 5 étapes

### Étape 1 : Trouver le nom du service Docker backend
```bash
docker ps | grep calls-backend
```
Notez le nom (exemple : `v25-dash-calls-backend` ou `v25_dash_calls_backend`)

### Étape 2 : Ouvrir le fichier nginx.conf
```bash
sudo nano /etc/nginx/nginx.conf
# ou
sudo nano /etc/nginx/conf.d/default.conf
```

### Étape 3 : Trouver la ligne exacte
Cherchez cette ligne dans votre fichier :
```nginx
    }  ← Cette ligne ferme le bloc server pour v25.harx.ai
```

### Étape 4 : Ajouter le nouveau bloc APRÈS cette ligne

Copiez tout le contenu du fichier `nginx-api-calls-to-add.conf` (lignes 28-111) et collez-le APRÈS la ligne `}` qui ferme votre bloc server pour `v25.harx.ai`.

**Important :** Remplacez `v25-dash-calls-backend` par le VRAI nom trouvé à l'étape 1 dans TOUTES les occurrences (lignes 38, 53, 70, 87, 104).

### Étape 5 : Tester et recharger
```bash
# Tester la configuration
sudo nginx -t

# Si OK (pas d'erreur), recharger
sudo systemctl reload nginx
```

## 🔍 Vérification

Après rechargement, testez à nouveau l'appel. Vous devriez voir dans la console :
```
✅ Connected to audio stream
🎤 Audio WebSocket connected
```

Au lieu de :
```
❌ WebSocket connection to 'wss://api-calls.harx.ai/frontend-audio' failed
```

## ⚠️ Si ça ne fonctionne toujours pas

1. Vérifier les logs nginx :
   ```bash
   sudo tail -f /var/log/nginx/error.log
   ```

2. Vérifier que le backend est accessible :
   ```bash
   docker ps | grep calls-backend
   # Vérifier que le conteneur est bien démarré
   ```

3. Vérifier le nom du service Docker :
   - Le nom doit être exactement celui retourné par `docker ps`
   - Si le backend est sur le même réseau Docker que nginx, utilisez le nom du service
   - Si nginx est sur l'hôte et le backend dans Docker, utilisez `localhost:5006` (si le port est exposé)



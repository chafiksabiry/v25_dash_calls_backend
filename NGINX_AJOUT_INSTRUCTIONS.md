# Instructions : Où ajouter la configuration nginx

## 📍 Emplacement exact dans votre fichier nginx.conf

Votre configuration actuelle ressemble à ceci :

```nginx
events {
    # ...
}

http {
    server {
        listen 8080;
        server_name v25.harx.ai;
        
        location /app1 {
            # ... config app1 ...
        }
        
        location /app2 {
            # ... config app2 ...
        }
        
        # ... autres locations ...
        
        location /app7 {
            # ... config app7 ...
        }
    }  ← AJOUTEZ LE NOUVEAU BLOC SERVER ICI (après cette ligne)
    
    # ============================================
    # COPIEZ TOUT LE CONTENU DE nginx-api-calls-to-add.conf
    # À PARTIR D'ICI :
    # ============================================
    
    server {
        listen 443 ssl http2;
        server_name api-calls.harx.ai;
        # ... (voir nginx-api-calls-to-add.conf)
    }
    
    # ============================================
    # JUSQU'ICI
    # ============================================
}
```

## 🔧 Étapes détaillées

### Étape 1 : Trouver le nom de votre service Docker

```bash
docker ps | grep calls-backend
```

Vous verrez quelque chose comme :
```
abc123def456   v25-dash-calls-backend:latest   ...   0.0.0.0:5006->5006/tcp
```

Le nom du service est probablement : `v25-dash-calls-backend` ou `v25_dash_calls_backend`

### Étape 2 : Ouvrir votre fichier nginx.conf

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

### Étape 4 : Ajouter le nouveau bloc

**Ligne à trouver :**
```nginx
        }
    }  ← ICI (ligne qui ferme le server pour v25.harx.ai)
```

**Ajoutez après cette ligne :**
```nginx
        }
    }  ← Après cette ligne

    # Nouveau bloc pour api-calls.harx.ai
    server {
        listen 443 ssl http2;
        server_name api-calls.harx.ai;
        # ... (copier depuis nginx-api-calls-to-add.conf)
    }

}  ← Avant cette ligne (fermeture du bloc http)
```

### Étape 5 : Adapter le nom du service Docker

Dans le fichier `nginx-api-calls-to-add.conf`, remplacez toutes les occurrences de :
```nginx
http://v25-dash-calls-backend:5006
```

Par le VRAI nom de votre service Docker (trouvé à l'étape 1).

### Étape 6 : Adapter les chemins SSL

Remplacez :
```nginx
ssl_certificate /etc/letsencrypt/live/api-calls.harx.ai/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/api-calls.harx.ai/privkey.pem;
```

Par vos vrais chemins SSL.

### Étape 7 : Tester et recharger

```bash
# Tester la configuration
sudo nginx -t

# Si OK, recharger
sudo systemctl reload nginx
# ou
sudo service nginx reload
```

## ✅ Vérification

Après rechargement, vérifiez les logs :
```bash
sudo tail -f /var/log/nginx/error.log
```

Si vous voyez des erreurs comme "upstream not found", c'est que le nom du service Docker est incorrect.


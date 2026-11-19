# Cumbión en internet (Dokploy)

Un solo servidor Node (sin dependencias) que sirve, en el mismo puerto **3000**:

| Ruta | Qué hace |
|---|---|
| `/` | Página de descarga |
| `/Cumbion-Organo.apk` | El APK del juego |
| `/salud` | Chequeo de salud (JSON) |
| WebSocket (ej. `wss://dominio/online`) | Modo ONLINE del juego |

## Antes de subir

```bash
node preparar.js
```

Copia `online.js` (desde `Cumbion-PC/servidor-online.js`) y arma `publico/index.html`.
Hay que correrlo cada vez que cambie el servidor online o la página.

## En Dokploy

1. **Crear Application** → Build type: **Dockerfile** (está en la raíz de esta carpeta).
2. **Origen del código**: un repo de Git con esta carpeta (el APK no va al repo: pesa más de 100 MB).
3. **Domains**: agregar el dominio, **Container Port 3000**, HTTPS activado (Let's Encrypt).
   Traefik ya deja pasar WebSocket, no hace falta configurar nada más.
4. **El APK** (elegir una):
   - **Volumen**: en *Advanced → Volumes* agregar un *Bind mount* del servidor, por ejemplo
     `/srv/cumbion/descargas` → `/app/descargas`, y copiar ahí `Cumbion-Organo.apk` (por SSH/SCP).
   - **Enlace externo**: variable de entorno `URL_APK=https://...` (por ejemplo, un archivo de GitHub Releases).
   - **Dentro de la imagen**: `node preparar.js --con-apk` y subir el código sin Git.
5. **Deploy** y probar `https://dominio/salud` → `{"ok":true,"apk":true,...}`.

## Después

En `OrganoCumbia/src/online.js` poner `SERVIDOR_PUBLICO = 'wss://dominio/online'` y volver a armar
el APK (`OrganoCumbia/scripts/crear-apk.ps1 -Rapido`) y el instalador de la PC (`Cumbion-PC: npm run dist`).

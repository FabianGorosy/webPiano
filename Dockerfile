# Imagen del servidor de Cumbión (página de descarga + APK + modo online). No usa dependencias de npm.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY package.json servidor.js online.js ./
COPY publico ./publico
# Carpeta para el APK cuando se sube aparte (volumen de Dokploy montado en /app/descargas)
RUN mkdir -p /app/descargas && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:3000/salud || exit 1
CMD ["node", "servidor.js"]

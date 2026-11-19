// Cumbión en internet: un solo servidor (un solo puerto) que hace tres cosas:
//   GET /                    → la página de descarga
//   GET /Cumbion-Organo.apk  → el APK del juego
//   WebSocket (cualquier ruta, ej. wss://dominio/online) → el modo ONLINE del juego
// Pensado para correr en Docker (Dokploy). Dokploy pone el dominio y el HTTPS adelante.
const http = require('http');
const fs = require('fs');
const path = require('path');
const online = require('./online');

const PUERTO = Number(process.env.PORT) || 3000;
const PUBLICO = path.join(__dirname, 'publico');
const NOMBRE_APK = 'Cumbion-Organo.apk';
// Dónde buscar el APK: primero la carpeta de descargas (un volumen de Dokploy), después la imagen.
const CARPETAS_APK = [process.env.CARPETA_APK || '/app/descargas', PUBLICO];
// Si el APK está guardado en otro lado (por ejemplo, GitHub Releases), se redirige ahí.
const URL_APK = process.env.URL_APK || '';

const buscarApk = () => CARPETAS_APK.map((c) => path.join(c, NOMBRE_APK)).find((f) => fs.existsSync(f));

const SEGURIDAD = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

const servidor = http.createServer((pedido, respuesta) => {
  const ruta = new URL(pedido.url, 'http://x').pathname;

  if (pedido.method !== 'GET' && pedido.method !== 'HEAD') {
    respuesta.writeHead(405, { Allow: 'GET, HEAD' });
    return respuesta.end();
  }

  if (ruta === '/' || ruta === '/index.html') {
    respuesta.writeHead(200, { ...SEGURIDAD, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    if (pedido.method === 'HEAD') return respuesta.end();
    return fs.createReadStream(path.join(PUBLICO, 'index.html')).pipe(respuesta);
  }

  if (ruta === `/${NOMBRE_APK}`) {
    const apk = buscarApk();
    if (!apk && URL_APK) {
      respuesta.writeHead(302, { Location: URL_APK });
      return respuesta.end();
    }
    if (!apk) {
      respuesta.writeHead(404, { ...SEGURIDAD, 'Content-Type': 'text/plain; charset=utf-8' });
      return respuesta.end('El APK todavía no está subido al servidor.');
    }
    const { size, mtime } = fs.statSync(apk);
    respuesta.writeHead(200, {
      ...SEGURIDAD,
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': size,
      'Content-Disposition': `attachment; filename="${NOMBRE_APK}"`,
      'Last-Modified': mtime.toUTCString(),
      'Cache-Control': 'no-cache',
    });
    if (pedido.method === 'HEAD') return respuesta.end();
    console.log(new Date().toISOString(), 'descarga del APK');
    return fs.createReadStream(apk).pipe(respuesta);
  }

  // Para el chequeo de salud de Dokploy / Docker
  if (ruta === '/salud') {
    respuesta.writeHead(200, { 'Content-Type': 'application/json' });
    return respuesta.end(JSON.stringify({ ok: true, apk: !!buscarApk() || !!URL_APK, jugadores: online.enLinea() }));
  }

  respuesta.writeHead(404, { ...SEGURIDAD, 'Content-Type': 'text/plain; charset=utf-8' });
  respuesta.end('No existe esa página.');
});

online.adjuntar(servidor, { puerto: PUERTO, mostrarDirecciones: false });

servidor.listen(PUERTO, () => {
  console.log(`Cumbión en línea en el puerto ${PUERTO}. APK: ${buscarApk() || URL_APK || 'todavía no está'}`);
});

// Docker manda SIGTERM al apagar o actualizar: cerrar prolijo
process.on('SIGTERM', () => servidor.close(() => process.exit(0)));

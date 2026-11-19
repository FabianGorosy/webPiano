// Junta en esta carpeta todo lo que necesita el servidor de internet:
//   - online.js            ← copia de Cumbion-PC/servidor-online.js (el modo ONLINE)
//   - publico/index.html   ← la página de descarga (sale de pagina-descarga/plantilla.html)
//   - publico/Cumbion-Organo.apk ← el APK (solo si se pasa --con-apk; pesa mucho para Git)
// Uso:  node preparar.js            (sin el APK)
//       node preparar.js --con-apk  (con el APK adentro de la imagen de Docker)
const fs = require('fs');
const path = require('path');

const aqui = __dirname;
const raiz = path.join(aqui, '..');
const publico = path.join(aqui, 'publico');
fs.mkdirSync(publico, { recursive: true });

fs.copyFileSync(path.join(raiz, 'Cumbion-PC', 'servidor-online.js'), path.join(aqui, 'online.js'));

const icono = fs.readFileSync(path.join(raiz, 'OrganoCumbia', 'assets', 'icon.png')).toString('base64');
const pagina = fs
  .readFileSync(path.join(raiz, 'pagina-descarga', 'plantilla.html'), 'utf8')
  .replace('{{ICONO}}', `data:image/png;base64,${icono}`)
  .replace('{{ENLACE}}', 'Cumbion-Organo.apk');
fs.writeFileSync(
  path.join(publico, 'index.html'),
  `<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${pagina}\n</body>\n</html>\n`,
);

const apkDestino = path.join(publico, 'Cumbion-Organo.apk');
if (process.argv.includes('--con-apk')) {
  fs.copyFileSync(path.join(raiz, 'Cumbion-Organo.apk'), apkDestino);
  console.log('APK copiado a publico/');
} else if (fs.existsSync(apkDestino)) {
  fs.unlinkSync(apkDestino);
}
console.log('Listo: online.js y publico/index.html actualizados');

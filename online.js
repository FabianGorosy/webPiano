// Servidor del modo ONLINE de Cumbión: empareja a dos jugadores con las mismas estrellas,
// cada uno vota una canción de su nivel, se sortea entre los dos votos y compiten tocándola.
// No hay chat: los jugadores solo ven el nombre, el avatar y las estrellas del rival.
//
// Usa WebSocket sin librerías externas (solo Node). Se puede usar de dos formas:
//   - Dentro de la app de la PC (main.js lo arranca solo, en el puerto 8787).
//   - Suelto, en una compu o un servidor de internet:  node servidor-online.js   (puerto: variable PORT o 8787)
const http = require('http');
const crypto = require('crypto');
const os = require('os');

const PUERTO = 8787;
const SEGUNDOS_VOTO = 15;
const SEGUNDOS_CARGA = 45; // para descargar el instrumento
const SEGUNDOS_ESPERA_FIN = 30; // cuánto se espera al rival una vez que vos terminaste
const MAX_NOMBRE = 20;

// ---------- WebSocket mínimo (RFC 6455, solo mensajes de texto) ----------
function aceptar(pedido, socket) {
  const clave = pedido.headers['sec-websocket-key'];
  if (!clave) return socket.destroy();
  const respuesta = crypto.createHash('sha1').update(clave + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${respuesta}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  return crearConexion(socket);
}

function trama(opcode, datos) {
  const largo = datos.length;
  const cabecera = largo < 126 ? Buffer.from([0x80 | opcode, largo]) : largo < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (largo >= 126) {
    cabecera[0] = 0x80 | opcode;
    if (largo < 65536) {
      cabecera[1] = 126;
      cabecera.writeUInt16BE(largo, 2);
    } else {
      cabecera[1] = 127;
      cabecera.writeBigUInt64BE(BigInt(largo), 2);
    }
  }
  return Buffer.concat([cabecera, datos]);
}

function crearConexion(socket) {
  const con = { socket, abierta: true, alMensaje: null, alCerrar: null, vivo: true };
  let pendiente = Buffer.alloc(0);
  let partes = [];

  con.enviar = (obj) => {
    if (con.abierta) socket.write(trama(0x1, Buffer.from(JSON.stringify(obj))));
  };
  con.cerrar = () => {
    if (!con.abierta) return;
    con.abierta = false;
    try {
      socket.end(trama(0x8, Buffer.alloc(0)));
    } catch {}
    con.alCerrar?.();
  };

  socket.on('data', (trozo) => {
    pendiente = Buffer.concat([pendiente, trozo]);
    while (pendiente.length >= 2) {
      const fin = (pendiente[0] & 0x80) !== 0;
      const opcode = pendiente[0] & 0x0f;
      const enmascarado = (pendiente[1] & 0x80) !== 0;
      let largo = pendiente[1] & 0x7f;
      let pos = 2;
      if (largo === 126) {
        if (pendiente.length < 4) return;
        largo = pendiente.readUInt16BE(2);
        pos = 4;
      } else if (largo === 127) {
        if (pendiente.length < 10) return;
        largo = Number(pendiente.readBigUInt64BE(2));
        pos = 10;
      }
      if (largo > 64 * 1024) return con.cerrar(); // los mensajes del juego son chiquitos
      const total = pos + (enmascarado ? 4 : 0) + largo;
      if (pendiente.length < total) return;
      let datos = pendiente.subarray(pos + (enmascarado ? 4 : 0), total);
      if (enmascarado) {
        const mascara = pendiente.subarray(pos, pos + 4);
        datos = Buffer.from(datos.map((b, i) => b ^ mascara[i % 4]));
      }
      pendiente = pendiente.subarray(total);

      if (opcode === 0x8) return con.cerrar();
      if (opcode === 0x9) {
        socket.write(trama(0xa, datos));
        continue;
      }
      if (opcode === 0xa) {
        con.vivo = true;
        continue;
      }
      partes.push(datos);
      if (!fin) continue;
      const texto = Buffer.concat(partes).toString('utf8');
      partes = [];
      con.vivo = true;
      try {
        con.alMensaje?.(JSON.parse(texto));
      } catch {}
    }
  });
  socket.on('close', () => {
    if (con.abierta) {
      con.abierta = false;
      con.alCerrar?.();
    }
  });
  socket.on('error', () => socket.destroy());
  return con;
}

// ---------- Juego ----------
const jugadores = new Set();
let cola = [];
const salas = new Map();

const limpiarNombre = (n) => String(n || 'Jugador').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, MAX_NOMBRE) || 'Jugador';
const numero = (n, max) => Math.max(0, Math.min(max, Math.round(Number(n) || 0)));
const idCancion = (id) => (typeof id === 'string' && /^[\w:-]{1,40}$/.test(id) ? id : null);

function direccionesLocales() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((d) => d && d.family === 'IPv4' && !d.internal)
    .map((d) => d.address);
}

const publico = (j) => ({ nombre: j.nombre, estrellas: j.estrellas, avatar: j.avatar, marco: j.marco, titulo: j.titulo });
const enLinea = () => [...jugadores].filter((j) => j.nombre).length;

// Tolerancia de estrellas: empieza casi exacta y se abre de a poco si nadie aparece
function tolerancia(j, ahora) {
  const segundos = (ahora - j.buscandoDesde) / 1000;
  const base = Math.max(1, Math.round(j.estrellas * 0.02));
  return Math.min(Math.max(30, Math.round(j.estrellas * 0.3)), Math.round(base * (1 + segundos / 4)));
}

function emparejar() {
  const ahora = Date.now();
  cola = cola.filter((j) => j.con.abierta && j.estado === 'buscando');
  cola.sort((a, b) => a.estrellas - b.estrellas);
  for (let i = 0; i < cola.length - 1; i++) {
    const a = cola[i];
    const b = cola[i + 1];
    if (a.nombre.toLowerCase() === b.nombre.toLowerCase()) continue;
    const dif = Math.abs(a.estrellas - b.estrellas);
    if (dif <= tolerancia(a, ahora) && dif <= tolerancia(b, ahora)) {
      cola.splice(i, 2);
      i -= 1;
      crearSala(a, b);
    }
  }
}

function crearSala(a, b) {
  const sala = { id: crypto.randomUUID(), jugadores: [a, b], fase: 'votar', votos: new Map(), opciones: new Map(), listos: new Set(), finales: new Map(), reloj: null };
  salas.set(sala.id, sala);
  for (const [yo, rival] of [[a, b], [b, a]]) {
    yo.estado = 'jugando';
    yo.sala = sala;
    yo.con.enviar({ tipo: 'emparejado', rival: publico(rival), segundosVoto: SEGUNDOS_VOTO });
  }
  sala.reloj = setTimeout(() => cerrarVotacion(sala), (SEGUNDOS_VOTO + 2) * 1000);
}

function cerrarVotacion(sala) {
  if (sala.fase !== 'votar') return;
  clearTimeout(sala.reloj);
  // quien no votó, vota sin querer una de sus opciones al azar
  for (const j of sala.jugadores) {
    if (!sala.votos.has(j)) {
      const ops = sala.opciones.get(j) || [];
      if (ops.length) sala.votos.set(j, ops[Math.floor(Math.random() * ops.length)]);
    }
  }
  const votos = [...sala.votos.values()];
  if (!votos.length) return terminarSala(sala, 'sinVotos');
  const elegida = votos[Math.floor(Math.random() * votos.length)];
  sala.fase = 'cargar';
  for (const j of sala.jugadores) {
    const rival = sala.jugadores.find((x) => x !== j);
    j.con.enviar({ tipo: 'elegida', cancion: elegida, tuVoto: sala.votos.get(j) || null, votoRival: sala.votos.get(rival) || null });
  }
  sala.reloj = setTimeout(() => empezar(sala), SEGUNDOS_CARGA * 1000);
}

function empezar(sala) {
  if (sala.fase !== 'cargar') return;
  clearTimeout(sala.reloj);
  sala.fase = 'tocar';
  for (const j of sala.jugadores) j.con.enviar({ tipo: 'empezar' });
}

function registrarFin(sala, j, datos) {
  if (sala.fase !== 'tocar' || sala.finales.has(j)) return;
  sala.finales.set(j, { precision: numero(datos.precision, 100), combo: numero(datos.combo, 100000) });
  if (sala.finales.size === 2) return resolver(sala);
  clearTimeout(sala.reloj);
  sala.reloj = setTimeout(() => resolver(sala), SEGUNDOS_ESPERA_FIN * 1000);
}

function resolver(sala, abandono = null) {
  if (sala.fase === 'fin') return;
  sala.fase = 'fin';
  clearTimeout(sala.reloj);
  const [a, b] = sala.jugadores;
  const pa = sala.finales.get(a);
  const pb = sala.finales.get(b);
  for (const [yo, rival, mio, suyo] of [[a, b, pa, pb], [b, a, pb, pa]]) {
    let resultado;
    if (abandono) resultado = abandono === yo ? 'derrota' : 'victoria';
    else if (!mio) resultado = 'derrota';
    else if (!suyo) resultado = 'victoria';
    else if (mio.precision === suyo.precision) resultado = mio.combo === suyo.combo ? 'empate' : mio.combo > suyo.combo ? 'victoria' : 'derrota';
    else resultado = mio.precision > suyo.precision ? 'victoria' : 'derrota';
    yo.con.enviar({ tipo: 'resultado', resultado, tuyo: mio || null, rival: suyo || null, abandono: !!abandono && abandono !== yo });
  }
  terminarSala(sala);
}

function terminarSala(sala, motivo) {
  clearTimeout(sala.reloj);
  salas.delete(sala.id);
  for (const j of sala.jugadores) {
    if (motivo) j.con.enviar({ tipo: 'cancelada', motivo });
    j.sala = null;
    j.estado = 'libre';
  }
}

function salir(j) {
  cola = cola.filter((x) => x !== j);
  const sala = j.sala;
  if (!sala) return;
  if (sala.fase === 'votar' || sala.fase === 'cargar' || sala.fase === 'tocar') resolver(sala, j);
}

function alMensaje(j, m) {
  switch (m?.tipo) {
    case 'hola':
      j.nombre = limpiarNombre(m.nombre);
      j.estrellas = numero(m.estrellas, 1e6);
      j.avatar = typeof m.avatar === 'string' ? m.avatar.slice(0, 40) : null;
      j.marco = typeof m.marco === 'string' ? m.marco.slice(0, 40) : null;
      j.titulo = typeof m.titulo === 'string' ? m.titulo.slice(0, 40) : null;
      j.con.enviar({ tipo: 'bienvenida', enLinea: enLinea(), direcciones: j.mostrarDirecciones ? direccionesLocales() : [], puerto: j.puerto });
      break;
    case 'buscar':
      if (!j.nombre || j.estado !== 'libre') return;
      j.estado = 'buscando';
      j.buscandoDesde = Date.now();
      cola.push(j);
      emparejar();
      break;
    case 'cancelar':
      if (j.estado === 'buscando') {
        cola = cola.filter((x) => x !== j);
        j.estado = 'libre';
      }
      break;
    case 'opciones':
      if (j.sala?.fase === 'votar' && Array.isArray(m.canciones)) {
        j.sala.opciones.set(j, m.canciones.map(idCancion).filter(Boolean).slice(0, 5));
      }
      break;
    case 'voto': {
      const sala = j.sala;
      const id = idCancion(m.cancion);
      if (sala?.fase !== 'votar' || !id || sala.votos.has(j)) return;
      sala.votos.set(j, id);
      sala.jugadores.find((x) => x !== j)?.con.enviar({ tipo: 'rivalVoto' });
      if (sala.votos.size === 2) setTimeout(() => cerrarVotacion(sala), 600);
      break;
    }
    case 'listo': {
      const sala = j.sala;
      if (sala?.fase !== 'cargar') return;
      sala.listos.add(j);
      if (sala.listos.size === 2) empezar(sala);
      break;
    }
    case 'marcador': {
      const sala = j.sala;
      if (sala?.fase !== 'tocar') return;
      sala.jugadores.find((x) => x !== j)?.con.enviar({ tipo: 'marcadorRival', precision: numero(m.precision, 100), combo: numero(m.combo, 100000), avance: numero(m.avance, 100) });
      break;
    }
    case 'fin':
      if (j.sala) registrarFin(j.sala, j, m);
      break;
    case 'abandonar':
      salir(j);
      break;
    case 'ping':
      j.con.enviar({ tipo: 'pong', enLinea: enLinea() });
      break;
  }
}

// Engancha el juego online a un servidor HTTP que ya existe (las conexiones WebSocket llegan por "upgrade").
// mostrarDirecciones: en una red de casa avisa la IP local para que se conecte el celu; en internet no hace falta.
function adjuntar(servidor, { puerto = PUERTO, mostrarDirecciones = true } = {}) {
  servidor.on('upgrade', (pedido, socket) => {
    const con = aceptar(pedido, socket);
    if (!con) return;
    const j = { con, nombre: null, estrellas: 0, estado: 'libre', sala: null, puerto, mostrarDirecciones };
    jugadores.add(j);
    con.alMensaje = (m) => alMensaje(j, m);
    con.alCerrar = () => {
      salir(j);
      jugadores.delete(j);
    };
  });
  // emparejar cada segundo (la tolerancia de estrellas se va abriendo) y cortar conexiones muertas
  const reloj = setInterval(emparejar, 1000);
  const latido = setInterval(() => {
    for (const j of jugadores) {
      if (!j.con.vivo) {
        j.con.socket.destroy();
        continue;
      }
      j.con.vivo = false;
      if (j.con.abierta) j.con.socket.write(trama(0x9, Buffer.alloc(0)));
    }
  }, 20000);
  servidor.on('close', () => {
    clearInterval(reloj);
    clearInterval(latido);
  });
  return servidor;
}

function iniciar(puerto = PUERTO) {
  const servidor = http.createServer((pedido, respuesta) => {
    respuesta.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    respuesta.end(`Servidor online de Cumbión · ${enLinea()} jugadores conectados\n`);
  });
  adjuntar(servidor, { puerto });
  return new Promise((resolver, rechazar) => {
    servidor.once('error', rechazar);
    servidor.listen(puerto, () => resolver(servidor));
  });
}

module.exports = { adjuntar, iniciar, enLinea, PUERTO };

if (require.main === module) {
  const puerto = Number(process.env.PORT) || PUERTO;
  iniciar(puerto).then(
    () => console.log(`Servidor online de Cumbión escuchando en el puerto ${puerto} · ${direccionesLocales().join(', ')}`),
    (e) => {
      console.error('No se pudo abrir el servidor:', e.message);
      process.exit(1);
    },
  );
}

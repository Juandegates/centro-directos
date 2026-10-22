// Centro de Directos · Fase 1: bot de IA que maneja tu chat de Twitch como si fueras tú.
import { createServer } from 'node:http';
import { crearBot, leerConfig } from './bot.js';
import { crearPantalla } from './pantalla.js';
import { crearDatos } from './datos.js';
import * as twitch from './twitch.js';
import { alAvisoIA } from './ia.js';

const hora = () => new Date().toLocaleTimeString('es-MX', { hour12: false });
const log = (t) => console.log(`[${hora()}] ${t}`);
alAvisoIA(log);

for (const k of ['GEMINI_API_KEY', 'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_CANAL']) {
  if (!process.env[k] || process.env[k].startsWith('pega_aqui') || process.env[k] === 'tu_usuario_de_twitch') {
    console.log(`\n❌ Falta poner ${k} en claves.txt\n`);
    process.exit(1);
  }
}

let iniciado = false;

async function iniciarBot() {
  if (iniciado) return;
  iniciado = true;
  const yo = await twitch.idDeUsuario();
  const canal = await twitch.idDeUsuario(process.env.TWITCH_CANAL);
  log(`Sesión de Twitch: ${yo.display_name} · Canal: ${canal.display_name}`);

  const pantalla = crearPantalla({
    canal: canal.login,
    leerConfig,
    estaEnVivo: () => twitch.estaEnVivo(canal.id),
    log,
  });

  const datos = crearDatos({
    canal,
    log,
    leerConfig,
    verPantalla: () => pantalla.recientes(3),
  });

  const bot = crearBot({
    log,
    datos,
    verPantalla: () => (leerConfig().pantalla?.activa === false ? [] : pantalla.recientes(3)),
    enviar: (texto) => twitch.enviarMensaje({ canalId: canal.id, emisorId: yo.id, texto }),
    estaEnVivo: async () => datos.actual().enVivo,
  });

  twitch.escucharChat({
    canalId: canal.id,
    lectorId: yo.id,
    alEstado: log,
    alMensaje: (ev) => {
      const texto = ev.message?.text ?? '';
      const esMio = ev.chatter_user_id === yo.id;
      if (!esMio) log(`💬 ${ev.chatter_user_name}: ${texto}`);
      bot.recibir({ usuarioId: ev.chatter_user_id, nombre: ev.chatter_user_name, texto, esMio })
        .catch((e) => log('⚠️ ' + e.message));
    },
  });
}

// ---------- Servidor local (inicio de sesión de Twitch) ----------
const servidor = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:3000');
  const html = (t) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<body style="font-family:system-ui;background:#101114;color:#f2f2f3;padding:40px;font-size:20px">${t}</body>`);
  };

  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    if (!code) return html('❌ Twitch no dio permiso. Cierra esta pestaña e inténtalo otra vez.');
    try {
      await twitch.canjearCodigo(code);
      html('✅ Listo, ya iniciaste sesión. Puedes cerrar esta pestaña y volver a la ventana negra.');
      log('Sesión de Twitch guardada.');
      iniciarBot().catch((e) => log('❌ ' + e.message));
    } catch (e) {
      html('❌ ' + e.message);
    }
    return;
  }
  res.writeHead(302, { Location: twitch.urlLogin() });
  res.end();
});

servidor.listen(3000, () => {
  console.log('\n=== Centro de Directos · Fase 1 ===\n');
  if (twitch.tieneSesion()) {
    iniciarBot().catch((e) => log('❌ ' + e.message));
  } else {
    log('Primera vez: abre http://localhost:3000 en el navegador de esta PC para iniciar sesión en Twitch.');
  }
});

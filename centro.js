// Centro de Directos · Fase 1: bot de IA para el chat de Twitch.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { preguntarIA } from './ia.js';
import * as twitch from './twitch.js';

const hora = () => new Date().toLocaleTimeString('es-MX', { hour12: false });
const log = (t) => console.log(`[${hora()}] ${t}`);

for (const k of ['GEMINI_API_KEY', 'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_CANAL']) {
  if (!process.env[k] || process.env[k].startsWith('pega_aqui') || process.env[k] === 'tu_usuario_de_twitch') {
    console.log(`\n❌ Falta poner ${k} en claves.txt\n`);
    process.exit(1);
  }
}

const leerConfig = () => JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));

// ---------- Lógica del bot ----------
let ultimaRespuesta = 0;
const ultimaPorUsuario = new Map();
const historial = [];

function debeResponder(texto, config, botLogin) {
  const t = texto.toLowerCase();
  if (config.responderMenciones && t.includes('@' + botLogin.toLowerCase())) return true;
  if (config.responderPreguntas && texto.includes('?')) return true;
  return false;
}

async function iniciarBot() {
  const yo = await twitch.idDeUsuario();
  const canal = await twitch.idDeUsuario(process.env.TWITCH_CANAL);
  log(`Sesión de Twitch: ${yo.display_name} · Canal: ${canal.display_name}`);

  twitch.escucharChat({
    canalId: canal.id,
    lectorId: yo.id,
    alEstado: log,
    alMensaje: async (ev) => {
      const texto = ev.message?.text ?? '';
      const quien = ev.chatter_user_name;
      historial.push(`${quien}: ${texto}`);
      if (historial.length > 10) historial.shift();
      log(`💬 ${quien}: ${texto}`);

      // Con tu propia cuenta, el bot nunca contesta tus mensajes (ni los suyos).
      if (ev.chatter_user_id === yo.id) return;

      const config = leerConfig();
      const ahora = Date.now();
      const comando = config.comandos?.[texto.trim().split(/\s+/)[0].toLowerCase()];

      const responder = async (respuesta) => {
        await twitch.enviarMensaje({
          canalId: canal.id,
          emisorId: yo.id,
          texto: (config.prefijo ?? '') + respuesta,
          responderA: ev.message_id,
        });
        ultimaRespuesta = ahora;
        ultimaPorUsuario.set(ev.chatter_user_id, ahora);
        log(`🤖 → ${quien}: ${respuesta}`);
      };

      try {
        if (comando) return await responder(comando);
        if (!debeResponder(texto, config, yo.login)) return;
        if (ahora - ultimaRespuesta < config.pausaGlobalSegundos * 1000) return;
        if (ahora - (ultimaPorUsuario.get(ev.chatter_user_id) ?? 0) < config.pausaPorUsuarioSegundos * 1000) return;

        const respuesta = await preguntarIA({
          personalidad: config.personalidad,
          contexto: historial.slice(0, -1).join('\n'),
          mensaje: `${quien}: ${texto}`,
        });
        if (respuesta) await responder(respuesta);
      } catch (e) {
        log('⚠️ ' + e.message);
      }
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

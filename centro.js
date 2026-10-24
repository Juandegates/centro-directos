// Centro de Directos · v3: todo automático y enfocado en crecer. Tú solo le das "Transmitir" en la PS5.
import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { crearBot, leerConfig } from './bot.js';
import { crearCaptura } from './captura.js';
import { crearDatos } from './datos.js';
import { crearClips } from './clips.js';
import { crearPromos } from './promos.js';
import { crearMomentos } from './momentos.js';
import { crearCalendario } from './calendario.js';
import { crearCrecer, capitulos } from './crecer.js';
import { iniciarServidor } from './servidor.js';
import { probarTodo } from './diagnostico.js';
import { revisarVersion, actualizar } from './actualizar.js';
import { lanzarDesdeTwitch } from './herramientas.js';
import { ajustes, guardarAjustes } from './ajustes.js';
import { avisar } from './avisos.js';
import { alAvisoIA, configurarIA } from './ia.js';
import { log, marcar, alCambiar, verPartes, verBitacora, reporte, VERSION, PARTES } from './estado.js';
import * as chat from './chat.js';
import * as bandeja from './bandeja.js';
import * as twitch from './twitch.js';
import * as youtube from './youtube.js';

console.log(`\n=== Centro de Directos · v${VERSION} ===\n`);
alAvisoIA((t) => log(t));
configurarIA(leerConfig);

// Ajustes que cambiaron de valor recomendado entre versiones (solo si seguías con el valor viejo).
try {
  const ruta = new URL('./config.json', import.meta.url);
  const c = leerConfig();
  // Cada cambio se aplica una sola vez (se anota en ajustes.json, que nunca se reemplaza al actualizar).
  const hechas = ajustes().migraciones ?? [];
  if (!hechas.includes('animar-20')) {
    if (c.animarChat?.minutosSinMensajes === 5) c.animarChat.minutosSinMensajes = 20;
    writeFileSync(ruta, JSON.stringify(c, null, 2) + '\n');
    guardarAjustes({ migraciones: [...hechas, 'animar-20'] });
  }
} catch (e) { log('No pude actualizar config.json: ' + e.message, { nivel: 'aviso' }); }

for (const k of ['GEMINI_API_KEY', 'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_CANAL']) {
  if (!process.env[k] || process.env[k].startsWith('pega_aqui') || process.env[k] === 'tu_usuario_de_twitch') {
    console.log(`\n❌ Falta poner ${k} en claves.txt\n`);
    process.exit(1);
  }
}

// PIN de la app: el de claves.txt, o uno generado la primera vez.
if (!ajustes().pin) guardarAjustes({ pin: String(randomInt(100000, 999999)) });
const PIN = process.env.APP_PIN && !process.env.APP_PIN.startsWith('pega_aqui') ? process.env.APP_PIN : ajustes().pin;
// Dirección de la app para los avisos: la de Tailscale si está instalado (funciona fuera de casa).
let urlDetectada = `http://${hostname().toLowerCase()}:3000`;
function detectarUrl() {
  for (const exe of ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe']) {
    const r = spawnSync(exe, ['status', '--json'], { windowsHide: true, timeout: 8000 });
    if (r.status !== 0) continue;
    try {
      const yo = JSON.parse(r.stdout.toString()).Self;
      const nombre = (yo?.DNSName ?? '').replace(/\.$/, '');
      const servido = spawnSync(exe, ['serve', 'status'], { windowsHide: true, timeout: 8000 }).stdout?.toString() ?? '';
      if (nombre && /3000/.test(servido)) urlDetectada = `https://${nombre}`;
      else if (yo?.TailscaleIPs?.[0]) urlDetectada = `http://${yo.TailscaleIPs[0]}:3000`;
    } catch { /* sin Tailscale */ }
    return;
  }
}
detectarUrl();
setInterval(detectarUrl, 10 * 60_000);
const urlApp = () => leerConfig().urlApp || urlDetectada;

// ---------- Avisos automáticos de fallas y recuperaciones ----------
alCambiar(({ parte, anterior, estado, mensaje }) => {
  if (parte === 'avisos' || parte === 'ia') return; // la IA tiene respaldo; avisamos solo si fallan las dos
  if (estado === 'error') {
    avisar(`⚠️ ${PARTES[parte]}`, mensaje, { prioridad: 4, etiquetas: ['warning'], abrir: `${urlApp()}#diagnostico`, clave: 'falla-' + parte, cadaMinutos: 15 });
  } else if (estado === 'ok' && anterior === 'error') {
    avisar(`✅ ${PARTES[parte]}`, 'Se recuperó: ' + mensaje, { prioridad: 2, etiquetas: ['white_check_mark'], clave: 'ok-' + parte, cadaMinutos: 15 });
  }
});

let ctx = null; // todo lo que existe una vez iniciada la sesión de Twitch

// ---------- YouTube ----------
const yt = { directo: null, relevo: null, chatActivo: false, ultimoTitulo: 0, revision: null };

async function iniciarYoutube() {
  if (yt.directo) return;
  if (!ajustes().envioYoutube) return marcar('envioYoutube', 'apagado', 'Envío a YouTube apagado desde la app');
  if (!youtube.configurado()) return marcar('youtube', 'apagado', 'Falta configurar Google en claves.txt');
  if (!youtube.tieneSesion()) return marcar('youtube', 'aviso', 'Falta autorizar YouTube en http://localhost:3000/youtube (desde la PC)');
  const d = ctx.datos.actual();
  try {
    const stream = await youtube.asegurarStream();
    yt.directo = await youtube.crearDirecto({
      titulo: d.titulo || `Jugando ${d.juego} en PS5`,
      descripcion: `🎮 ${d.juego} en vivo desde la PS5.\n\nJuego: ${d.juego}\nHorario: ${d.horario}`,
      streamId: stream.id,
    });
    marcar('youtube', 'ok', 'Directo creado en YouTube');
    arrancarRelevo(stream.rtmp);
    leerChatYoutube();
    setTimeout(revisarYoutube, 45_000);
    yt.revision = setInterval(revisarYoutube, 120_000);
  } catch (e) {
    const sinPermiso = /liveStreamingNotEnabled|livePermissionBlocked/.test(e.motivo ?? e.message);
    marcar('youtube', 'error', sinPermiso ? 'YouTube todavía no permite transmitir en tu canal (revisa YouTube Studio)' : 'No pude crear el directo en YouTube', e.message);
  }
}

function arrancarRelevo(rtmp) {
  let fallas = 0;
  const lanzar = () => {
    yt.relevo = lanzarDesdeTwitch({
      config: leerConfig(),
      canal: ctx.canal.login,
      calidad: 'best',
      argsSalida: ['-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-f', 'flv', '-flvflags', 'no_duration_filesize', rtmp],
      alError: (m) => marcar('envioYoutube', 'error', m),
      alTerminar: (codigo, errores) => {
        if (!yt.directo) return;
        fallas++;
        const espera = Math.min(60, 5 * fallas);
        // La primera falla suele ser que el directo está terminando: reintentamos sin alarmar.
        if (fallas >= 2) marcar('envioYoutube', fallas >= 3 ? 'error' : 'aviso', `Se cortó el envío a YouTube; reintento en ${espera} s`, errores || `código ${codigo}`);
        setTimeout(() => yt.directo && lanzar(), espera * 1000);
      },
    });
    if (fallas === 0) marcar('envioYoutube', 'aviso', 'Enviando señal a YouTube… (confirmando)');
  };
  lanzar();
}

async function revisarYoutube() {
  if (!yt.directo) return;
  try {
    const r = await youtube.miDirecto(yt.directo.id);
    if (r === 'live') marcar('envioYoutube', 'ok', 'En vivo en YouTube');
  } catch { /* se revisa en la siguiente vuelta */ }
}

let ultimoMensajeYt = 0;
async function leerChatYoutube() {
  if (yt.chatActivo || !yt.directo?.chatId) return;
  yt.chatActivo = true;
  ultimoMensajeYt = Date.now();
  const directoDeEsteChat = yt.directo; // si se crea otro directo, este ciclo se detiene
  let pagina = null;
  let primero = true;
  while (yt.directo === directoDeEsteChat && yt.chatActivo) {
    try {
      if (youtube.cuotaUsada() > 9000) {
        marcar('chatYoutube', 'aviso', 'Cuota diaria de YouTube casi agotada: pauso el chat hasta mañana');
        break;
      }
      const r = await youtube.leerChat(yt.directo.chatId, pagina);
      pagina = r.siguiente;
      marcar('chatYoutube', 'ok', 'Leyendo el chat de YouTube');
      if (r.mensajes.some((m) => !m.esMio)) ultimoMensajeYt = Date.now();
      if (!primero) {
        for (const m of r.mensajes) {
          if (!m.esMio) ctx.clips.registrarMensaje({ nombre: m.nombre, texto: m.texto, plataforma: 'youtube' });
          ctx.bots.youtube.recibir(m).catch(() => {});
        }
      }
      primero = false;
      if (r.terminado) break;
      // Cada lectura gasta cuota: cada 10 s si hay plática, cada 20 s si el chat lleva 3 min callado.
      const cy = leerConfig().youtube ?? {};
      const callado = Date.now() - ultimoMensajeYt > 3 * 60_000;
      const seg = callado ? (cy.segundosChatCallado ?? 20) : (cy.segundosEntreLecturas ?? 10);
      await new Promise((ok) => setTimeout(ok, Math.max(r.esperaMs, seg * 1000)));
    } catch (e) {
      marcar('chatYoutube', 'aviso', 'No pude leer el chat de YouTube; reintento', e.message);
      await new Promise((ok) => setTimeout(ok, 30_000));
    }
  }
  if (yt.directo === directoDeEsteChat || !yt.directo) yt.chatActivo = false;
}

async function detenerYoutube() {
  const directo = yt.directo;
  yt.directo = null;
  yt.chatActivo = false;
  clearInterval(yt.revision);
  yt.relevo?.detener();
  yt.relevo = null;
  marcar('envioYoutube', 'apagado', 'Sin directo');
  marcar('chatYoutube', 'apagado', 'Sin directo');
  if (directo) await youtube.terminarDirecto(directo.id).catch((e) => log('No pude cerrar el directo de YouTube: ' + e.message, { nivel: 'aviso' }));
  return directo;
}

async function arreglarVideoYoutube(directo, { juego, titulo, minutos }) {
  const momentos = ctx.momentos.lista().filter((m) => m.puntos >= 6);
  const caps = capitulos(directo.inicio, momentos);
  const descripcion = [
    `🎮 ${juego} en PS5 · directo de ${minutos} min.`,
    momentos.length ? `Lo mejor: ${momentos.sort((a, b) => b.puntos - a.puntos).slice(0, 3).map((m) => m.que).join(' · ')}.` : '',
    caps ? `\nCapítulos:\n${caps}` : '',
    `\nHago directos ${ctx.datos.actual().horario}. ¡Suscríbete para no perderte el siguiente!`,
  ].filter(Boolean).join('\n');
  await youtube.actualizarVideo({ id: directo.id, titulo: titulo || `${juego} en PS5`, descripcion, etiquetas: [juego, 'PS5', 'gameplay', 'español', 'en vivo'] });
  log('📺 Le puse descripción y capítulos al directo guardado en YouTube');
}

async function sincronizarTituloYoutube(titulo) {
  if (!yt.directo || Date.now() - yt.ultimoTitulo < 60_000) return;
  yt.ultimoTitulo = Date.now();
  const d = ctx.datos.actual();
  await youtube.cambiarTitulo({ ...yt.directo, titulo, descripcion: `🎮 ${d.juego} en vivo desde la PS5.\n\nJuego: ${d.juego}\nHorario: ${d.horario}` })
    .then(() => log('Título actualizado también en YouTube'))
    .catch((e) => marcar('youtube', 'aviso', 'No pude cambiar el título en YouTube', e.message));
}

// ---------- Inicio y fin del directo ----------
let inicioDirecto = null;

async function alEmpezar() {
  inicioDirecto = Date.now();
  const d = ctx.datos.actual();
  marcar('directo', 'ok', `En vivo: ${d.juego}`);
  ctx.bots.twitch.nuevoDirecto();
  ctx.bots.youtube.nuevoDirecto();
  ctx.momentos.nuevoDirecto();
  ctx.captura.iniciar();
  ctx.crecer.alEmpezar().catch((e) => log('⚠️ Crecer: ' + e.message, { nivel: 'aviso' }));
  await iniciarYoutube();
  ctx.promos.alEmpezar().catch(() => {});
  // Al minuto y medio, un resumen de cómo arrancó todo.
  setTimeout(() => {
    if (!ctx.datos.actual().enVivo) return;
    const p = Object.fromEntries(verPartes().map((x) => [x.id, x.estado]));
    const s = (e) => (e === 'ok' ? '✅' : e === 'apagado' ? '⚪' : '⚠️');
    avisar('🔴 Estás en vivo', `Twitch ✅ · YouTube ${s(p.envioYoutube)} · Bot ${s(p.chatTwitch)} · Vista ${s(p.captura)}\n${ctx.datos.actual().juego}`, {
      etiquetas: ['red_circle'], abrir: urlApp(), clave: 'en-vivo', cadaMinutos: 30,
    });
  }, 90_000);
}

async function alTerminar() {
  const minutos = inicioDirecto ? Math.round((Date.now() - inicioDirecto) / 60_000) : 0;
  inicioDirecto = null;
  marcar('directo', 'apagado', 'Sin directo');
  const d = ctx.datos.actual();
  ctx.captura.detener();
  const directoYt = await detenerYoutube();
  avisar('⚫ Terminó tu directo', `Duró ${minutos} min. Preparando el resumen…`, { etiquetas: ['black_circle'], clave: 'fin', cadaMinutos: 30 });
  await ctx.crecer.alTerminar().catch((e) => log('⚠️ Crecer: ' + e.message, { nivel: 'aviso' }));
  if (minutos >= 5) ctx.promos.alTerminar({ minutos }).catch(() => {});
  // Los clips de hoy se reparten en los próximos días (los mejores primero).
  setTimeout(() => { ctx.calendario.programar(); ctx.calendario.revisar().catch(() => {}); }, 90_000);
  if (directoYt && minutos >= 5) {
    setTimeout(() => arreglarVideoYoutube(directoYt, { juego: d.juego, titulo: d.titulo, minutos })
      .catch((e) => log('No pude ponerle descripción al video de YouTube: ' + e.message, { nivel: 'aviso' })), 120_000);
  }
}

// Bots de otros servicios que escriben en tu chat: el Centro no les contesta ni los cuenta para clips.
const BOTS = ['streamelements', 'nightbot', 'moobot', 'streamlabs', 'fossabot', 'wizebot', 'soundalerts', 'sery_bot', 'kofistreambot', 'botrixoficial', 'commanderroot', 'pokemoncommunitygame', 'own3d', 'tangiabot', 'blerp', 'lumiastream', 'creatisbot', 'frostytoolsdotcom'];
const esBotConocido = (nombre) => {
  const n = String(nombre ?? '').toLowerCase();
  return [...BOTS, ...(leerConfig().botsIgnorados ?? []).map((x) => String(x).toLowerCase())].includes(n);
};

// ---------- Arranque con la sesión de Twitch ----------
async function iniciar() {
  if (ctx) return;
  const yo = await twitch.idDeUsuario();
  const canal = await twitch.idDeUsuario(process.env.TWITCH_CANAL);
  const faltan = twitch.permisosFaltantes();
  const extra = twitch.permisosExtraFaltantes();
  if (faltan.length) marcar('twitch', 'error', 'Faltan permisos de Twitch: abre http://localhost:3000/twitch en la PC y autoriza', faltan.join(', '));
  else if (extra.length) marcar('twitch', 'aviso', 'Para raids y seguidores nuevos, autoriza otra vez: http://localhost:3000/twitch (en la PC)', extra.join(', '));
  else marcar('twitch', 'ok', `Sesión de ${yo.display_name}`);
  log(`Canal: ${canal.display_name}`);

  ctx = { yo, canal };
  ctx.captura = crearCaptura({ canal: canal.login, leerConfig });
  const verPantalla = () => (leerConfig().pantalla?.activa === false ? [] : ctx.captura.recientes(3));
  ctx.datos = crearDatos({
    canal, leerConfig, verPantalla, avisar, urlApp,
    alCambioVivo: (vivo) => (vivo ? alEmpezar() : alTerminar()).catch((e) => log('⚠️ ' + e.message, { nivel: 'error', detalle: e.stack })),
    alCambioTitulo: (t) => sincronizarTituloYoutube(t),
  });
  ctx.bots = {
    twitch: crearBot({
      plataforma: 'twitch', datos: ctx.datos, verPantalla, animarChat: true,
      enviar: (texto) => twitch.enviarMensaje({ canalId: canal.id, emisorId: yo.id, texto }),
    }),
    youtube: crearBot({
      plataforma: 'youtube', datos: ctx.datos, verPantalla,
      enviar: (texto) => (yt.directo ? youtube.enviarChat(yt.directo.chatId, texto) : Promise.resolve()),
    }),
  };
  ctx.clips = crearClips({
    captura: ctx.captura, leerConfig, datos: ctx.datos, avisar, urlApp,
    crearClipTwitch: () => twitch.crearClip(canal.id), canalLogin: canal.login,
  });
  ctx.momentos = crearMomentos({ captura: ctx.captura, leerConfig, datos: ctx.datos, clips: ctx.clips });
  ctx.calendario = crearCalendario({ leerConfig, avisar, urlApp, enVivo: () => ctx.datos.actual().enVivo });
  ctx.crecer = crearCrecer({ canal, datos: ctx.datos, leerConfig, avisar, urlApp });
  ctx.promos = crearPromos({ datos: ctx.datos, avisar, urlApp, urlTwitch: () => `https://twitch.tv/${canal.login}` });

  twitch.escucharEventos({
    canalId: canal.id,
    lectorId: yo.id,
    alMensaje: (ev) => {
      const texto = ev.message?.text ?? '';
      const esMio = ev.chatter_user_id === yo.id;
      if (!esMio && esBotConocido(ev.chatter_user_login ?? ev.chatter_user_name)) return; // StreamElements, Nightbot…
      if (!esMio) ctx.clips.registrarMensaje({ nombre: ev.chatter_user_name, texto, plataforma: 'twitch' });
      ctx.bots.twitch.recibir({ usuarioId: ev.chatter_user_id, nombre: ev.chatter_user_name, texto, esMio }).catch(() => {});
    },
    alEnVivo: () => { log('Twitch avisa: ¡empezó tu directo!'); ctx.datos.ponerVivo(true); ctx.datos.refrescar(); },
    alFin: () => { log('Twitch avisa: terminó tu directo'); ctx.datos.ponerVivo(false); },
    alRaid: (ev) => {
      log(`🎉 Raid de ${ev.from_broadcaster_user_name} con ${ev.viewers} personas`);
      avisar('🎉 ¡Te raidearon!', `${ev.from_broadcaster_user_name} llegó con ${ev.viewers} personas. El bot ya les dio la bienvenida.`, { etiquetas: ['tada'], clave: 'raid-' + ev.from_broadcaster_user_id, prioridad: 4 });
      ctx.bots.twitch.raid({ nombre: ev.from_broadcaster_user_name, espectadores: ev.viewers }).catch(() => {});
    },
    alSeguidor: (ev) => {
      log(`💜 Nuevo seguidor: ${ev.user_name}`);
      ctx.bots.twitch.seguidor(ev.user_name);
    },
  });
}

// ---------- Rutas de la app ----------
const necesitaCtx = () => { if (!ctx) throw new Error('El Centro todavía no inicia sesión en Twitch'); };

const rutas = {
  'GET /api/estado': async () => {
    const d = ctx?.datos.actual();
    const v = await revisarVersion();
    return {
      version: VERSION,
      versionNueva: v.hayNueva ? v.version : null,
      sesion: Boolean(ctx),
      canal: ctx?.canal.display_name,
      directo: d ?? null,
      youtube: { activo: Boolean(yt.directo), url: yt.directo?.url ?? null, envio: ajustes().envioYoutube, cuota: youtube.cuotaUsada(), configurado: youtube.configurado(), sesion: youtube.tieneSesion() },
      bot: ajustes().botPausado,
      partes: verPartes(),
      temaAvisos: ajustes().temaAvisos,
      urlApp: urlApp(),
    };
  },
  'GET /api/chat': ({ url }) => chat.desde(Number(url.searchParams.get('desde') ?? 0)),
  'POST /api/chat': async ({ cuerpo }) => {
    necesitaCtx();
    const texto = String(cuerpo.texto ?? '').trim();
    if (!texto) throw new Error('Mensaje vacío');
    const destinos = cuerpo.plataforma === 'todas' ? ['twitch', 'youtube'] : [cuerpo.plataforma];
    for (const p of destinos) {
      if (p === 'twitch') await twitch.enviarMensaje({ canalId: ctx.canal.id, emisorId: ctx.yo.id, texto });
      if (p === 'youtube' && yt.directo) {
        await youtube.enviarChat(yt.directo.chatId, texto); // regresa por el chat y se registra como tuyo
      }
    }
    return { ok: true };
  },
  'GET /api/categorias': async ({ url }) => { necesitaCtx(); return twitch.buscarCategorias(url.searchParams.get('q') ?? ''); },
  'POST /api/canal': async ({ cuerpo }) => {
    necesitaCtx();
    await twitch.cambiarCanal(ctx.canal.id, { titulo: cuerpo.titulo, categoriaId: cuerpo.categoriaId });
    ctx.datos.descartarSugerencia();
    await ctx.datos.refrescar();
    if (cuerpo.titulo) { yt.ultimoTitulo = 0; await sincronizarTituloYoutube(cuerpo.titulo); }
    log('Título/categoría cambiados desde la app');
    return { ok: true, directo: ctx.datos.actual() };
  },
  'POST /api/bot': ({ cuerpo }) => {
    guardarAjustes({ botPausado: { ...ajustes().botPausado, [cuerpo.plataforma]: Boolean(cuerpo.pausado) } });
    log(`Bot de ${cuerpo.plataforma} ${cuerpo.pausado ? 'pausado' : 'reanudado'} desde la app`);
    return { ok: true };
  },
  'POST /api/youtube': async ({ cuerpo }) => {
    guardarAjustes({ envioYoutube: Boolean(cuerpo.envio) });
    if (!cuerpo.envio) await detenerYoutube();
    else if (ctx?.datos.actual().enVivo) await iniciarYoutube();
    return { ok: true };
  },
  'GET /api/bandeja': () => bandeja.lista(),
  'POST /api/bandeja/*': ({ url, cuerpo }) => {
    const id = url.pathname.split('/').pop();
    if (cuerpo.borrar) { bandeja.quitar(id); return { ok: true }; }
    return bandeja.actualizar(id, { publicado: cuerpo.publicado ?? {} });
  },
  'POST /api/clip': async () => {
    necesitaCtx();
    if (!ctx.captura.activa()) throw new Error('Solo se pueden hacer clips mientras estás en vivo');
    ctx.clips.crear('manual');
    return { ok: true, mensaje: 'Armando el clip; te aviso cuando esté listo (tarda como 1 minuto).' };
  },
  'GET /api/bitacora': () => verBitacora(150),
  // ---------- Crecer ----------
  'GET /api/crecer': () => {
    if (!ctx) return { sinSesion: true };
    return { ...ctx.crecer.estado(), metas: ctx.crecer.metas(), proximos: ctx.calendario.proximos(), permisosFaltantes: twitch.permisosExtraFaltantes() };
  },
  'POST /api/crecer/radar': async () => { necesitaCtx(); return (await ctx.crecer.revisarRadar()) ?? { mensaje: 'El radar funciona cuando estás en vivo y con categoría' }; },
  'POST /api/crecer/titulo': async ({ cuerpo }) => {
    necesitaCtx();
    if (cuerpo.nuevo) return ctx.crecer.sugerirTituloYEtiquetas();
    const s = ctx.crecer.estado().sugerencia;
    if (!s) throw new Error('No hay título sugerido ahorita');
    if (cuerpo.usar) {
      await twitch.cambiarCanal(ctx.canal.id, { titulo: s.titulo, etiquetas: s.etiquetas });
      await ctx.datos.refrescar();
      yt.ultimoTitulo = 0;
      await sincronizarTituloYoutube(s.titulo);
      log('Título y etiquetas sugeridos aplicados desde la app');
    }
    ctx.crecer.descartarSugerencia();
    return { ok: true };
  },
  'GET /api/crecer/raid': async () => { necesitaCtx(); return ctx.crecer.sugerirRaid(); },
  'POST /api/crecer/raid': async ({ cuerpo }) => {
    necesitaCtx();
    if (!ctx.datos.actual().enVivo) throw new Error('Solo puedes raidear mientras estás en vivo');
    await ctx.crecer.raidear(String(cuerpo.id));
    return { ok: true, mensaje: 'Raid en camino: Twitch cuenta 90 segundos y manda a tu gente. Después ya puedes terminar el directo en la PS5.' };
  },
  'POST /api/crecer/tiktok': ({ cuerpo }) => { necesitaCtx(); return ctx.crecer.anotarTikTok(cuerpo.total); },
  'GET /api/crecer/reporte': () => { necesitaCtx(); return ctx.crecer.reporteSemanal(); },
  'POST /api/crecer/programar': () => { necesitaCtx(); ctx.calendario.programar(); return { proximos: ctx.calendario.proximos() }; },
  'GET /api/reporte': () => reporte({ canal: ctx?.canal.display_name ?? '(sin sesión)', enVivo: ctx?.datos.actual().enVivo ?? false, cuotaYoutube: youtube.cuotaUsada() }),
  'POST /api/probar': async () => {
    necesitaCtx();
    return probarTodo({ leerConfig, canalId: ctx.canal.id });
  },
  'POST /api/actualizar': async ({ res }) => {
    const v = await revisarVersion(true);
    if (v.error) throw new Error(v.error);
    if (!v.hayNueva) return { ok: true, mensaje: `Ya tienes la versión más nueva (${VERSION}).` };
    const nueva = await actualizar();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mensaje: `Actualizado a ${nueva}. El Centro se reinicia; recarga la app en 20 segundos.` }));
    setTimeout(() => process.exit(0), 1500); // iniciar-centro.bat lo vuelve a abrir
    return undefined;
  },
};

const paginasLocales = {
  '/twitch': () => ({ redirigir: twitch.urlLogin() }),
  '/callback': async ({ url }) => {
    const code = url.searchParams.get('code');
    if (!code) return { html: '❌ Twitch no dio permiso. Cierra esta pestaña e inténtalo otra vez.' };
    await twitch.canjearCodigo(code);
    log('Sesión de Twitch guardada');
    if (ctx) {
      marcar('twitch', 'ok', 'Permisos de Twitch actualizados');
      // Los avisos de seguidores nuevos se activan al reconectar: reiniciamos si no estás en vivo.
      if (!ctx.datos.actual().enVivo) {
        setTimeout(() => process.exit(0), 2000); // iniciar-centro.bat lo vuelve a abrir solo
        return { html: '✅ Listo, permisos de Twitch actualizados. El Centro se reinicia solo en unos segundos. Puedes cerrar esta pestaña.' };
      }
      return { html: '✅ Listo, permisos de Twitch actualizados. Los avisos de seguidores nuevos se activan la próxima vez que se reinicie el Centro.' };
    }
    iniciar().catch((e) => marcar('twitch', 'error', 'No pude iniciar', e.message));
    return { html: '✅ Listo, ya iniciaste sesión en Twitch. Puedes cerrar esta pestaña.' };
  },
  '/youtube': () => (youtube.configurado()
    ? { redirigir: youtube.urlLogin() }
    : { html: '❌ Primero pon GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en claves.txt y reinicia el Centro.' }),
  '/google/callback': async ({ url }) => {
    const code = url.searchParams.get('code');
    if (!code) return { html: '❌ Google no dio permiso. Cierra esta pestaña e inténtalo otra vez.' };
    await youtube.canjearCodigo(code);
    const c = await youtube.miCanal();
    marcar('youtube', 'ok', `Conectado al canal "${c.nombre}"`);
    if (ctx?.datos.actual().enVivo) iniciarYoutube();
    return { html: `✅ Listo, YouTube conectado al canal <b>${c.nombre}</b>. Puedes cerrar esta pestaña.` };
  },
};

await iniciarServidor({ pin: PIN, rutas, paginasLocales });
console.log(`📱 App del celular: ${urlApp()}  ·  PIN: ${PIN}`); // el PIN solo en pantalla, nunca en la bitácora
log(`🔔 Avisos: en la app ntfy suscríbete al tema ${ajustes().temaAvisos}`);
if (youtube.configurado() && youtube.tieneSesion()) marcar('youtube', 'ok', 'Sesión guardada');
else if (youtube.configurado()) marcar('youtube', 'aviso', 'Falta autorizar YouTube: abre http://localhost:3000/youtube en la PC');
else marcar('youtube', 'apagado', 'Sin configurar');
if (leerConfig().iaLocal?.activa) marcar('iaLocal', 'aviso', 'Lista para entrar si Gemini falla');
else marcar('iaLocal', 'apagado', 'Desactivada');

if (twitch.tieneSesion()) {
  iniciar().catch((e) => marcar('twitch', 'error', 'No pude iniciar con Twitch', e.message));
} else {
  marcar('twitch', 'aviso', 'Primera vez: abre http://localhost:3000/twitch en el navegador de esta PC');
}

process.on('unhandledRejection', (e) => log('⚠️ Error no esperado: ' + (e?.message ?? e), { nivel: 'error', detalle: e?.stack }));
process.on('uncaughtException', (e) => log('⚠️ Error no esperado: ' + e.message, { nivel: 'error', detalle: e.stack }));

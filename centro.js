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
import { crearResumen } from './resumen.js';
import { crearEditor } from './editor.js';
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
import * as kick from './kick.js';
import { crearCandidatos } from './candidatos.js';
import { crearAutopublicar } from './autopublicar.js';
import { iniciarPublico, configurarBase, urlBase } from './publico.js';
import { metaConfigurado, metaPaginas, metaGuardar, metaInfo, destinosListos } from './publicar.js';
import { writeFileSync as escribirArchivo } from 'node:fs';

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
  if (!hechas.includes('mejor-7')) {
    // El "mejor momento del rato" ahora pide al menos 7/10 (antes 5): menos clips flojos de pura exploración.
    if (c.momentos && (c.momentos.minimoMejorMomento ?? 5) === 5) c.momentos.minimoMejorMomento = 7;
    writeFileSync(ruta, JSON.stringify(c, null, 2) + '\n');
    guardarAjustes({ migraciones: [...(ajustes().migraciones ?? hechas), 'mejor-7'] });
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
let nombreTailscale = ''; // p. ej. tu-pc.tail1234.ts.net (para la dirección pública de los avisos de Kick)
// En "tailscale funnel status", ¿hay un bloque https://<pc> (sin :puerto) que mande al 3001?
export function funnelEn443(texto, nombre) {
  let bloque = null;
  for (const linea of String(texto).split(/\r?\n/)) {
    const m = linea.match(/^https:\/\/(\S+?)\/?(\s|$)/);
    if (m) { bloque = m[1] === nombre; continue; }
    if (bloque && /127\.0\.0\.1:3001|localhost:3001/.test(linea)) return true;
  }
  return false;
}
let funnel443 = false; // ¿Funnel también está en el puerto normal (443)? Algunos servicios lo prefieren
function detectarUrl() {
  for (const exe of ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe']) {
    const r = spawnSync(exe, ['status', '--json'], { windowsHide: true, timeout: 8000 });
    if (r.status !== 0) continue;
    try {
      const yo = JSON.parse(r.stdout.toString()).Self;
      const nombre = (yo?.DNSName ?? '').replace(/\.$/, '');
      nombreTailscale = nombre;
      const servido = spawnSync(exe, ['serve', 'status'], { windowsHide: true, timeout: 8000 }).stdout?.toString() ?? '';
      const funnel = spawnSync(exe, ['funnel', 'status'], { windowsHide: true, timeout: 8000 }).stdout?.toString() ?? '';
      funnel443 = funnelEn443(funnel, nombre);
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

async function iniciarYoutube({ reanudar = false } = {}) {
  if (yt.directo) return;
  if (!ajustes().envioYoutube) return marcar('envioYoutube', 'apagado', 'Envío a YouTube apagado desde la app');
  if (!youtube.configurado()) return marcar('youtube', 'apagado', 'Falta configurar Google en claves.txt');
  if (!youtube.tieneSesion()) return marcar('youtube', 'aviso', 'Falta autorizar YouTube en http://localhost:3000/youtube (desde la PC)');
  const d = ctx.datos.actual();
  try {
    const stream = await youtube.asegurarStream();
    // Si el Centro se reinició a media transmisión, retomamos el mismo directo de YouTube.
    const previo = reanudar ? await youtube.directoActivo().catch(() => null) : null;
    if (previo) log('🔄 Retomo el mismo directo de YouTube');
    yt.directo = previo ?? await youtube.crearDirecto({
      titulo: d.titulo || `Jugando ${d.juego} en PS5`,
      descripcion: `🎮 ${d.juego} en vivo desde la PS5.\n\nJuego: ${d.juego}\nHorario: ${d.horario}`,
      streamId: stream.id,
    });
    marcar('youtube', 'ok', previo ? 'Directo de YouTube retomado' : 'Directo creado en YouTube');
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

// ---------- Kick ----------
// Igual que YouTube: la PC toma tu directo de Twitch y lo reenvía a Kick. Con la sesión de Kick
// además pone tu mismo título y juego, y el bot platica en el chat de Kick.
const kk = { activo: false, relevo: null, revision: null, canal: null, tituloPuesto: '', juegoPuesto: '', ultimaFalla: 0 };
const PUERTO_AVISOS_KICK = () => leerConfig().kick?.puertoAvisos ?? 3001;
const urlAvisosKick = () => (nombreTailscale ? `https://${nombreTailscale}:8443/kick/eventos` : '(instala Tailscale en la PC)');

async function canalKick() {
  if (!kk.canal) kk.canal = await kick.miCanal();
  return kk.canal;
}

async function iniciarKick() {
  if (kk.activo) return;
  if (ajustes().envioKick === false) return marcar('envioKick', 'apagado', 'Envío a Kick apagado desde la app');
  if (!kick.envioConfigurado()) return marcar('envioKick', 'apagado', 'Sin configurar (falta la clave de transmisión de Kick en claves.txt)');
  kk.activo = true;
  let fallas = 0;
  const lanzar = () => {
    kk.relevo = lanzarDesdeTwitch({
      config: leerConfig(),
      canal: ctx.canal.login,
      calidad: 'best',
      argsSalida: ['-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-f', 'flv', '-flvflags', 'no_duration_filesize', kick.urlEnvio()],
      alError: (m) => marcar('envioKick', 'error', m),
      alTerminar: (codigo, errores) => {
        if (!kk.activo) return;
        fallas++;
        kk.ultimaFalla = Date.now();
        const espera = Math.min(60, 5 * fallas);
        if (fallas >= 2) marcar('envioKick', fallas >= 3 ? 'error' : 'aviso', `Se cortó el envío a Kick; reintento en ${espera} s`, errores || `código ${codigo}`);
        setTimeout(() => kk.activo && lanzar(), espera * 1000);
      },
    });
    if (fallas === 0) marcar('envioKick', 'aviso', 'Enviando señal a Kick… (confirmando)');
  };
  lanzar();
  setTimeout(revisarKick, 45_000);
  kk.revision = setInterval(revisarKick, 120_000);
}

// Cada 2 min: ¿Kick ya te ve en vivo? ¿Cambiaste de título o de juego en Twitch? Se copia a Kick.
async function revisarKick() {
  if (!kk.activo) return;
  if (!kick.tieneSesion()) {
    if (kk.relevo && Date.now() - kk.ultimaFalla > 3 * 60_000) marcar('envioKick', 'ok', 'Enviando a Kick (autoriza Kick en la PC para confirmar y poner tu título)');
    return;
  }
  try {
    const c = await kick.miCanal();
    kk.canal = { ...kk.canal, ...c };
    if (c.enVivo) marcar('envioKick', 'ok', `En vivo en Kick${c.espectadores ? ` · ${c.espectadores} viendo` : ''}`);
    const d = ctx.datos.actual();
    const cambios = {};
    if (d.titulo && d.titulo !== kk.tituloPuesto) cambios.titulo = d.titulo;
    if (d.juego && d.juego !== kk.juegoPuesto) {
      const cat = await kick.buscarCategoria(d.juego).catch(() => null);
      if (cat?.id) cambios.categoriaId = cat.id;
      else if (kk.juegoPuesto !== d.juego) log(`Kick no tiene la categoría "${d.juego}"; dejo la que estaba`);
      kk.juegoPuesto = d.juego;
    }
    if (Object.keys(cambios).length) {
      await kick.cambiarCanal(cambios);
      if (cambios.titulo) kk.tituloPuesto = cambios.titulo;
      log(`Kick: ${[cambios.titulo && 'título', cambios.categoriaId && 'juego'].filter(Boolean).join(' y ')} igual que en Twitch`);
    }
    marcar('kick', 'ok', `Canal kick.com/${c.slug}`);
  } catch (e) {
    marcar('kick', 'aviso', 'No pude leer tu canal de Kick', e.message);
  }
}

async function detenerKick() {
  const estaba = kk.activo;
  kk.activo = false;
  clearInterval(kk.revision);
  kk.relevo?.detener();
  kk.relevo = null;
  kk.tituloPuesto = '';
  kk.juegoPuesto = '';
  if (estaba || kick.envioConfigurado()) marcar('envioKick', 'apagado', 'Sin directo');
}

// Sesión de Kick lista: datos del canal y aviso de mensajes del chat.
async function prepararKick() {
  if (!kick.configurado()) return marcar('kick', 'apagado', 'Sin configurar');
  if (!kick.tieneSesion()) return marcar('kick', 'aviso', 'Falta autorizar Kick: abre http://localhost:3000/kick en la PC');
  try {
    const c = await canalKick();
    marcar('kick', 'ok', `Canal kick.com/${c.slug}`);
  } catch (e) {
    return marcar('kick', 'aviso', 'No pude leer tu canal de Kick', e.message);
  }
  try {
    await kick.suscribirChat();
    marcar('chatKick', 'aviso', 'Esperando el primer mensaje del chat de Kick');
  } catch (e) {
    marcar('chatKick', 'aviso', 'Kick no aceptó avisarme del chat (revisa la dirección de webhooks de tu app de Kick)', e.message);
  }
}

// ---------- Inicio y fin del directo ----------
let inicioDirecto = null;

async function alEmpezar() {
  const d = ctx.datos.actual();
  // ¿El directo ya llevaba rato? Entonces el Centro se reinició a media transmisión (actualización o falla):
  // retomamos todo sin repetir anuncios ni crear otro directo en YouTube.
  const reanudar = Boolean(d.inicio) && Date.now() - new Date(d.inicio).getTime() > 4 * 60_000;
  inicioDirecto = reanudar ? new Date(d.inicio).getTime() : Date.now();
  marcar('directo', 'ok', `En vivo: ${d.juego}`);
  if (reanudar) {
    log('🔄 El Centro se reinició a media transmisión: retomo todo sin repetir anuncios');
    ctx.momentos.retomar();
    ctx.auto.alReanudar();
    ctx.captura.iniciar();
    await iniciarYoutube({ reanudar: true });
    iniciarKick().catch((e) => marcar('envioKick', 'error', 'No pude iniciar el envío a Kick', e.message));
    ctx.crecer.alEmpezar({ reanudar: true }).catch(() => {});
    setTimeout(() => {
      const p = Object.fromEntries(verPartes().map((x) => [x.id, x.estado]));
      const s = (e) => (e === 'ok' ? '✅' : e === 'apagado' ? '⚪' : '⚠️');
      avisar('🔄 Centro reiniciado, sigues en vivo', `Twitch ✅ · YouTube ${s(p.envioYoutube)}${kick.envioConfigurado() ? ` · Kick ${s(p.envioKick)}` : ''} · Bot ${s(p.chatTwitch)} · Vista ${s(p.captura)}`, { etiquetas: ['arrows_counterclockwise'], abrir: urlApp(), clave: 'reanudado', cadaMinutos: 10 });
    }, 60_000);
    return;
  }
  ctx.bots.twitch.nuevoDirecto();
  ctx.bots.youtube.nuevoDirecto();
  // v5: si te reconectas antes de que se publique lo del directo anterior, es el mismo directo.
  const continuar = ctx.auto.activo() ? ctx.auto.alEmpezar() : false;
  if (!continuar) ctx.momentos.nuevoDirecto();
  ctx.captura.iniciar();
  ctx.crecer.alEmpezar().catch((e) => log('⚠️ Crecer: ' + e.message, { nivel: 'aviso' }));
  ctx.bots.kick.nuevoDirecto();
  await iniciarYoutube();
  iniciarKick().catch((e) => marcar('envioKick', 'error', 'No pude iniciar el envío a Kick', e.message));
  ctx.promos.alEmpezar().catch(() => {});
  // Al minuto y medio, un resumen de cómo arrancó todo.
  setTimeout(() => {
    if (!ctx.datos.actual().enVivo) return;
    const p = Object.fromEntries(verPartes().map((x) => [x.id, x.estado]));
    const s = (e) => (e === 'ok' ? '✅' : e === 'apagado' ? '⚪' : '⚠️');
    avisar('🔴 Estás en vivo', `Twitch ✅ · YouTube ${s(p.envioYoutube)}${kick.envioConfigurado() ? ` · Kick ${s(p.envioKick)}` : ''} · Bot ${s(p.chatTwitch)} · Vista ${s(p.captura)}\n${ctx.datos.actual().juego}`, {
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
  await detenerKick();
  avisar('⚫ Terminó tu directo', `Duró ${minutos} min. Preparando el resumen…`, { etiquetas: ['black_circle'], clave: 'fin', cadaMinutos: 30 });
  await ctx.crecer.alTerminar().catch((e) => log('⚠️ Crecer: ' + e.message, { nivel: 'aviso' }));
  if (minutos >= 5) ctx.promos.alTerminar({ minutos }).catch(() => {});
  // v5: en 1 hora (si no vuelves a transmitir), Claude elige los mejores momentos y se publican solos.
  if (ctx.auto.activo()) ctx.auto.alTerminar({ minutos });
  // Sin piloto automático: a los 3 min el video resumen, y los clips se reparten en los próximos días.
  else setTimeout(async () => {
    if (minutos >= 10) await ctx.resumen.armar({ minutos }).catch((e) => log('No pude armar el video resumen: ' + e.message, { nivel: 'aviso' }));
    ctx.calendario.programar();
    ctx.calendario.revisar().catch(() => {});
  }, 180_000);
  if (directoYt && minutos >= 5) {
    setTimeout(() => arreglarVideoYoutube(directoYt, { juego: d.juego, titulo: d.titulo, minutos })
      .catch((e) => log('No pude ponerle descripción al video de YouTube: ' + e.message, { nivel: 'aviso' })), 120_000);
  }
}

// Bots de otros servicios que escriben en tu chat: el Centro no les contesta ni los cuenta para clips.
const BOTS = ['kickbot', 'botrix', 'streamelements', 'nightbot', 'moobot', 'streamlabs', 'fossabot', 'wizebot', 'soundalerts', 'sery_bot', 'kofistreambot', 'botrixoficial', 'commanderroot', 'pokemoncommunitygame', 'own3d', 'tangiabot', 'blerp', 'lumiastream', 'creatisbot', 'frostytoolsdotcom'];
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
    kick: crearBot({
      plataforma: 'kick', datos: ctx.datos, verPantalla, animarChat: () => kk.activo && kick.tieneSesion() && leerConfig().kick?.animarChat !== false,
      // Solo escribe en Kick si de verdad estás transmitiendo ahí (si no, nadie lo vería).
      enviar: async (texto) => { if (kk.activo && kick.tieneSesion()) await kick.enviarChat((await canalKick()).id, texto); },
    }),
  };
  ctx.candidatos = crearCandidatos({
    captura: ctx.captura, leerConfig, datos: ctx.datos, canalLogin: canal.login,
    momentos: { piezas: () => ctx.momentos.piezas(), destacados: () => ctx.momentos.destacados() },
  });
  ctx.clips = crearClips({
    candidatos: ctx.candidatos,
    captura: ctx.captura, leerConfig, datos: ctx.datos, avisar, urlApp,
    crearClipTwitch: () => twitch.crearClip(canal.id), canalLogin: canal.login,
  });
  ctx.momentos = crearMomentos({ captura: ctx.captura, leerConfig, datos: ctx.datos, clips: ctx.clips });
  ctx.calendario = crearCalendario({ leerConfig, avisar, urlApp, enVivo: () => ctx.datos.actual().enVivo });
  ctx.crecer = crearCrecer({ canal, datos: ctx.datos, leerConfig, avisar, urlApp });
  ctx.editor = crearEditor({ leerConfig, clips: ctx.clips, avisar, urlApp, canalLogin: canal.login });
  ctx.resumen = crearResumen({ leerConfig, datos: ctx.datos, avisar, urlApp, canalLogin: canal.login, momentos: ctx.momentos });
  ctx.promos = crearPromos({ datos: ctx.datos, avisar, urlApp, urlTwitch: () => `https://twitch.tv/${canal.login}` });
  ctx.auto = crearAutopublicar({ leerConfig, candidatos: ctx.candidatos, resumen: ctx.resumen, avisar, urlApp, enVivo: () => ctx.datos.actual().enVivo });
  // Si el Centro se reinició mientras esperaba para publicar, recupera los pedacitos del resumen.
  if (ctx.auto.hayPendiente()) ctx.momentos.retomar();

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

  prepararKick().catch(() => {});
}

// Mensajes del chat de Kick (llegan como avisos firmados por Kick).
function alMensajeKick(ev) {
  if (!ctx) return;
  const texto = kick.limpiarTexto(ev.content);
  const nombre = ev.sender?.username ?? 'alguien';
  const esMio = Boolean(kk.canal?.id) && String(ev.sender?.user_id) === String(kk.canal.id);
  if (!texto) return;
  marcar('chatKick', 'ok', 'Leyendo el chat de Kick');
  if (!esMio && esBotConocido(nombre)) return;
  if (!esMio) ctx.clips.registrarMensaje({ nombre, texto, plataforma: 'kick' });
  ctx.bots.kick.recibir({ usuarioId: ev.sender?.user_id ?? nombre, nombre, texto, esMio }).catch(() => {});
}

// ---------- Rutas de la app ----------
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let metaUltimas = null; // Páginas encontradas al conectar Meta (solo un momento, en memoria)
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
      kick: { activo: kk.activo, envio: ajustes().envioKick !== false, configurado: kick.envioConfigurado(), sesion: kick.tieneSesion(), canal: kk.canal?.slug ?? null },
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
    const destinos = cuerpo.plataforma === 'todas' ? ['twitch', 'youtube', 'kick'] : [cuerpo.plataforma];
    for (const p of destinos) {
      if (p === 'twitch') await twitch.enviarMensaje({ canalId: ctx.canal.id, emisorId: ctx.yo.id, texto });
      if (p === 'youtube' && yt.directo) {
        await youtube.enviarChat(yt.directo.chatId, texto); // regresa por el chat y se registra como tuyo
      }
      if (p === 'kick' && kk.activo && kick.tieneSesion()) {
        await kick.enviarChat((await canalKick()).id, texto); // regresa por el aviso de Kick y se registra como tuyo
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
  'POST /api/categoria/correcta': () => { necesitaCtx(); ctx.datos.confirmarCategoria(); return { ok: true }; },
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
  'POST /api/kick': async ({ cuerpo }) => {
    guardarAjustes({ envioKick: Boolean(cuerpo.envio) });
    if (!cuerpo.envio) await detenerKick();
    else if (ctx?.datos.actual().enVivo) await iniciarKick();
    return { ok: true };
  },
  'GET /api/bandeja': () => bandeja.lista(),
  // v5: lo que viene (cola de publicaciones) y qué redes están conectadas.
  'GET /api/publicaciones': () => {
    if (!ctx) return { sinSesion: true };
    return { cola: ctx.auto.cola(), pendiente: ctx.auto.pendiente(), destinos: destinosListos(leerConfig()), candidatos: ctx.candidatos.cuantos(), reserva: ctx.candidatos.reserva(), activo: ctx.auto.activo() };
  },
  'POST /api/publicar': ({ cuerpo }) => {
    necesitaCtx();
    const item = bandeja.lista().find((x) => x.id === cuerpo.id);
    if (!item || item.tipo !== 'clip') throw new Error('No encontré ese video');
    ctx.auto.publicarAhora(item);
    return { ok: true, mensaje: 'Listo: se está publicando en tus redes. Te aviso cuando termine.' };
  },
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
  // Subir un video propio (por ejemplo, de la PS App): llega el archivo tal cual, sin JSON.
  'POST /api/subir': Object.assign(async ({ req, url }) => {
    necesitaCtx();
    const id = await ctx.editor.recibir(req, { nota: url.searchParams.get('nota') ?? '', nombre: url.searchParams.get('nombre') ?? '', frase: url.searchParams.get('frase') ?? '' });
    return { ok: true, id, mensaje: 'Video recibido. Lo estoy editando; te aviso cuando esté listo (1 a 3 minutos).' };
  }, { crudo: true }),
  'POST /api/clip/frase': async ({ cuerpo }) => {
    necesitaCtx();
    await ctx.editor.cambiarFrase(String(cuerpo.id ?? ''), String(cuerpo.frase ?? ''));
    return { ok: true, mensaje: cuerpo.frase ? 'Poniendo tu frase; te aviso cuando esté (1 a 2 min).' : 'Pidiendo otra frase a la IA; te aviso cuando esté (1 a 2 min).' };
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
  // Conectar tu Página de Facebook (y su Instagram) para publicar Reels solo. El token se pega aquí, en la PC.
  '/meta': async ({ req, cuerpo }) => {
    if (!metaConfigurado()) return { html: '❌ Primero pon META_APP_ID y META_APP_SECRET en claves.txt y reinicia el Centro.' };
    // Solo formularios enviados desde esta misma página (ninguna otra web puede mandarlos por ti).
    const sitio = req.headers['sec-fetch-site'];
    if (req.method === 'POST' && sitio && !['same-origin', 'none'].includes(sitio)) return { html: '❌ Petición rechazada.' };
    if (req.method === 'POST' && cuerpo.pagina) {
      const pagina = (metaUltimas ?? []).find((p) => p.id === cuerpo.pagina);
      if (!pagina) return { html: '❌ Se perdió la lista de Páginas; vuelve a abrir http://localhost:3000/meta.' };
      const info = metaGuardar(pagina);
      metaUltimas = null;
      marcar('publicar', 'ok', `Listo para publicar en: ${destinosListos(leerConfig()).join(', ')}`);
      return { html: `✅ Listo: publicaré en la Página <b>${info.pagina}</b>${info.instagram ? ` y en Instagram <b>@${info.instagram}</b>` : ' (sin Instagram: vincúlalo a la Página y repite este paso)'}. Puedes cerrar esta pestaña.` };
    }
    if (req.method === 'POST' && cuerpo.token) {
      metaUltimas = await metaPaginas(String(cuerpo.token));
      if (!metaUltimas.length) return { html: '❌ Ese token no tiene Páginas. Revisa que hayas elegido la Página al generar el token.' };
      return { html: `<h3>¿Cuál es la Página de tus directos?</h3><form method="post">${metaUltimas.map((p, i) => `<label style="display:block;margin:12px 0"><input type="radio" name="pagina" value="${esc(p.id)}" ${i ? '' : 'checked'}> <b>${esc(p.nombre)}</b> ${p.ig ? `· Instagram @${esc(p.ig.username)}` : '· (sin Instagram vinculado)'}</label>`).join('')}<button style="font-size:19px;padding:10px 20px">Usar esta Página</button></form>` };
    }
    const actual = metaInfo();
    return { html: `<h3>Conectar Facebook e Instagram de los directos</h3>${actual ? `<p>Ahora: Página <b>${actual.pagina}</b>${actual.instagram ? ` · Instagram @${actual.instagram}` : ''}</p>` : ''}
<p>Pega aquí el token que generaste en el Explorador de la API de Meta (empieza con EAA…). No se muestra a nadie: se queda en tu PC.</p>
<form method="post"><input name="token" type="password" style="width:100%;font-size:18px;padding:10px" autocomplete="off"><br><br><button style="font-size:19px;padding:10px 20px">Conectar</button></form>` };
  },
  '/kick/ayuda': () => ({ html: `<h3>Kick · direcciones para tu app de desarrollador</h3>
<p><b>Redirect URL:</b> <code>${kick.URL_CALLBACK}</code></p>
<p><b>Webhook URL:</b> <code>${urlAvisosKick()}</code></p>
<p>Para que Kick pueda avisar los mensajes del chat, en esta PC abre PowerShell y corre una sola vez:<br><code>tailscale funnel --bg --https=8443 ${PUERTO_AVISOS_KICK()}</code></p>` }),
  '/kick': () => (kick.configurado()
    ? { redirigir: kick.urlLogin() }
    : { html: `<h3>Kick todavía no está configurado</h3><p>Al crear tu app en <b>kick.com → Configuración → Desarrollador</b> usa estas direcciones:</p>
<p><b>Redirect URL:</b> <code>${kick.URL_CALLBACK}</code><br><b>Webhook URL:</b> <code>${urlAvisosKick()}</code></p>
<p>Luego pon KICK_CLIENT_ID y KICK_CLIENT_SECRET en claves.txt y reinicia el Centro.</p>` }),
  '/kick/callback': async ({ url }) => {
    const code = url.searchParams.get('code');
    if (!code) return { html: '❌ Kick no dio permiso. Cierra esta pestaña e inténtalo otra vez.' };
    await kick.canjearCodigo(code, url.searchParams.get('state'));
    kk.canal = null;
    const c = await canalKick();
    marcar('kick', 'ok', `Canal kick.com/${c.slug}`);
    prepararKick().catch(() => {});
    return { html: `✅ Listo, Kick conectado al canal <b>kick.com/${c.slug}</b>. Puedes cerrar esta pestaña.` };
  },
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
if (kick.envioConfigurado()) marcar('envioKick', 'apagado', 'Arranca solo cuando sales en vivo');
else marcar('envioKick', 'apagado', 'Sin configurar');
if (!kick.configurado()) marcar('kick', 'apagado', 'Sin configurar');
else if (!kick.tieneSesion()) marcar('kick', 'aviso', 'Falta autorizar Kick: abre http://localhost:3000/kick en la PC');
// Puerto 3001 (público por Funnel): avisos de Kick y videos para que Buffer/Meta/Upload-Post los descarguen.
configurarBase(() => leerConfig().autoPublicar?.urlPublica || (nombreTailscale ? `https://${nombreTailscale}${funnel443 ? '' : ':8443'}` : ''));
iniciarPublico({ puerto: PUERTO_AVISOS_KICK(), alAvisoKick: kick.configurado() ? kick.manejadorAvisos({ alMensaje: alMensajeKick }) : null });
if (destinosListos(leerConfig()).length) marcar('publicar', 'ok', `Listo para publicar en: ${destinosListos(leerConfig()).join(', ')}`);
else marcar('publicar', 'apagado', 'Sin redes conectadas (los videos quedan en Publicar para subirlos tú)');
if (leerConfig().iaLocal?.activa) marcar('iaLocal', 'aviso', 'Lista para entrar si Gemini falla');
else marcar('iaLocal', 'apagado', 'Desactivada');

// Si la PC arranca sin internet (apagón, Tailscale reacomodándose), reintenta solo hasta lograrlo.
let intentosInicio = 0;
function iniciarConReintento() {
  iniciar().catch((e) => {
    intentosInicio++;
    const seg = Math.min(300, 15 * intentosInicio);
    marcar('twitch', 'error', `No pude iniciar con Twitch; reintento en ${seg} s`, e.message);
    if (!ctx) setTimeout(iniciarConReintento, seg * 1000);
  });
}
if (twitch.tieneSesion()) {
  iniciarConReintento();
} else {
  marcar('twitch', 'aviso', 'Primera vez: abre http://localhost:3000/twitch en el navegador de esta PC');
}

// Para los accesos directos del escritorio (Reiniciar / Detener).
try { escribirArchivo(new URL('./centro.pid', import.meta.url), String(process.pid)); } catch { /* sin permiso: no pasa nada */ }

process.on('unhandledRejection', (e) => log('⚠️ Error no esperado: ' + (e?.message ?? e), { nivel: 'error', detalle: e?.stack }));
process.on('uncaughtException', (e) => log('⚠️ Error no esperado: ' + e.message, { nivel: 'error', detalle: e.stack }));

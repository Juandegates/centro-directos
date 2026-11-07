// Estado central del Centro: semáforo por parte, bitácora de eventos y reporte de diagnóstico.
import { readFileSync, appendFileSync, mkdirSync, statSync, copyFileSync, writeFileSync } from 'node:fs';
import { release, totalmem, freemem, cpus } from 'node:os';
import { ajustes } from './ajustes.js';

export const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

// Partes que se muestran en el autodiagnóstico, en este orden.
export const PARTES = {
  twitch: 'Sesión de Twitch',
  chatTwitch: 'Chat de Twitch',
  directo: 'Directo (PS5 → Twitch)',
  youtube: 'Cuenta de YouTube',
  envioYoutube: 'Envío a YouTube',
  chatYoutube: 'Chat de YouTube',
  kick: 'Cuenta de Kick',
  envioKick: 'Envío a Kick',
  chatKick: 'Chat de Kick',
  ia: 'IA en la nube (Gemini y Groq)',
  iaLocal: 'IA de respaldo (PC)',
  captura: 'Vista de pantalla',
  clips: 'Clips',
  claude: 'Claude (elige y revisa videos)',
  publicar: 'Publicación automática',
  avisos: 'Avisos al celular',
  internet: 'Internet de la PC',
};

const partes = Object.fromEntries(Object.keys(PARTES).map((k) => [k, { estado: 'apagado', mensaje: 'Sin iniciar', hora: null, ultimoError: null }]));
const bitacora = []; // { hora, nivel, parte, texto, detalle }
const oyentes = new Set();

const hora = () => new Date().toLocaleTimeString('es-MX', { hour12: false });

// La bitácora también se guarda en logs/centro.log (para verla con el acceso directo del escritorio).
const LOG = new URL('./logs/centro.log', import.meta.url);
try { mkdirSync(new URL('./logs/', import.meta.url), { recursive: true }); } catch { /* sin permiso */ }
function aArchivo(linea) {
  try {
    // Se copia y se vacía (no se renombra): así funciona aunque la ventana de la bitácora esté abierta.
    if (statSync(LOG).size > 5 * 1024 ** 2) { copyFileSync(LOG, new URL('./logs/centro-anterior.log', import.meta.url)); writeFileSync(LOG, ''); }
  } catch { /* todavía no existe */ }
  try { appendFileSync(LOG, linea + '\n'); } catch { /* disco lleno o en uso */ }
}

export function log(texto, { parte = null, nivel = 'info', detalle = null } = {}) {
  console.log(`[${hora()}] ${texto}`);
  aArchivo(`[${new Date().toLocaleString('es-MX', { hour12: false })}] ${limpiar(texto)}`);
  bitacora.push({ hora: new Date().toISOString(), nivel, parte, texto, detalle: detalle ? String(detalle).slice(0, 2000) : null });
  if (bitacora.length > 300) bitacora.shift();
}

// estado: 'ok' | 'aviso' | 'error' | 'apagado'
export function marcar(parte, estado, mensaje, detalle = null) {
  const p = partes[parte];
  if (!p) return;
  // Nunca guardar claves en lo que se muestra en la app (por ejemplo, la clave de transmisión en un error de FFmpeg).
  mensaje = limpiar(mensaje);
  if (detalle) detalle = limpiar(detalle);
  const cambio = p.estado !== estado || p.mensaje !== mensaje;
  const anterior = p.estado;
  p.estado = estado;
  p.mensaje = mensaje;
  p.hora = new Date().toISOString();
  if (estado === 'error' || estado === 'aviso') {
    p.ultimoError = { hora: p.hora, mensaje, detalle: detalle ? String(detalle).slice(0, 2000) : null };
  }
  if (cambio) {
    log(`${icono(estado)} ${PARTES[parte]}: ${mensaje}`, { parte, nivel: estado === 'error' ? 'error' : estado === 'aviso' ? 'aviso' : 'info', detalle });
    for (const fn of oyentes) fn({ parte, anterior, estado, mensaje, detalle });
  }
}

export const alCambiar = (fn) => oyentes.add(fn);
export const icono = (e) => ({ ok: '✅', aviso: '⚠️', error: '❌', apagado: '⚪' })[e] ?? '•';
export const verPartes = () => Object.entries(partes).map(([id, p]) => ({ id, nombre: PARTES[id], ...p }));
export const verBitacora = (n = 100) => bitacora.slice(-n);

// Quita cualquier clave secreta de un texto antes de mostrarlo o copiarlo.
const SECRETOS = ['GEMINI_API_KEY', 'MISTRAL_API_KEY', 'GROQ_API_KEY', 'TAVILY_API_KEY', 'TWITCH_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET', 'KICK_CLIENT_SECRET', 'KICK_STREAM_KEY', 'BUFFER_API_KEY', 'UPLOADPOST_API_KEY', 'META_APP_SECRET', 'APP_PIN', 'GITHUB_TOKEN'];
export function limpiar(texto) {
  let t = String(texto ?? '');
  for (const k of SECRETOS) {
    const v = process.env[k];
    if (v && v.length >= 4) t = t.split(v).join(`[${k} oculto]`);
  }
  const pin = ajustes().pin;
  if (pin) t = t.split(pin).join('[PIN oculto]');
  return t.replace(/(access_token|refresh_token|key|streamName|stream_key)=([^&\s"]+)/gi, '$1=[oculto]')
    .replace(/rtmps?:\/\/[^\s"]+/gi, 'rtmp://[oculto]');
}

export function reporte(extra = {}) {
  const lineas = [];
  lineas.push(`REPORTE CENTRO DE DIRECTOS · v${VERSION} · ${new Date().toLocaleString('es-MX')}`);
  lineas.push(`Windows ${release()} · Node ${process.version} · RAM libre ${(freemem() / 2 ** 30).toFixed(1)}/${(totalmem() / 2 ** 30).toFixed(1)} GB · ${cpus()[0]?.model ?? ''}`);
  lineas.push(`Encendido desde hace ${Math.round(process.uptime() / 60)} min`);
  for (const [k, v] of Object.entries(extra)) lineas.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  lineas.push('', '— PARTES —');
  for (const p of verPartes()) {
    lineas.push(`${icono(p.estado)} ${p.nombre}: ${p.mensaje}`);
    if (p.ultimoError) lineas.push(`    último problema (${p.ultimoError.hora}): ${p.ultimoError.mensaje}${p.ultimoError.detalle ? `\n    detalle: ${p.ultimoError.detalle}` : ''}`);
  }
  lineas.push('', '— ÚLTIMOS EVENTOS —');
  for (const b of verBitacora(80)) {
    lineas.push(`${b.hora.slice(11, 19)} [${b.nivel}] ${b.texto}${b.detalle && b.nivel !== 'info' ? ` :: ${b.detalle}` : ''}`);
  }
  return limpiar(lineas.join('\n'));
}

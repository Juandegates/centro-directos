// Estado central del Centro: semáforo por parte, bitácora de eventos y reporte de diagnóstico.
import { readFileSync } from 'node:fs';
import { release, totalmem, freemem, cpus } from 'node:os';

export const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

// Partes que se muestran en el autodiagnóstico, en este orden.
export const PARTES = {
  twitch: 'Sesión de Twitch',
  chatTwitch: 'Chat de Twitch',
  directo: 'Directo (PS5 → Twitch)',
  youtube: 'Cuenta de YouTube',
  envioYoutube: 'Envío a YouTube',
  chatYoutube: 'Chat de YouTube',
  ia: 'IA (Gemini)',
  iaLocal: 'IA de respaldo (PC)',
  captura: 'Vista de pantalla',
  clips: 'Clips',
  avisos: 'Avisos al celular',
  internet: 'Internet de la PC',
};

const partes = Object.fromEntries(Object.keys(PARTES).map((k) => [k, { estado: 'apagado', mensaje: 'Sin iniciar', hora: null, ultimoError: null }]));
const bitacora = []; // { hora, nivel, parte, texto, detalle }
const oyentes = new Set();

const hora = () => new Date().toLocaleTimeString('es-MX', { hour12: false });

export function log(texto, { parte = null, nivel = 'info', detalle = null } = {}) {
  console.log(`[${hora()}] ${texto}`);
  bitacora.push({ hora: new Date().toISOString(), nivel, parte, texto, detalle: detalle ? String(detalle).slice(0, 2000) : null });
  if (bitacora.length > 300) bitacora.shift();
}

// estado: 'ok' | 'aviso' | 'error' | 'apagado'
export function marcar(parte, estado, mensaje, detalle = null) {
  const p = partes[parte];
  if (!p) return;
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
const SECRETOS = ['GEMINI_API_KEY', 'TWITCH_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET', 'APP_PIN', 'GITHUB_TOKEN'];
export function limpiar(texto) {
  let t = String(texto ?? '');
  for (const k of SECRETOS) {
    const v = process.env[k];
    if (v && v.length >= 4) t = t.split(v).join(`[${k} oculto]`);
  }
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

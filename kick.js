// Kick: inicio de sesión (OAuth 2.1 con PKCE), datos del canal, título y categoría, chat,
// y los avisos de mensajes nuevos del chat (webhooks oficiales de Kick, firmados).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, createHash, verify } from 'node:crypto';
import { marcar, log } from './estado.js';

const ARCHIVO_TOKENS = new URL('./kick-tokens.json', import.meta.url);
export const URL_CALLBACK = 'http://localhost:3000/kick/callback';
const API = 'https://api.kick.com/public/';
const ID = 'https://id.kick.com/oauth/';
const PERMISOS = 'user:read channel:read channel:write chat:write events:subscribe';

let tokens = existsSync(ARCHIVO_TOKENS) ? JSON.parse(readFileSync(ARCHIVO_TOKENS, 'utf8')) : null;
let pkce = null; // { verificador, estado } del inicio de sesión en curso

const valor = (k) => {
  const v = process.env[k];
  return v && !v.startsWith('pega_aqui') ? v.trim() : '';
};
export const configurado = () => Boolean(valor('KICK_CLIENT_ID') && valor('KICK_CLIENT_SECRET'));
export const envioConfigurado = () => Boolean(valor('KICK_STREAM_URL') && valor('KICK_STREAM_KEY'));
export const tieneSesion = () => Boolean(tokens?.refresh_token);
// Kick (Amazon IVS) necesita "rtmps://<servidor>:443/app/<clave>". Si el servidor se pegó sin ":443/app", se completa.
export function urlEnvio() {
  let base = valor('KICK_STREAM_URL').trim().replace(/\/+$/, '');
  const m = base.match(/^(rtmps?):\/\/([^/:]+)(:\d+)?(\/.*)?$/i);
  if (m && /live-video\.net$/i.test(m[2]) && !m[4]) base = `rtmps://${m[2]}:443/app`;
  else if (m && /live-video\.net$/i.test(m[2]) && !m[3]) base = `rtmps://${m[2]}:443${m[4]}`;
  return `${base}/${valor('KICK_STREAM_KEY')}`;
}

const base64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function urlLogin() {
  const verificador = base64url(randomBytes(48));
  pkce = { verificador, estado: randomBytes(12).toString('hex') };
  const p = new URLSearchParams({
    client_id: valor('KICK_CLIENT_ID'),
    response_type: 'code',
    redirect_uri: URL_CALLBACK,
    scope: PERMISOS,
    state: pkce.estado,
    code_challenge: base64url(createHash('sha256').update(verificador).digest()),
    code_challenge_method: 'S256',
  });
  return `${ID}authorize?${p}`;
}

async function pedirToken(params) {
  const res = await fetch(ID + 'token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: valor('KICK_CLIENT_ID'), client_secret: valor('KICK_CLIENT_SECRET'), ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) {
    if (params.grant_type === 'refresh_token') marcar('kick', 'error', 'Kick cerró tu sesión: vuelve a autorizar desde la PC (http://localhost:3000/kick)', JSON.stringify(d).slice(0, 300));
    throw new Error(`Kick rechazó el inicio de sesión (${res.status}): ${JSON.stringify(d).slice(0, 300)}`);
  }
  tokens = { ...tokens, ...d, vence: Date.now() + ((Number(d.expires_in) || 3600) - 60) * 1000 };
  writeFileSync(ARCHIVO_TOKENS, JSON.stringify(tokens, null, 2));
}

export async function canjearCodigo(code, estado) {
  if (!pkce || estado !== pkce.estado) throw new Error('El inicio de sesión de Kick caducó; ábrelo otra vez desde http://localhost:3000/kick');
  await pedirToken({ grant_type: 'authorization_code', code, redirect_uri: URL_CALLBACK, code_verifier: pkce.verificador });
  pkce = null;
}

const refrescar = () => pedirToken({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });

async function api(ruta, { metodo = 'GET', cuerpo, version = 'v1' } = {}) {
  if (!tokens) throw new Error('No hay sesión de Kick');
  if (!tokens.vence || Date.now() > tokens.vence) await refrescar();
  for (let intento = 0; intento < 2; intento++) {
    const res = await fetch(`${API}${version}/${ruta}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 && intento === 0) { await refrescar(); continue; }
    const texto = await res.text();
    if (!res.ok) {
      const e = new Error(`Kick ${ruta} → ${res.status}: ${texto.slice(0, 300)}`);
      e.status = res.status;
      throw e;
    }
    return texto ? JSON.parse(texto) : {};
  }
  throw new Error('Kick no aceptó la sesión');
}

const lista = (d) => (Array.isArray(d?.data) ? d.data : Array.isArray(d?.data?.categories) ? d.data.categories : Array.isArray(d?.data?.items) ? d.data.items : d?.data ? [d.data] : []);

// Tu canal: id, nombre, título, categoría y si Kick ya te ve en vivo.
export async function miCanal() {
  const c = lista(await api('channels'))[0];
  if (!c) throw new Error('Kick no devolvió tu canal');
  return {
    id: c.broadcaster_user_id,
    slug: c.slug,
    titulo: c.stream_title ?? '',
    categoria: c.category?.name ?? '',
    enVivo: Boolean(c.stream?.is_live),
    espectadores: Number(c.stream?.viewer_count ?? 0),
  };
}

export const enviarChat = (broadcasterId, texto) =>
  api('chat', { metodo: 'POST', cuerpo: { broadcaster_user_id: broadcasterId, content: String(texto).slice(0, 500), type: 'user' } });

const normal = (t) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['\u2019`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Busca en Kick la categoría con el mismo nombre que el juego de Twitch.
export async function buscarCategoria(nombre) {
  if (!nombre) return null;
  let opciones = [];
  try {
    opciones = lista(await api(`categories?name=${encodeURIComponent(nombre)}&limit=10`, { version: 'v2' }));
  } catch {
    opciones = lista(await api(`categories?q=${encodeURIComponent(nombre)}`));
  }
  const buscado = normal(nombre);
  return opciones.find((c) => normal(c.name) === buscado)
    ?? opciones.find((c) => normal(c.name).startsWith(buscado))
    // "Castlevania" sirve para "Castlevania: Belmont's Curse" si Kick no tiene el nombre completo (el más largo gana).
    ?? opciones.filter((c) => normal(c.name).length >= 4 && buscado.startsWith(normal(c.name) + ' ')).sort((a, b) => b.name.length - a.name.length)[0]
    ?? null;
}

export async function cambiarCanal({ titulo, categoriaId }) {
  const cuerpo = {};
  if (titulo) cuerpo.stream_title = String(titulo).slice(0, 140);
  if (categoriaId) cuerpo.category_id = categoriaId;
  if (!Object.keys(cuerpo).length) return;
  await api('channels', { metodo: 'PATCH', cuerpo });
}

// Pide a Kick que avise cada mensaje del chat a tu dirección de webhooks (la que pusiste en tu app de Kick).
export async function suscribirChat() {
  const actuales = lista(await api('events/subscriptions').catch(() => ({ data: [] })));
  if (actuales.some((s) => (s.event ?? s.name) === 'chat.message.sent')) return 'ya';
  await api('events/subscriptions', { metodo: 'POST', cuerpo: { events: [{ name: 'chat.message.sent', version: 1 }], method: 'webhook' } });
  return 'nueva';
}

// ---------- Avisos de Kick (webhooks) ----------
let llave = null;
async function llavePublica() {
  if (llave) return llave;
  const res = await fetch(`${API}v1/public-key`, { signal: AbortSignal.timeout(10_000) });
  const d = await res.json();
  llave = d?.data?.public_key ?? null;
  if (!llave) throw new Error('Kick no dio su llave pública');
  return llave;
}

// ¿El aviso de verdad viene de Kick? Se firma "id.hora.cuerpo" con su llave (RSA SHA-256).
export function firmaValida({ id, hora, cuerpo, firma }, pem) {
  try {
    return verify('RSA-SHA256', Buffer.concat([Buffer.from(`${id}.${hora}.`), cuerpo]), pem, Buffer.from(String(firma), 'base64'));
  } catch { return false; }
}

// Limpia los emotes de Kick: "[emote:123:Jaja]" → "Jaja".
export const limpiarTexto = (t) => String(t ?? '').replace(/\[emote:\d+:([^\]]+)\]/g, '$1').replace(/\s+/g, ' ').trim();

// Devuelve la función que atiende los avisos de Kick (la usa el servidor público del puerto 3001).
export function manejadorAvisos({ alMensaje }) {
  const vistos = new Set();
  return (req, res) => {
    const trozos = [];
    let largo = 0;
    req.on('data', (c) => { largo += c.length; if (largo > 256 * 1024) req.destroy(); else trozos.push(c); });
    req.on('end', async () => {
      const cuerpo = Buffer.concat(trozos);
      const h = req.headers;
      const datos = { id: h['kick-event-message-id'], hora: h['kick-event-message-timestamp'], cuerpo, firma: h['kick-event-signature'] };
      let ok = false;
      try { ok = Boolean(datos.id && datos.firma) && firmaValida(datos, await llavePublica()); } catch { ok = false; }
      if (!ok) { res.writeHead(401); res.end(); return; }
      res.writeHead(200); res.end();
      if (vistos.has(datos.id)) return; // Kick reintenta si tardamos: no contestamos dos veces
      vistos.add(datos.id);
      if (vistos.size > 500) vistos.delete(vistos.values().next().value);
      if (h['kick-event-type'] !== 'chat.message.sent') return;
      try { alMensaje(JSON.parse(cuerpo.toString('utf8'))); } catch (e) { log('⚠️ Aviso de Kick ilegible: ' + e.message, { nivel: 'aviso' }); }
    });
  };
}

// Twitch: inicio de sesión, eventos en vivo (chat, inicio y fin del directo), canal y clips.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { marcar, log } from './estado.js';

const ARCHIVO_TOKENS = new URL('./tokens.json', import.meta.url);
export const URL_CALLBACK = 'http://localhost:3000/callback';
export const PERMISOS = ['user:read:chat', 'user:write:chat', 'channel:manage:broadcast', 'clips:edit'];

const cid = () => process.env.TWITCH_CLIENT_ID;
const secreto = () => process.env.TWITCH_CLIENT_SECRET;

let tokens = existsSync(ARCHIVO_TOKENS) ? JSON.parse(readFileSync(ARCHIVO_TOKENS, 'utf8')) : null;

export const tieneSesion = () => Boolean(tokens?.refresh_token);
export const permisosFaltantes = () => PERMISOS.filter((p) => !(tokens?.scope ?? []).includes(p));

export function urlLogin() {
  const p = new URLSearchParams({
    client_id: cid(),
    redirect_uri: URL_CALLBACK,
    response_type: 'code',
    scope: PERMISOS.join(' '),
    force_verify: 'true',
  });
  return `https://id.twitch.tv/oauth2/authorize?${p}`;
}

async function pedirToken(params) {
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: cid(), client_secret: secreto(), ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const t = await res.text();
    if (params.grant_type === 'refresh_token') {
      marcar('twitch', 'error', 'Twitch cerró tu sesión: vuelve a autorizar desde la PC (http://localhost:3000/twitch)', t);
    }
    throw new Error(`Twitch rechazó el inicio de sesión (${res.status}): ${t}`);
  }
  tokens = await res.json();
  writeFileSync(ARCHIVO_TOKENS, JSON.stringify(tokens, null, 2));
}

export async function canjearCodigo(code) {
  await pedirToken({ grant_type: 'authorization_code', code, redirect_uri: URL_CALLBACK });
}

const renovar = () => pedirToken({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });

// Llamada a la API de Twitch; si el token venció, lo renueva y reintenta una vez.
export async function api(ruta, opciones = {}, reintento = true) {
  if (!tokens) throw new Error('No hay sesión de Twitch');
  const res = await fetch(`https://api.twitch.tv/helix/${ruta}`, {
    ...opciones,
    headers: {
      'Client-Id': cid(),
      Authorization: `Bearer ${tokens.access_token}`,
      'Content-Type': 'application/json',
      ...opciones.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 && reintento) {
    await renovar();
    return api(ruta, opciones, false);
  }
  const cuerpo = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error(`Twitch API ${ruta.split('?')[0]} → ${res.status}: ${cuerpo?.message ?? JSON.stringify(cuerpo)}`);
    e.status = res.status;
    throw e;
  }
  return cuerpo;
}

export async function idDeUsuario(login) {
  const r = await api(login ? `users?login=${encodeURIComponent(login)}` : 'users');
  if (!r.data?.length) throw new Error(`No encontré el usuario de Twitch "${login}"`);
  return r.data[0];
}

export async function infoCanal(canalId) {
  const r = await api(`channels?broadcaster_id=${canalId}`);
  return r.data?.[0] ?? {};
}

// Datos del directo si estás en vivo; null si no.
export async function directoActual(canalId) {
  const r = await api(`streams?user_id=${canalId}`);
  return r.data?.[0] ?? null;
}
export const estaEnVivo = async (canalId) => Boolean(await directoActual(canalId));

export async function horarioPublicado(canalId) {
  try {
    const r = await api(`schedule?broadcaster_id=${canalId}&first=20`);
    return (r.data?.segments ?? []).map((s) => s.start_time);
  } catch {
    return [];
  }
}

export async function directosPasados(canalId) {
  try {
    const r = await api(`videos?user_id=${canalId}&type=archive&first=30`);
    return (r.data ?? []).map((v) => ({ fecha: v.created_at, titulo: v.title, duracion: v.duration }));
  } catch {
    return [];
  }
}

export async function buscarCategorias(texto) {
  const r = await api(`search/categories?query=${encodeURIComponent(texto)}&first=10`);
  return (r.data ?? []).map((c) => ({ id: c.id, nombre: c.name, imagen: c.box_art_url }));
}

export async function cambiarCanal(canalId, { titulo, categoriaId }) {
  const cuerpo = {};
  if (titulo) cuerpo.title = titulo.slice(0, 140);
  if (categoriaId) cuerpo.game_id = categoriaId;
  await api(`channels?broadcaster_id=${canalId}`, { method: 'PATCH', body: JSON.stringify(cuerpo) });
}

export async function crearClip(canalId) {
  const r = await api(`clips?broadcaster_id=${canalId}`, { method: 'POST' });
  const c = r.data?.[0];
  return c ? { id: c.id, url: `https://clips.twitch.tv/${c.id}`, editar: c.edit_url } : null;
}

export async function enviarMensaje({ canalId, emisorId, texto }) {
  const r = await api('chat/messages', {
    method: 'POST',
    body: JSON.stringify({ broadcaster_id: canalId, sender_id: emisorId, message: texto.slice(0, 500) }),
  });
  const d = r?.data?.[0];
  if (d && !d.is_sent) throw new Error(`Twitch no envió el mensaje: ${d.drop_reason?.message ?? 'sin motivo'}`);
}

// Escucha por EventSub WebSocket: mensajes del chat, inicio y fin del directo.
export function escucharEventos({ canalId, lectorId, alMensaje, alEnVivo, alFin }) {
  let ws;
  let vigilancia;

  const suscribir = (tipo, condicion, sesion) =>
    api('eventsub/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ type: tipo, version: '1', condition: condicion, transport: { method: 'websocket', session_id: sesion } }),
    });

  const conectar = (url = 'wss://eventsub.wss.twitch.tv/ws', esReconexion = false) => {
    const nuevo = new WebSocket(url);
    let segundosVida = 30;

    const reiniciarVigilancia = () => {
      clearTimeout(vigilancia);
      vigilancia = setTimeout(() => {
        marcar('chatTwitch', 'aviso', 'Twitch dejó de responder; reconectando…');
        nuevo.close();
      }, (segundosVida + 10) * 1000);
    };

    nuevo.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      const tipo = msg.metadata?.message_type;
      reiniciarVigilancia();

      if (tipo === 'session_welcome') {
        segundosVida = msg.payload.session.keepalive_timeout_seconds ?? 30;
        const anterior = ws;
        ws = nuevo;
        if (esReconexion) {
          anterior?.close();
          return;
        }
        const sesion = msg.payload.session.id;
        try {
          await suscribir('channel.chat.message', { broadcaster_user_id: canalId, user_id: lectorId }, sesion);
          await suscribir('stream.online', { broadcaster_user_id: canalId }, sesion);
          await suscribir('stream.offline', { broadcaster_user_id: canalId }, sesion);
          marcar('chatTwitch', 'ok', 'Escuchando tu chat y tus directos');
        } catch (err) {
          marcar('chatTwitch', 'error', 'No pude conectarme a los eventos de Twitch', err.message);
        }
      } else if (tipo === 'session_reconnect') {
        conectar(msg.payload.session.reconnect_url, true);
      } else if (tipo === 'notification') {
        const t = msg.payload.subscription.type;
        if (t === 'channel.chat.message') alMensaje(msg.payload.event);
        else if (t === 'stream.online') alEnVivo?.(msg.payload.event);
        else if (t === 'stream.offline') alFin?.(msg.payload.event);
      } else if (tipo === 'revocation') {
        marcar('chatTwitch', 'error', 'Twitch canceló una suscripción (' + msg.payload.subscription.status + ')');
      }
    };

    nuevo.onclose = () => {
      if (ws === nuevo || !ws) {
        clearTimeout(vigilancia);
        ws = null;
        marcar('chatTwitch', 'aviso', 'Se cortó la conexión con Twitch; reintento en 5 s');
        setTimeout(() => conectar(), 5000);
      }
    };
    nuevo.onerror = () => {};
  };

  log('Conectando con los eventos de Twitch…');
  conectar();
}

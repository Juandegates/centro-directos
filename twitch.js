// Twitch: inicio de sesión (OAuth), lectura del chat (EventSub) y envío de mensajes.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ARCHIVO_TOKENS = new URL('./tokens.json', import.meta.url);
export const URL_CALLBACK = 'http://localhost:3000/callback';
const PERMISOS = ['user:read:chat', 'user:write:chat'];

const cid = () => process.env.TWITCH_CLIENT_ID;
const secreto = () => process.env.TWITCH_CLIENT_SECRET;

let tokens = existsSync(ARCHIVO_TOKENS) ? JSON.parse(readFileSync(ARCHIVO_TOKENS, 'utf8')) : null;

export const tieneSesion = () => Boolean(tokens?.refresh_token);

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
  });
  if (!res.ok) throw new Error(`Twitch rechazó el inicio de sesión (${res.status}): ${await res.text()}`);
  tokens = await res.json();
  writeFileSync(ARCHIVO_TOKENS, JSON.stringify(tokens, null, 2));
}

export const canjearCodigo = (code) =>
  pedirToken({ grant_type: 'authorization_code', code, redirect_uri: URL_CALLBACK });

const renovar = () => pedirToken({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });

// Llamada a la API de Twitch; si el token venció, lo renueva y reintenta una vez.
export async function api(ruta, opciones = {}, reintento = true) {
  const res = await fetch(`https://api.twitch.tv/helix/${ruta}`, {
    ...opciones,
    headers: {
      'Client-Id': cid(),
      Authorization: `Bearer ${tokens.access_token}`,
      'Content-Type': 'application/json',
      ...opciones.headers,
    },
  });
  if (res.status === 401 && reintento) {
    await renovar();
    return api(ruta, opciones, false);
  }
  const cuerpo = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Twitch API ${ruta} → ${res.status}: ${JSON.stringify(cuerpo)}`);
  return cuerpo;
}

export async function idDeUsuario(login) {
  const r = await api(login ? `users?login=${encodeURIComponent(login)}` : 'users');
  if (!r.data?.length) throw new Error(`No encontré el usuario de Twitch "${login}"`);
  return r.data[0];
}

export async function estaEnVivo(canalId) {
  const r = await api(`streams?user_id=${canalId}`);
  return Boolean(r.data?.length);
}

export async function enviarMensaje({ canalId, emisorId, texto, responderA }) {
  const r = await api('chat/messages', {
    method: 'POST',
    body: JSON.stringify({
      broadcaster_id: canalId,
      sender_id: emisorId,
      message: texto.slice(0, 500),
      ...(responderA ? { reply_parent_message_id: responderA } : {}),
    }),
  });
  const d = r?.data?.[0];
  if (d && !d.is_sent) throw new Error(`Twitch no envió el mensaje: ${d.drop_reason?.message ?? 'sin motivo'}`);
}

// Escucha el chat por EventSub WebSocket y llama a alMensaje(evento) por cada mensaje.
export function escucharChat({ canalId, lectorId, alMensaje, alEstado }) {
  let ws;
  let vigilancia;

  const conectar = (url = 'wss://eventsub.wss.twitch.tv/ws', esReconexion = false) => {
    const nuevo = new WebSocket(url);
    let segundosVida = 30;

    const reiniciarVigilancia = () => {
      clearTimeout(vigilancia);
      vigilancia = setTimeout(() => {
        alEstado('Twitch dejó de responder; reconectando…');
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
          alEstado('Conexión con Twitch renovada.');
          return;
        }
        try {
          await api('eventsub/subscriptions', {
            method: 'POST',
            body: JSON.stringify({
              type: 'channel.chat.message',
              version: '1',
              condition: { broadcaster_user_id: canalId, user_id: lectorId },
              transport: { method: 'websocket', session_id: msg.payload.session.id },
            }),
          });
          alEstado('✅ Escuchando tu chat de Twitch.');
        } catch (err) {
          alEstado('❌ No pude suscribirme al chat: ' + err.message);
        }
      } else if (tipo === 'session_reconnect') {
        conectar(msg.payload.session.reconnect_url, true);
      } else if (tipo === 'notification' && msg.payload.subscription.type === 'channel.chat.message') {
        alMensaje(msg.payload.event);
      } else if (tipo === 'revocation') {
        alEstado('Twitch canceló la suscripción al chat (' + msg.payload.subscription.status + ').');
      }
    };

    nuevo.onclose = () => {
      if (ws === nuevo) {
        clearTimeout(vigilancia);
        ws = null;
        alEstado('Se cerró la conexión con Twitch; reintento en 5 s…');
        setTimeout(() => conectar(), 5000);
      }
    };
    nuevo.onerror = () => {};
  };

  conectar();
}

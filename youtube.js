// YouTube: inicio de sesión con Google, crear el directo, cambiar título, terminarlo y chat.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { marcar } from './estado.js';
import { ajustes, guardarAjustes } from './ajustes.js';

const ARCHIVO_TOKENS = new URL('./google-tokens.json', import.meta.url);
export const URL_CALLBACK = 'http://localhost:3000/google/callback';
const API = 'https://www.googleapis.com/youtube/v3/';

let tokens = existsSync(ARCHIVO_TOKENS) ? JSON.parse(readFileSync(ARCHIVO_TOKENS, 'utf8')) : null;

// Cuota diaria de YouTube: 10,000 unidades. Llevamos la cuenta para no pasarnos.
const cuota = { dia: new Date().toDateString(), usada: 0 };
export const cuotaUsada = () => {
  if (cuota.dia !== new Date().toDateString()) Object.assign(cuota, { dia: new Date().toDateString(), usada: 0 });
  return cuota.usada;
};
const gastar = (u) => { cuotaUsada(); cuota.usada += u; };

export const configurado = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && !process.env.GOOGLE_CLIENT_ID.startsWith('pega_aqui'));
export const tieneSesion = () => Boolean(tokens?.refresh_token);

export function urlLogin() {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: URL_CALLBACK,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/youtube',
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function pedirToken(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (params.grant_type === 'refresh_token') marcar('youtube', 'error', 'Google cerró tu sesión: vuelve a autorizar YouTube desde la PC (http://localhost:3000/youtube)', JSON.stringify(d));
    throw new Error(`Google rechazó el inicio de sesión (${res.status}): ${JSON.stringify(d)}`);
  }
  tokens = { ...tokens, ...d, vence: Date.now() + (d.expires_in - 60) * 1000 };
  writeFileSync(ARCHIVO_TOKENS, JSON.stringify(tokens, null, 2));
}

export const canjearCodigo = (code) => pedirToken({ grant_type: 'authorization_code', code, redirect_uri: URL_CALLBACK });

async function api(ruta, { metodo = 'GET', cuerpo, unidades = 1 } = {}) {
  if (!tokens) throw new Error('No hay sesión de YouTube');
  if (!tokens.vence || Date.now() > tokens.vence) await pedirToken({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  gastar(unidades);
  const res = await fetch(API + ruta, {
    method: metodo,
    headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const d = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const motivo = d?.error?.errors?.[0]?.reason ?? '';
    const e = new Error(`YouTube ${ruta.split('?')[0]} → ${res.status} ${motivo}: ${d?.error?.message ?? ''}`);
    e.status = res.status;
    e.motivo = motivo;
    throw e;
  }
  return d;
}

export async function miCanal() {
  const r = await api('channels?part=snippet&mine=true');
  const c = r.items?.[0];
  if (!c) throw new Error('Esta cuenta de Google no tiene canal de YouTube');
  return { id: c.id, nombre: c.snippet.title };
}

// La "transmisión" (clave fija) que recibe la señal; se crea una vez y se reutiliza.
export async function asegurarStream() {
  const guardado = ajustes().youtube?.streamId;
  if (guardado) {
    const r = await api(`liveStreams?part=cdn,status&id=${guardado}`);
    const s = r.items?.[0];
    if (s) return { id: s.id, rtmp: `${s.cdn.ingestionInfo.ingestionAddress}/${s.cdn.ingestionInfo.streamName}` };
  }
  const s = await api('liveStreams?part=snippet,cdn,contentDetails', {
    metodo: 'POST',
    unidades: 50,
    cuerpo: {
      snippet: { title: 'Centro de Directos (PS5)' },
      cdn: { frameRate: 'variable', ingestionType: 'rtmp', resolution: 'variable' },
      contentDetails: { isReusable: true },
    },
  });
  guardarAjustes({ youtube: { ...ajustes().youtube, streamId: s.id } });
  return { id: s.id, rtmp: `${s.cdn.ingestionInfo.ingestionAddress}/${s.cdn.ingestionInfo.streamName}` };
}

export async function crearDirecto({ titulo, descripcion, streamId }) {
  const inicio = new Date().toISOString();
  const b = await api('liveBroadcasts?part=snippet,status,contentDetails', {
    metodo: 'POST',
    unidades: 50,
    cuerpo: {
      snippet: { title: titulo.slice(0, 100), description: descripcion.slice(0, 4900), scheduledStartTime: inicio },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
      contentDetails: { enableAutoStart: true, enableAutoStop: true, latencyPreference: 'low', enableDvr: true, monitorStream: { enableMonitorStream: false } },
    },
  });
  await api(`liveBroadcasts/bind?id=${b.id}&part=id,contentDetails&streamId=${streamId}`, { metodo: 'POST', unidades: 50 });
  return { id: b.id, chatId: b.snippet.liveChatId, inicio, url: `https://youtube.com/watch?v=${b.id}` };
}

export async function cambiarTitulo({ id, inicio, titulo, descripcion }) {
  await api('liveBroadcasts?part=snippet', {
    metodo: 'PUT',
    unidades: 50,
    cuerpo: { id, snippet: { title: titulo.slice(0, 100), description: descripcion.slice(0, 4900), scheduledStartTime: inicio } },
  });
}

export async function miDirecto(id) {
  const r = await api(`liveBroadcasts?part=status&id=${id}`);
  return r.items?.[0]?.status?.lifeCycleStatus ?? null; // 'live', 'testing', 'ready', 'complete'…
}

export async function terminarDirecto(id) {
  try {
    await api(`liveBroadcasts/transition?broadcastStatus=complete&id=${id}&part=status`, { metodo: 'POST', unidades: 50 });
  } catch (e) {
    if (e.status !== 403) throw e; // 403 = ya había terminado solo
  }
}

export async function leerChat(chatId, pagina) {
  const r = await api(`liveChat/messages?liveChatId=${chatId}&part=snippet,authorDetails&maxResults=200${pagina ? `&pageToken=${pagina}` : ''}`, { unidades: 5 });
  return {
    mensajes: (r.items ?? []).map((m) => ({
      id: m.id,
      usuarioId: m.authorDetails.channelId,
      nombre: m.authorDetails.displayName,
      texto: m.snippet.displayMessage ?? '',
      esMio: m.authorDetails.isChatOwner,
      hora: m.snippet.publishedAt,
    })),
    siguiente: r.nextPageToken,
    esperaMs: r.pollingIntervalMillis ?? 5000,
    terminado: Boolean(r.offlineAt),
  };
}

export async function enviarChat(chatId, texto) {
  await api('liveChat/messages?part=snippet', {
    metodo: 'POST',
    unidades: 20,
    cuerpo: { snippet: { liveChatId: chatId, type: 'textMessageEvent', textMessageDetails: { messageText: texto.slice(0, 200) } } },
  });
}

// Al terminar: título, descripción (con capítulos) y etiquetas del directo guardado en YouTube.
export async function actualizarVideo({ id, titulo, descripcion, etiquetas = [] }) {
  await api('videos?part=snippet', {
    metodo: 'PUT',
    unidades: 50,
    cuerpo: { id, snippet: { title: titulo.slice(0, 100), description: descripcion.slice(0, 4900), tags: etiquetas.slice(0, 15), categoryId: '20' } },
  });
}

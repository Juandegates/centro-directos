// Publicación automática (v5), solo con servicios oficiales y gratis:
//  - Buffer (plan gratis, 3 canales): TikTok y YouTube Shorts. Su app está aprobada por TikTok y YouTube,
//    así que los videos salen públicos.
//  - Meta (tu propia app, gratis): Reels en tu Página de Facebook y en tu Instagram de los directos.
//  - Upload-Post (plan gratis, 10 al mes): X.
// Los servicios descargan el video de una dirección pública temporal (ver publico.js).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { publicar as enlacePublico } from './publico.js';
import { correrFfmpeg } from './herramientas.js';
import { infoVideo } from './editor.js';
import { log } from './estado.js';

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const valor = (k) => {
  const v = process.env[k];
  return v && !v.startsWith('pega_aqui') ? v.trim() : '';
};

// ---------------- Buffer ----------------
const BUFFER = 'https://api.buffer.com';
export const bufferConfigurado = () => Boolean(valor('BUFFER_API_KEY'));

async function gql(query, variables = {}) {
  const res = await fetch(BUFFER, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${valor('BUFFER_API_KEY')}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const texto = await res.text();
  let d;
  try { d = JSON.parse(texto); } catch { throw new Error(`Buffer respondió ${res.status}: ${texto.slice(0, 200)}`); }
  if (!res.ok || d.errors?.length) throw new Error(`Buffer: ${d.errors?.map((e) => e.message).join('; ') || res.status}`);
  return d.data;
}

let bufferCache = { hora: 0, org: null, canales: [] };
export async function canalesBuffer(forzar = false) {
  if (!forzar && Date.now() - bufferCache.hora < 30 * 60_000 && bufferCache.org) return bufferCache;
  const a = await gql('query { account { organizations { id name } } }');
  const org = a.account?.organizations?.[0]?.id;
  if (!org) throw new Error('Buffer: tu cuenta no tiene organización');
  const c = await gql('query C($input: ChannelsInput!) { channels(input: $input) { id name displayName service isDisconnected isLocked } }', { input: { organizationId: org } });
  bufferCache = { hora: Date.now(), org, canales: c.channels ?? [] };
  return bufferCache;
}

function canalDe(servicio, config) {
  const quiero = String(config.autoPublicar?.buffer?.[servicio] ?? '').toLowerCase();
  const opciones = bufferCache.canales.filter((c) => c.service === servicio && !c.isDisconnected && !c.isLocked);
  return opciones.find((c) => quiero && [c.name, c.displayName].some((n) => String(n ?? '').toLowerCase().includes(quiero))) ?? opciones[0] ?? null;
}

const MUTACION = `mutation P($input: CreatePostInput!) { createPost(input: $input) {
  ... on PostActionSuccess { post { id status externalLink } }
  ... on MutationError { message } } }`;

async function publicarBuffer(servicio, { url, texto, titulo }, config) {
  await canalesBuffer();
  const canal = canalDe(servicio, config);
  if (!canal) throw new Error(`Buffer no tiene conectado ${servicio === 'youtube' ? 'YouTube' : 'TikTok'}`);
  const input = {
    channelId: canal.id, text: texto, schedulingType: 'automatic', mode: 'shareNow', needsApproval: false,
    assets: [{ video: { url } }],
    ...(servicio === 'youtube' ? { metadata: { youtube: { title: titulo.slice(0, 100), categoryId: '20', privacy: 'public', madeForKids: false, notifySubscribers: true } } } : {}),
  };
  const d = await gql(MUTACION, { input });
  const r = d.createPost ?? {};
  if (!r.post) throw new Error(`Buffer no aceptó el video: ${r.message ?? 'sin detalle'}`);
  return { id: r.post.id, canal: canal.id, estado: r.post.status, url: r.post.externalLink ?? null };
}

// ¿Ya salió? Busca el post entre los últimos del canal.
let avisoConsulta = false;
async function estadoBuffer({ id, canal }) {
  const { org } = await canalesBuffer();
  const formas = [
    async () => (await gql('query E($input: PostInput!) { post(input: $input) { id status externalLink error { message } } }', { input: { id } })).post,
    async () => {
      const d = await gql('query E($input: PostsInput!) { posts(first: 50, input: $input) { edges { node { id status externalLink error { message } } } } }',
        { input: { organizationId: org, filter: { channelIds: [canal] } } });
      return d.posts?.edges?.map((e) => e.node).find((x) => x.id === id) ?? null;
    },
  ];
  for (const f of formas) {
    try {
      const n = await f();
      if (n) return { estado: n.status, url: n.externalLink ?? null, error: n.error?.message ?? null };
    } catch (e) {
      if (!avisoConsulta) { avisoConsulta = true; log('Buffer: no pude consultar un post (' + e.message + ')', { nivel: 'aviso' }); }
    }
  }
  return { estado: 'desconocido' };
}

// ---------------- Meta (Facebook e Instagram) ----------------
const GRAPH = 'https://graph.facebook.com/v25.0';
const ARCHIVO_META = new URL('./meta-tokens.json', import.meta.url);
let meta = null;
try { meta = existsSync(ARCHIVO_META) ? JSON.parse(readFileSync(ARCHIVO_META, 'utf8')) : null; } catch { meta = null; }
export const metaConfigurado = () => Boolean(valor('META_APP_ID') && valor('META_APP_SECRET'));
export const metaListo = () => Boolean(meta?.paginaId && meta?.token);
export const metaInfo = () => (meta ? { pagina: meta.paginaNombre, instagram: meta.igUsuario ?? null } : null);

async function graph(ruta, { metodo = 'GET', params = {}, token } = {}) {
  const u = new URL(ruta.startsWith('http') ? ruta : GRAPH + ruta);
  const cuerpo = new URLSearchParams({ ...params, ...(token ? { access_token: token } : {}) });
  const res = await fetch(metodo === 'GET' ? `${u}${u.search ? '&' : '?'}${cuerpo}` : u, {
    method: metodo,
    ...(metodo === 'GET' ? {} : { body: cuerpo }),
    signal: AbortSignal.timeout(60_000),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.error) throw new Error(`Meta ${ruta.split('?')[0]}: ${d.error?.message ?? res.status}`);
  return d;
}

// Paso 1 de la configuración: el token corto del Explorador → largo → tus Páginas.
export async function metaPaginas(tokenCorto) {
  const largo = await graph('/oauth/access_token', { params: { grant_type: 'fb_exchange_token', client_id: valor('META_APP_ID'), client_secret: valor('META_APP_SECRET'), fb_exchange_token: tokenCorto.trim() } });
  const p = await graph('/me/accounts', { params: { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '50' }, token: largo.access_token });
  return (p.data ?? []).map((x) => ({ id: x.id, nombre: x.name, token: x.access_token, ig: x.instagram_business_account ?? null }));
}

// Paso 2: guardas la Página de tus directos (su token de Página no caduca).
export function metaGuardar(pagina) {
  meta = { paginaId: pagina.id, paginaNombre: pagina.nombre, token: pagina.token, igId: pagina.ig?.id ?? null, igUsuario: pagina.ig?.username ?? null, guardado: new Date().toISOString() };
  writeFileSync(ARCHIVO_META, JSON.stringify(meta, null, 2));
  return metaInfo();
}

async function reelFacebook({ archivo, texto }) {
  if (!metaListo()) throw new Error('Falta conectar tu Página de Facebook (http://localhost:3000/meta en la PC)');
  const t = meta.token;
  const ini = await graph(`/${meta.paginaId}/video_reels`, { metodo: 'POST', params: { upload_phase: 'start' }, token: t });
  // Se sube el archivo directo desde la PC (Facebook a veces se niega a descargarlo de una dirección).
  const datos = readFileSync(archivo);
  const sub = await fetch(`https://rupload.facebook.com/video-upload/v25.0/${ini.video_id}`, {
    method: 'POST',
    headers: { Authorization: `OAuth ${t}`, offset: '0', file_size: String(datos.length), 'Content-Type': 'application/octet-stream' },
    body: datos,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const s = await sub.json().catch(() => ({}));
  if (!sub.ok || s.success === false || s.error) throw new Error(`Facebook no aceptó el video: ${s.error?.message ?? s.debug_info?.message ?? sub.status}`);
  await graph(`/${meta.paginaId}/video_reels`, { metodo: 'POST', params: { upload_phase: 'finish', video_id: ini.video_id, video_state: 'PUBLISHED', description: texto.slice(0, 2000) }, token: t });
  return { id: ini.video_id, url: `https://www.facebook.com/reel/${ini.video_id}` };
}

async function reelInstagram({ url, texto }) {
  if (!metaListo() || !meta.igId) throw new Error('Falta tu Instagram profesional vinculado a la Página (http://localhost:3000/meta en la PC)');
  const t = meta.token;
  const c = await graph(`/${meta.igId}/media`, { metodo: 'POST', params: { media_type: 'REELS', video_url: url, caption: texto.slice(0, 2200), share_to_feed: 'true' }, token: t });
  for (let i = 0; i < 20; i++) {
    await esperar(30_000);
    const s = await graph(`/${c.id}`, { params: { fields: 'status_code,status' }, token: t });
    if (s.status_code === 'FINISHED') {
      const p = await graph(`/${meta.igId}/media_publish`, { metodo: 'POST', params: { creation_id: c.id }, token: t });
      const link = await graph(`/${p.id}`, { params: { fields: 'permalink' }, token: t }).catch(() => ({}));
      return { id: p.id, url: link.permalink ?? null };
    }
    if (['ERROR', 'EXPIRED'].includes(s.status_code)) throw new Error(`Instagram no aceptó el video: ${s.status ?? s.status_code}`);
  }
  throw new Error('Instagram tardó más de 10 min en procesar el video');
}

// ---------------- Upload-Post (X) ----------------
export const uploadPostConfigurado = () => Boolean(valor('UPLOADPOST_API_KEY'));

async function postX({ url, texto }, config) {
  const f = new FormData();
  f.append('user', String(config.autoPublicar?.uploadPost?.usuario ?? 'juandegamers'));
  f.append('platform[]', 'x');
  f.append('title', texto.slice(0, 270));
  f.append('video', url);
  f.append('async_upload', 'true');
  const res = await fetch('https://api.upload-post.com/api/upload', {
    method: 'POST', headers: { Authorization: `Apikey ${valor('UPLOADPOST_API_KEY')}` }, body: f, signal: AbortSignal.timeout(180_000),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.success === false) throw new Error(`Upload-Post respondió ${res.status}: ${d.message ?? d.error ?? JSON.stringify(d).slice(0, 200)}`);
  const x = d.results?.x;
  if (x && x.success === false) throw new Error(`X no aceptó el video: ${x.error ?? 'sin detalle'}`);
  if (d.request_id && !x) {
    for (let i = 0; i < 30; i++) {
      await esperar(10_000);
      const s = await fetch(`https://api.upload-post.com/api/uploadposts/status?request_id=${encodeURIComponent(d.request_id)}`, { headers: { Authorization: `Apikey ${valor('UPLOADPOST_API_KEY')}` } }).then((r) => r.json()).catch(() => ({}));
      const r = (s.results ?? []).find((y) => y.platform === 'x');
      if (r?.success) return { url: r.post_url ?? null, usados: d.usage?.count ?? null };
      if (r && r.success === false) throw new Error(`X no aceptó el video: ${r.message ?? ''}`);
      if (s.status === 'failed') throw new Error('Upload-Post: la subida falló');
    }
  }
  return { url: x?.url ?? null, usados: d.usage?.count ?? null };
}

// ---------------- Todo junto ----------------
export const DESTINOS = ['tiktok', 'youtube', 'facebook', 'instagram', 'x'];
export const NOMBRES = { tiktok: 'TikTok', youtube: 'YouTube Shorts', facebook: 'Facebook', instagram: 'Instagram', x: 'X' };

// Qué destinos están listos para usarse ahora mismo.
export function destinosListos(config) {
  const quiero = { tiktok: true, youtube: true, facebook: true, instagram: true, x: true, ...(config.autoPublicar?.destinos ?? {}) };
  return DESTINOS.filter((d) => quiero[d] && (
    (d === 'tiktok' || d === 'youtube') ? bufferConfigurado()
      : d === 'facebook' ? metaListo()
        : d === 'instagram' ? metaListo() && Boolean(meta?.igId)
          : uploadPostConfigurado()));
}

// Facebook acepta Reels de máximo 90 s: si el video es más largo, se hace una copia recortada.
async function versionFacebook(config, vertical) {
  const { duracion } = await infoVideo(config, vertical);
  if (duracion <= 89.5) return vertical;
  const corto = vertical.replace(/\.mp4$/, '-fb.mp4');
  if (!existsSync(corto)) await correrFfmpeg(config, ['-i', vertical, '-t', '89', '-c', 'copy', '-movflags', '+faststart', corto]);
  return corto;
}

// Publica un video (item de la bandeja) en UN destino. Devuelve { url?, id?, canal?, pendiente? }.
export async function publicarEn(destino, item, { config, carpetaClips }) {
  const vertical = join(carpetaClips, item.archivos.vertical);
  if (!existsSync(vertical)) throw new Error('El video ya no existe en la PC');
  const archivo = destino === 'facebook' ? await versionFacebook(config, vertical) : vertical;
  const url = destino === 'facebook' ? null : enlacePublico(archivo, 72);
  const texto = item.textoTikTok ?? item.titulo ?? '';
  if (destino === 'tiktok') return { ...(await publicarBuffer('tiktok', { url, texto }, config)), pendiente: true };
  if (destino === 'youtube') return { ...(await publicarBuffer('youtube', { url, texto, titulo: item.tituloShorts ?? item.titulo }, config)), pendiente: true };
  if (destino === 'facebook') return reelFacebook({ archivo, texto });
  if (destino === 'instagram') return reelInstagram({ url, texto });
  if (destino === 'x') return postX({ url, texto: item.textoX ?? item.titulo }, config);
  throw new Error('Destino desconocido: ' + destino);
}

// Para los de Buffer: confirma unos minutos después si de verdad salió.
export async function confirmar(destino, info) {
  if (destino !== 'tiktok' && destino !== 'youtube') return { estado: 'sent' };
  return estadoBuffer(info);
}

// Prueba de conexión de cada servicio (para Diagnóstico).
export async function probarServicios(config) {
  const r = [];
  if (bufferConfigurado()) {
    try {
      const { canales } = await canalesBuffer(true);
      const t = canalDe('tiktok', config);
      const y = canalDe('youtube', config);
      r.push({ nombre: 'Buffer (TikTok y YouTube)', ok: Boolean(t && y), detalle: `TikTok: ${t ? t.displayName || t.name : 'falta conectar'} · YouTube: ${y ? y.displayName || y.name : 'falta conectar'} · ${canales.length} canal(es) en Buffer` });
    } catch (e) { r.push({ nombre: 'Buffer (TikTok y YouTube)', ok: false, detalle: e.message }); }
  }
  if (metaConfigurado()) {
    r.push(metaListo()
      ? { nombre: 'Meta (Facebook e Instagram)', ok: Boolean(meta.igId), detalle: `Página: ${meta.paginaNombre} · Instagram: ${meta.igUsuario ? '@' + meta.igUsuario : 'falta vincular a la Página'}` }
      : { nombre: 'Meta (Facebook e Instagram)', ok: false, detalle: 'Falta conectar tu Página en http://localhost:3000/meta (en la PC)' });
  }
  if (uploadPostConfigurado()) r.push({ nombre: 'Upload-Post (X)', ok: true, detalle: `Clave lista · perfil "${config.autoPublicar?.uploadPost?.usuario ?? 'juandegamers'}"` });
  return r;
}

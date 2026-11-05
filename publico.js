// Servidor público (puerto 3001, abierto a internet por Tailscale Funnel en https://<tu-pc>.ts.net:8443).
// Solo hace dos cosas:
//  1) recibe los avisos firmados de Kick (POST),
//  2) entrega los videos que se van a publicar, con una dirección imposible de adivinar que caduca
//     (Buffer, Meta y Upload-Post los descargan de ahí). Nada más de tu PC queda expuesto.
import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { marcar } from './estado.js';

const ARCHIVO = new URL('./publicos.json', import.meta.url);
let enlaces = {}; // token → { ruta, vence }
try { enlaces = JSON.parse(readFileSync(ARCHIVO, 'utf8')); } catch { enlaces = {}; }
const guardar = () => { try { writeFileSync(ARCHIVO, JSON.stringify(enlaces)); } catch { /* sin disco: solo en memoria */ } };

let base = () => '';
export const configurarBase = (fn) => { base = fn; };
export const urlBase = () => base();

// Da una dirección pública temporal para un archivo de video (48 h por defecto).
export function publicar(ruta, horas = 48) {
  const b = base();
  if (!b) throw new Error('No tengo dirección pública: activa Tailscale Funnel en la PC (tailscale funnel --bg --https=8443 3001)');
  const token = randomBytes(18).toString('hex');
  enlaces[token] = { ruta, vence: Date.now() + horas * 3600_000 };
  limpiar();
  return `${b}/v/${token}/${encodeURIComponent(basename(ruta))}`;
}

function limpiar() {
  for (const [t, e] of Object.entries(enlaces)) if (e.vence < Date.now()) delete enlaces[t];
  guardar();
}

function entregar(req, res, ruta) {
  let tam;
  try { tam = statSync(ruta).size; } catch { res.writeHead(404); res.end(); return; }
  const tipo = ruta.endsWith('.mp4') ? 'video/mp4' : ruta.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream';
  const rango = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  if (rango) {
    const ini = rango[1] ? Number(rango[1]) : Math.max(0, tam - Number(rango[2]));
    const fin = rango[1] && rango[2] ? Math.min(tam - 1, Number(rango[2])) : tam - 1;
    if (ini >= tam || ini > fin) { res.writeHead(416, { 'Content-Range': `bytes */${tam}` }); res.end(); return; }
    res.writeHead(206, { 'Content-Type': tipo, 'Content-Length': fin - ini + 1, 'Content-Range': `bytes ${ini}-${fin}/${tam}`, 'Accept-Ranges': 'bytes' });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(ruta, { start: ini, end: fin }).on('error', () => res.destroy()).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': tipo, 'Content-Length': tam, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(ruta).on('error', () => res.destroy()).pipe(res);
}

export function iniciarPublico({ puerto = 3001, alAvisoKick = null }) {
  const servidor = createServer((req, res) => {
    try { atender(req, res); } catch { try { res.writeHead(400); res.end(); } catch { res.destroy(); } }
  });
  function atender(req, res) {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST') {
      if (alAvisoKick) return alAvisoKick(req, res);
      res.writeHead(404); res.end(); return;
    }
    if (url.pathname === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('User-agent: facebookexternalhit\nAllow: /\n\nUser-agent: *\nAllow: /\n'); return; }
    const m = url.pathname.match(/^\/v\/([a-f0-9]{36})\//);
    if (m && (req.method === 'GET' || req.method === 'HEAD')) {
      const e = enlaces[m[1]];
      if (!e || e.vence < Date.now() || !existsSync(e.ruta)) { res.writeHead(404); res.end(); return; }
      return entregar(req, res, e.ruta);
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Centro de Directos');
  }
  servidor.on('error', (e) => marcar('publicar', 'error', `No pude abrir el puerto ${puerto} (avisos de Kick y videos para publicar)`, e.message));
  servidor.listen(puerto, '0.0.0.0');
  setInterval(limpiar, 3600_000);
  return servidor;
}

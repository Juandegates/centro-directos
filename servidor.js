// Servidor de la PC: la app del celular (con PIN), su API y los inicios de sesión de Twitch y YouTube.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ajustes } from './ajustes.js';
import { CARPETA_CLIPS } from './bandeja.js';
import { log } from './estado.js';

const CARPETA_APP = fileURLToPath(new URL('./app/', import.meta.url));
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4',
};

const firma = () => createHmac('sha256', ajustes().secretoSesion).update('sesion-app').digest('hex');
const esLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

function autorizado(req) {
  const galleta = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith('sesion='))?.slice(7) ?? '';
  const a = Buffer.from(galleta);
  const b = Buffer.from(firma());
  return a.length === b.length && timingSafeEqual(a, b);
}

const leerCuerpo = (req) => new Promise((ok) => {
  let d = '';
  req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
  req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { ok({}); } });
});

function servirArchivo(req, res, ruta) {
  if (!existsSync(ruta) || !statSync(ruta).isFile()) { res.writeHead(404); return res.end('No existe'); }
  const tam = statSync(ruta).size;
  const tipo = TIPOS[extname(ruta)] ?? 'application/octet-stream';
  const rango = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (rango) {
    const ini = rango[1] ? Number(rango[1]) : 0;
    const fin = rango[2] ? Number(rango[2]) : tam - 1;
    res.writeHead(206, { 'Content-Type': tipo, 'Content-Range': `bytes ${ini}-${fin}/${tam}`, 'Accept-Ranges': 'bytes', 'Content-Length': fin - ini + 1 });
    return createReadStream(ruta, { start: ini, end: fin }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': tipo, 'Content-Length': tam, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
  createReadStream(ruta).pipe(res);
}

// rutas: { 'GET /api/estado': async ({ req, url, cuerpo }) => respuesta, ... }
export function iniciarServidor({ pin, rutas, paginasLocales }) {
  const servidor = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (codigo, datos) => {
      res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(datos));
    };
    const html = (t) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#101114;color:#f2f2f3;padding:32px;font-size:19px;line-height:1.5">${t}</body>`);
    };

    try {
      // Inicios de sesión: solo desde la propia PC (Twitch y Google exigen "localhost").
      const local = paginasLocales[url.pathname];
      if (local) {
        if (!esLocal(req)) return html('Esta página solo se abre en el navegador de la PC.');
        const r = await local({ url });
        if (r.redirigir) { res.writeHead(302, { Location: r.redirigir }); return res.end(); }
        return html(r.html);
      }

      if (url.pathname === '/api/entrar' && req.method === 'POST') {
        const { pin: intento } = await leerCuerpo(req);
        if (String(intento ?? '').trim() !== String(pin)) return json(401, { error: 'PIN incorrecto' });
        res.setHeader('Set-Cookie', `sesion=${firma()}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
        return json(200, { ok: true });
      }

      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) {
        if (!autorizado(req)) return json(401, { error: 'Falta el PIN' });
        if (url.pathname.startsWith('/media/')) {
          const ruta = normalize(join(CARPETA_CLIPS, decodeURIComponent(url.pathname.slice(7))));
          if (!ruta.startsWith(CARPETA_CLIPS)) { res.writeHead(403); return res.end(); }
          return servirArchivo(req, res, ruta);
        }
        const ruta = Object.entries(rutas).find(([clave]) => {
          const [metodo, patron] = clave.split(' ');
          return metodo === req.method && (patron === url.pathname || (patron.endsWith('*') && url.pathname.startsWith(patron.slice(0, -1))));
        });
        if (!ruta) return json(404, { error: 'No existe' });
        const cuerpo = req.method === 'POST' ? await leerCuerpo(req) : {};
        const respuesta = await ruta[1]({ req, url, cuerpo, res });
        if (respuesta === undefined) return; // la ruta ya respondió
        if (typeof respuesta === 'string') {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(respuesta);
        }
        return json(200, respuesta);
      }

      // Archivos de la app
      const archivo = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const ruta = normalize(join(CARPETA_APP, archivo));
      if (!ruta.startsWith(CARPETA_APP)) { res.writeHead(403); return res.end(); }
      return servirArchivo(req, res, existsSync(ruta) ? ruta : join(CARPETA_APP, 'index.html'));
    } catch (e) {
      log('⚠️ Error en la app: ' + e.message, { nivel: 'aviso', detalle: e.stack });
      if (!res.headersSent) json(500, { error: e.message });
    }
  });

  servidor.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log('\n❌ El Centro ya está abierto en otra ventana (puerto 3000 ocupado). Cierra la otra ventana.\n');
      process.exit(1);
    }
    throw e;
  });
  return new Promise((ok) => servidor.listen(3000, '0.0.0.0', ok));
}

export const leerPaginaApp = (n) => readFileSync(join(CARPETA_APP, n), 'utf8');

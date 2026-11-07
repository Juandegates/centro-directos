// Túnel seguro local para enviar a Kick (Amazon IVS).
// FFmpeg manda RTMP normal a 127.0.0.1 y el Centro pone la capa segura (TLS) hacia el servidor de Kick.
// Dos ventajas: no dependemos del TLS de FFmpeg (en Windows falla con algunos servidores) y sabemos
// exactamente en qué paso falla: DNS, conexión, TLS, o que Kick cierre la conexión (clave mal).
import { createServer } from 'node:net';
import { connect } from 'node:tls';

// Abre el túnel y devuelve { puerto, cerrar }. Cada conexión local se reporta con alEvento:
//  { tipo: 'conectado' | 'fallo' | 'cierre' | 'corte' | 'local', error, seguro, ms, enviados, recibidos }
//  - fallo: no se pudo llegar al servidor o falló el TLS (seguro=false)
//  - cierre: el servidor cerró la conexión;  corte: error de red a media transmisión
//  - local: FFmpeg cerró su lado (terminó o se cayó por su cuenta)
export function abrirTunel({ host, puerto = 443, alEvento = () => {}, opcionesTls = {} }) {
  const servidor = createServer((local) => {
    const inicio = Date.now();
    let seguro = false;
    let avisado = false;
    let cerroLocal = false;
    const remoto = connect({ host, port: puerto, servername: host, minVersion: 'TLSv1.2', ...opcionesTls });
    local.setNoDelay(true);
    remoto.setNoDelay(true);
    local.pipe(remoto);
    remoto.pipe(local);
    const avisar = (tipo, error) => {
      if (avisado) return;
      avisado = true;
      alEvento({
        tipo,
        error: error ? `${error.code ?? ''} ${error.message ?? ''}`.trim() : null,
        seguro,
        ms: Date.now() - inicio,
        enviados: remoto.bytesWritten,
        recibidos: remoto.bytesRead,
      });
    };
    remoto.once('secureConnect', () => { seguro = true; alEvento({ tipo: 'conectado', seguro: true, ms: Date.now() - inicio }); });
    remoto.on('error', (e) => { avisar(seguro ? 'corte' : 'fallo', e); local.destroy(); });
    remoto.on('close', () => { avisar(cerroLocal ? 'local' : seguro ? 'cierre' : 'fallo'); local.destroy(); });
    local.on('error', () => { cerroLocal = true; remoto.destroy(); });
    local.on('close', () => { cerroLocal = true; remoto.destroy(); });
  });
  return new Promise((ok, mal) => {
    servidor.once('error', mal);
    servidor.listen(0, '127.0.0.1', () => ok({ puerto: servidor.address().port, cerrar: () => servidor.close() }));
  });
}

// Prueba rápida: ¿se puede abrir una conexión segura con el servidor? (para Diagnóstico)
export function probarConexion({ host, puerto = 443, ms = 8000 }) {
  return new Promise((ok, mal) => {
    const s = connect({ host, port: puerto, servername: host, minVersion: 'TLSv1.2' });
    const t = setTimeout(() => { s.destroy(); mal(new Error(`sin respuesta en ${ms / 1000} s`)); }, ms);
    s.once('secureConnect', () => { clearTimeout(t); const p = s.getProtocol(); s.destroy(); ok(p); });
    s.once('error', (e) => { clearTimeout(t); mal(e); });
  });
}

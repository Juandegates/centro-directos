// Piloto automático de publicaciones (v5).
// - Al terminar un directo espera 1 hora (por si fue un apagón y te reconectas). Si vuelves, es el mismo directo.
// - Luego Claude elige los 3 mejores momentos, se arma el video resumen de 1:30, y se publican espaciados
//   (el 1º de inmediato y los demás cada 3 horas) en TikTok, YouTube Shorts, Facebook, Instagram y X.
// - Los días sin directo, a las 6 pm, sale un video "gancho" con lo mejor que quedó guardado.
import { readFileSync, writeFileSync } from 'node:fs';
import { lista as bandeja, actualizar, CARPETA_CLIPS } from './bandeja.js';
import { publicarEn, confirmar, destinosListos, NOMBRES, xPorBuffer, canalesBuffer, bufferConfigurado } from './publicar.js';
import { log, marcar } from './estado.js';

const ARCHIVO = new URL('./publicacion.json', import.meta.url);
const HORA = 3600_000;
const hoy = () => new Date().toLocaleDateString('en-CA'); // AAAA-MM-DD en tu hora local
const mes = () => hoy().slice(0, 7);

function leer() {
  try { return { pendiente: null, cola: [], ultimoGancho: null, ultimoDirecto: null, xMes: { mes: mes(), usados: 0 }, ...JSON.parse(readFileSync(ARCHIVO, 'utf8')) }; } catch {
    return { pendiente: null, cola: [], ultimoGancho: null, ultimoDirecto: null, xMes: { mes: mes(), usados: 0 } };
  }
}

export function crearAutopublicar({ leerConfig, candidatos, resumen, avisar, urlApp, enVivo }) {
  let s = leer();
  const guardar = () => writeFileSync(ARCHIVO, JSON.stringify(s, null, 2));
  const cfg = () => ({ activo: true, minutosDespues: 60, horasEntre: 3, clipsPorDirecto: 3, resumen: true, horaGancho: '18:00', maxXMes: 10, minimoMinutos: 10, ...(leerConfig().autoPublicar ?? {}) });
  let trabajando = false;
  const arranque = Date.now();

  // ---------- inicio y fin del directo ----------
  function alEmpezar() {
    s.ultimoDirecto = hoy();
    // Mismo directo si: te reconectaste antes de la hora de espera, o el Centro nunca vio terminar el anterior
    // (por ejemplo, un apagón que tiró la PC y la PS5 a la vez).
    const esperando = Boolean(s.pendiente) && !s.pendiente.procesando;
    const continuar = esperando || Boolean(s.enDirecto);
    s.minutosPrevios = esperando ? s.pendiente.minutos : s.enDirecto ? Math.round((Date.now() - s.enDirecto.inicio) / 60_000) : 0;
    if (s.enDirecto && !esperando) s.minutosPrevios = Math.max(0, Math.round((candidatos.ultimaHora() - s.enDirecto.inicio) / 60_000));
    if (continuar) log('🔁 Volviste antes de que se publicara lo del directo anterior: lo junto con este');
    if (esperando) s.pendiente = null;
    s.enDirecto = { inicio: Date.now() };
    candidatos.nuevaSesion({ continuar });
    guardar();
    return continuar;
  }

  // El Centro se reinició a media transmisión: es el mismo directo.
  function alReanudar() {
    s.ultimoDirecto = hoy();
    if (s.pendiente && !s.pendiente.procesando) { s.minutosPrevios = s.pendiente.minutos; s.pendiente = null; }
    if (!s.enDirecto) s.enDirecto = { inicio: Date.now() };
    guardar();
  }

  function alTerminar({ minutos }) {
    s.enDirecto = null;
    // Si fue el mismo directo partido en dos (te reconectaste), se suman los minutos.
    s.pendiente = { termino: Date.now(), minutos: minutos + (s.minutosPrevios ?? 0) };
    s.minutosPrevios = 0;
    guardar();
    log(`⏳ En ${cfg().minutosDespues} min Claude elige los mejores momentos y se publican (si no vuelves a transmitir antes)`);
  }

  // ---------- cola de publicaciones ----------
  function encolar(item, cuando, { conX = false, saltar = [] } = {}) {
    const listos = destinosListos(leerConfig()).filter((d) => (d !== 'x' || conX) && !saltar.includes(d));
    if (!listos.length) return false;
    s.cola.push({ itemId: item.id, titulo: item.titulo, cuando, destinos: Object.fromEntries(listos.map((d) => [d, { estado: 'pendiente', intentos: 0 }])) });
    actualizar(item.id, { programado: new Date(cuando).toISOString(), auto: item.auto ?? true });
    guardar();
    return true;
  }

  function usarX() {
    if (xPorBuffer()) return true; // por Buffer no hay límite al mes
    if (s.xMes.mes !== mes()) s.xMes = { mes: mes(), usados: 0 };
    if (s.xMes.usados >= cfg().maxXMes) return false;
    return true;
  }

  async function procesarDirecto() {
    const c = cfg();
    const { minutos } = s.pendiente;
    // Se marca "procesando" (no se borra): si la PC se reinicia a la mitad, se retoma al volver.
    s.pendiente.procesando = true;
    guardar();
    if (minutos < c.minimoMinutos) {
      log(`🎬 El directo duró ${minutos} min: muy corto para publicar; guardo lo que hubo para los días sin directo`);
      candidatos.archivarSesion();
      s.pendiente = null; guardar();
      return;
    }
    // Primero el resumen (usa los pedacitos de lo grabado), luego Claude elige los clips.
    let resumenItem = null;
    if (c.resumen) {
      resumenItem = await resumen.armar({ minutos }).catch((e) => { log('No pude armar el video resumen: ' + e.message, { nivel: 'aviso' }); return null; });
    }
    log('🤖 Claude está revisando los momentos del directo…');
    marcar('claude', 'aviso', 'Revisando los momentos del directo…');
    const clips = await candidatos.seleccionarDirecto({ cuantos: c.clipsPorDirecto, minutos });
    if (resumenItem) {
      const r = await candidatos.revisarItem(resumenItem).catch(() => ({ publicar: true }));
      if (!r.publicar) { log(`🤖 Claude no aprobó el resumen: ${r.motivo}`); resumenItem = null; }
      else if (r.cambios) resumenItem = actualizar(resumenItem.id, r.cambios);
    }
    s.pendiente = null;
    guardar();
    const videos = [...clips, ...(resumenItem ? [resumenItem] : [])];
    if (!videos.length) {
      avisar('🎬 Sin videos de este directo', 'No hubo momentos suficientes para armar videos. Se guardó lo que hubo para los días sin directo.', { clave: 'sin-videos-' + Date.now() });
      return;
    }
    let t = Date.now();
    let programados = 0;
    videos.forEach((v, i) => {
      const conX = xPorBuffer() || (i === 0 && usarX()); // por Upload-Post X tiene 10 al mes: va el mejor de cada directo
      if (encolar(v, t, { conX })) programados++;
      t += c.horasEntre * HORA;
    });
    const horas = videos.map((v, i) => `${i + 1}. ${v.titulo}`).join('\n');
    if (programados) {
      avisar('🎬 Claude eligió los videos del directo', `${horas}\nEl 1º sale ya y los demás cada ${c.horasEntre} h.`, { abrir: `${urlApp()}#publicar`, etiquetas: ['clapper'], clave: 'elegidos-' + Date.now() });
    } else {
      avisar('🎬 Videos del directo listos', `${horas}\nTodavía no hay redes conectadas para publicarlos solo: ábrelos en Publicar.`, { abrir: `${urlApp()}#publicar`, clave: 'listos-' + Date.now() });
    }
  }

  async function ganchoDelDia() {
    s.ultimoGancho = hoy();
    guardar();
    if (!destinosListos(leerConfig()).length) return;
    log('🎣 Hoy no hubo directo: Claude arma un video gancho con lo guardado');
    const item = await candidatos.videoGancho();
    if (!item) { log('🎣 No hay momentos guardados para el gancho de hoy'); return; }
    encolar(item, Date.now(), { conX: xPorBuffer() });
    avisar('🎣 Video gancho de hoy', `${item.titulo}\nSale en tus redes porque hoy no hubo directo.`, { abrir: `${urlApp()}#publicar`, clave: 'gancho-' + hoy() });
  }

  async function publicarPendientes() {
    const config = leerConfig();
    for (const e of s.cola) {
      if (e.cuando > Date.now()) continue;
      const item = bandeja().find((x) => x.id === e.itemId);
      if (!item) { for (const d of Object.values(e.destinos)) if (d.estado === 'pendiente') d.estado = 'cancelado'; e.avisado = true; continue; }
      for (const [destino, d] of Object.entries(e.destinos)) {
        if (d.estado === 'enviado' && Date.now() - d.hora > 8 * 60_000 && !d.confirmado) {
          // Buffer: ¿ya salió de verdad?
          const r = await confirmar(destino, d.info).catch(() => ({ estado: 'desconocido' }));
          if (r.estado === 'sent') { d.estado = 'ok'; d.url = r.url ?? d.url; d.confirmado = true; actualizar(item.id, { publicado: { [destino]: d.url || true } }); }
          else if (r.estado === 'error') { d.estado = 'pendiente'; d.intentos++; d.error = r.error; d.siguiente = Date.now() + 20 * 60_000; log(`⚠️ ${NOMBRES[destino]} rechazó "${item.titulo}": ${r.error}`, { nivel: 'aviso' }); }
          else if (Date.now() - d.hora > 2 * HORA) { d.confirmado = true; d.estado = 'dudoso'; log(`❔ No pude confirmar si "${item.titulo}" salió en ${NOMBRES[destino]}; revísalo en la app de ${NOMBRES[destino]}`, { nivel: 'aviso' }); }
          continue;
        }
        if (d.estado !== 'pendiente' || (d.siguiente ?? 0) > Date.now()) continue;
        if (d.intentos >= 3) { d.estado = 'error'; continue; }
        try {
          const r = await publicarEn(destino, item, { config, carpetaClips: CARPETA_CLIPS });
          d.info = r; d.url = r.url ?? null; d.hora = Date.now();
          if (r.pendiente) d.estado = 'enviado';
          else { d.estado = 'ok'; actualizar(item.id, { publicado: { [destino]: r.url || true } }); }
          if (destino === 'x' && !xPorBuffer()) { s.xMes.usados++; }
          log(`📤 ${NOMBRES[destino]}: "${item.titulo}" ${r.pendiente ? 'enviado (confirmando)' : 'publicado'}`);
          marcar('publicar', 'ok', `Último: ${NOMBRES[destino]} · ${item.titulo}`);
        } catch (err) {
          // Si se cortó la espera, quizá sí se publicó: no se reintenta (para no publicarlo dos veces).
          if (err.name === 'TimeoutError' || /timeout|aborted/i.test(err.message)) {
            d.estado = 'dudoso';
            d.error = 'Tardó demasiado en responder; revisa si salió';
            if (destino === 'x' && !xPorBuffer()) s.xMes.usados++;
            log(`❔ ${NOMBRES[destino]} tardó demasiado con "${item.titulo}": no lo reintento para no duplicarlo`, { nivel: 'aviso' });
            guardar();
            continue;
          }
          d.intentos++;
          d.error = err.message;
          d.siguiente = Date.now() + 20 * 60_000;
          log(`⚠️ No pude publicar en ${NOMBRES[destino]} (intento ${d.intentos}/3): ${err.message}`, { nivel: 'aviso' });
          if (d.intentos >= 3) {
            d.estado = 'error';
            marcar('publicar', 'aviso', `No pude publicar en ${NOMBRES[destino]}`, err.message);
            avisar(`⚠️ No pude publicar en ${NOMBRES[destino]}`, `${item.titulo}\n${err.message.slice(0, 200)}`, { clave: `pub-${destino}-${item.id}` });
          }
        }
        guardar();
      }
      // ¿Ya terminó este video en todas las redes? Avisamos una vez.
      const todos = Object.entries(e.destinos);
      if (!e.avisado && todos.every(([, d]) => ['ok', 'error', 'cancelado', 'dudoso'].includes(d.estado))) {
        e.avisado = true;
        const ok = todos.filter(([, d]) => d.estado === 'ok').map(([k]) => NOMBRES[k]);
        if (ok.length) avisar('✅ Video publicado', `${item.titulo}\n${ok.join(' · ')}`, { abrir: `${urlApp()}#clips/${item.id}`, etiquetas: ['white_check_mark'], clave: 'publicado-' + item.id });
      }
    }
    // Lo terminado hace más de 3 días ya no hace falta en la cola.
    s.cola = s.cola.filter((e) => !e.avisado || e.cuando > Date.now() - 3 * 24 * HORA);
    guardar();
  }

  async function tick() {
    const c = cfg();
    if (!c.activo || trabajando) return;
    trabajando = true;
    try {
      if (bufferConfigurado()) await canalesBuffer().catch(() => {}); // saber qué redes tienes en Buffer (cada 30 min)
      // La PC estuvo apagada cuando terminó el directo: se da por terminado cuando ya era (5 min después de arrancar).
      if (s.enDirecto && !enVivo() && Date.now() - arranque > 5 * 60_000) {
        const fin = Math.max(candidatos.ultimaHora(), s.enDirecto.inicio);
        log('🔌 El directo terminó mientras la PC estaba apagada; lo proceso igual');
        alTerminar({ minutos: Math.round((fin - s.enDirecto.inicio) / 60_000) });
        s.pendiente.termino = Math.min(s.pendiente.termino, fin);
        guardar();
      }
      if (s.pendiente && !enVivo() && (s.pendiente.procesando || Date.now() - s.pendiente.termino >= c.minutosDespues * 60_000)) await procesarDirecto();
      const [h, m] = String(c.horaGancho).split(':').map(Number);
      const ahora = new Date();
      const yaEsHora = ahora.getHours() * 60 + ahora.getMinutes() >= h * 60 + (m || 0);
      if (yaEsHora && !enVivo() && !s.pendiente && s.ultimoDirecto !== hoy() && s.ultimoGancho !== hoy()) await ganchoDelDia();
      await publicarPendientes();
    } catch (e) {
      log('⚠️ Piloto de publicaciones: ' + e.message, { nivel: 'aviso', detalle: e.stack });
    } finally {
      trabajando = false;
    }
  }
  setInterval(() => { tick(); }, 60_000);
  setTimeout(() => { tick(); }, 20_000);

  return {
    alEmpezar,
    alReanudar,
    alTerminar,
    activo: () => cfg().activo,
    hayPendiente: () => Boolean(s.pendiente),
    // Publicar ya un video de la bandeja (botón de la app).
    publicarAhora(item) {
      if (!cfg().activo) throw new Error('El piloto automático está apagado (config.json → autoPublicar.activo)');
      if (s.cola.some((e) => e.itemId === item.id && !e.avisado)) throw new Error('Ese video ya está en la fila para publicarse');
      // Se salta toda red donde ya salió (según la bandeja Y según el historial de la cola), para no duplicar.
      const yaSalio = new Set(Object.keys(item.publicado ?? {}).filter((k) => item.publicado[k]));
      for (const e of s.cola.filter((x) => x.itemId === item.id)) {
        for (const [k, d] of Object.entries(e.destinos)) if (['ok', 'enviado', 'dudoso'].includes(d.estado)) yaSalio.add(k);
      }
      if (!encolar(item, Date.now(), { conX: usarX() && !yaSalio.has('x'), saltar: [...yaSalio] })) throw new Error('Ya está publicado en todas tus redes conectadas');
      setTimeout(() => { tick(); }, 1000);
    },
    // Lo que viene y lo que ya salió (para la app).
    cola: () => s.cola.map((e) => ({ id: e.itemId, titulo: e.titulo, cuando: new Date(e.cuando).toISOString(), destinos: Object.fromEntries(Object.entries(e.destinos).map(([k, d]) => [k, { estado: d.estado, url: d.url ?? null, error: d.error ?? null }])) })),
    pendiente: () => (s.pendiente ? { publicaA: new Date(s.pendiente.termino + cfg().minutosDespues * 60_000).toISOString() } : null),
    _tick: tick, _estado: () => s,
  };
}

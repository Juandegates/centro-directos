// Piloto automático de publicaciones (v5).
// - Al terminar un directo espera 1 hora (por si fue un apagón y te reconectas). Si vuelves, es el mismo directo.
// - Luego Claude elige los 3 mejores momentos, se arma el video resumen de 1:30, y se publican espaciados
//   (el 1º de inmediato y los demás cada 3 horas) en TikTok, YouTube Shorts, Facebook, Instagram y X.
// - Los días sin directo, a las 6 pm, sale un video "gancho" con lo mejor que quedó guardado.
// v5.8 — PLAN DIARIO (predeterminado): lo de los directos de HOY se prepara y se guarda; mañana a las 7 am Claude
//   compara todo lo del día y elige los 3 mejores, que salen a horas fijas (1, 6 y 9 pm). Si ayer no hubo directo,
//   salen del historial. Máximo 3 al día; en YouTube solo los 2 mejores (su límite).
import { readFileSync, writeFileSync } from 'node:fs';
import { lista as bandeja, actualizar, CARPETA_CLIPS } from './bandeja.js';
import { publicarEn, confirmar, destinosListos, NOMBRES, xPorBuffer, canalesBuffer, bufferConfigurado, esDeBuffer, buscarPostBuffer } from './publicar.js';
import { log, marcar, verPartes } from './estado.js';

const ARCHIVO = new URL('./publicacion.json', import.meta.url);
// ¿El error fue por falta de internet? Esos no cuentan como intento: se espera a que vuelva la red.
const RED = /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT|UND_ERR_SOCKET|socket hang up|network/i;
const esDeRed = (err) => RED.test(`${err?.message ?? ''} ${err?.cause?.code ?? ''} ${err?.cause?.message ?? ''}`);
// Límite diario de YouTube (por Buffer): son 2 Shorts en 24 h para tu canal. Los demás esperan su turno.
const LIMITE_YT = /maximum number of posts|daily posting limit|posting limit/i;
const sinInternet = () => verPartes().find((x) => x.id === 'internet')?.estado === 'error';
const HORA = 3600_000;
const hoy = () => new Date().toLocaleDateString('en-CA'); // AAAA-MM-DD en tu hora local
const mes = () => hoy().slice(0, 7);

function leer() {
  try { return { pendiente: null, cola: [], pool: [], ultimoPlan: null, ultimoGancho: null, ultimoDirecto: null, xMes: { mes: mes(), usados: 0 }, ...JSON.parse(readFileSync(ARCHIVO, 'utf8')) }; } catch {
    return { pendiente: null, cola: [], pool: [], ultimoPlan: null, ultimoGancho: null, ultimoDirecto: null, xMes: { mes: mes(), usados: 0 } };
  }
}

export function crearAutopublicar({ leerConfig, candidatos, resumen, avisar, urlApp, enVivo }) {
  let s = leer();
  const guardar = () => writeFileSync(ARCHIVO, JSON.stringify(s, null, 2));
  const cfg = () => ({ activo: true, minutosDespues: 60, horasEntre: 3, clipsPorDirecto: 3, resumen: true, horaGancho: '18:00', maxXMes: 10, minimoMinutos: 10,
    silencio: { desde: 0, hasta: 9 }, planDiario: true, horaPlan: '07:00', horarios: ['13:00', '18:00', '21:00'], videosPorDia: 3, youtubePorDia: 2,
    ...(leerConfig().autoPublicar ?? {}) });
  const diaDe = (ms) => new Date(ms).toLocaleDateString('en-CA');
  const ayer = () => diaDe(Date.now() - 24 * HORA);
  const aHoraDeHoy = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); const f = new Date(); f.setHours(h, m || 0, 0, 0); return f.getTime(); };
  const horaCorta = (ms) => new Date(ms).toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' });
  // Horario de silencio (de 12 am a 9 am): un video que caiga ahí se recorre a las 9 am (casi nadie ve de madrugada).
  function fueraDeSilencio(cuando) {
    const { desde = 0, hasta = 9 } = cfg().silencio ?? {};
    if (desde === hasta) return cuando;
    const f = new Date(cuando);
    const h = f.getHours();
    const dentro = desde < hasta ? h >= desde && h < hasta : h >= desde || h < hasta;
    if (!dentro) return cuando;
    if (desde > hasta && h >= desde) f.setDate(f.getDate() + 1); // p. ej. silencio de 11 pm a 9 am, a las 11:30 pm → mañana
    f.setHours(hasta, 0, 0, 0);
    return f.getTime();
  }
  // Recorre los videos que todavía no salen y caen en el silencio, manteniendo la separación entre ellos.
  function reacomodarSilencio() {
    const sep = cfg().horasEntre * HORA;
    const sinEmpezar = (e) => Object.values(e.destinos).every((d) => d.estado === 'pendiente' && !d.intentos) && !e.manual;
    let anterior = 0;
    let cambio = false;
    for (const e of [...s.cola].sort((a, b) => a.cuando - b.cuando)) {
      if (!sinEmpezar(e)) { anterior = Math.max(anterior, e.cuando); continue; }
      let c = fueraDeSilencio(e.cuando);
      if (c !== e.cuando && anterior && c < anterior + sep) c = fueraDeSilencio(anterior + sep);
      if (c !== e.cuando) {
        log(`🌙 "${e.titulo}" caía de madrugada: sale el ${new Date(c).toLocaleString('es-MX', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`);
        e.cuando = c; cambio = true;
        actualizar(e.itemId, { programado: new Date(c).toISOString() });
      }
      anterior = e.cuando;
    }
    if (cambio) guardar();
  }
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
    s.cola.push({ itemId: item.id, titulo: item.titulo, cuando, ...(item.manual ? { manual: true } : {}), destinos: Object.fromEntries(listos.map((d) => [d, { estado: 'pendiente', intentos: 0 }])) });
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
    const diaDirecto = diaDe(s.pendiente.termino ?? Date.now());
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
    if (c.planDiario) {
      // Plan diario: se guardan para mañana; a las 7 am Claude elige los mejores de todo el día.
      s.pool = [...(s.pool ?? []), ...videos.map((v) => ({ itemId: v.id, dia: diaDirecto, puntos: v.puntos ?? 8, resumen: Boolean(v.resumen) }))];
      guardar();
      const lista = videos.map((v, i) => `${i + 1}. ${v.titulo}`).join('\n');
      avisar('🎬 Videos del directo preparados', `${lista}\nMañana Claude elige los ${c.videosPorDia} mejores del día y salen a las ${c.horarios.join(', ')}.`, { abrir: `${urlApp()}#publicar`, etiquetas: ['clapper'], clave: 'preparados-' + Date.now() });
      log(`🗂️ ${videos.length} video(s) del directo preparados para el plan de mañana`);
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

  // ---------- Plan diario (7 am): los 3 mejores del día anterior, a horas fijas ----------
  async function planDelDia() {
    const c = cfg();
    s.ultimoPlan = hoy();
    guardar();
    if (!destinosListos(leerConfig()).length) return;
    const limite3 = diaDe(Date.now() - 3 * 24 * HORA);
    s.pool = (s.pool ?? []).filter((p) => p.dia >= limite3);
    const delPool = s.pool.filter((p) => p.dia < hoy());
    const items = delPool.map((p) => ({ ...bandeja().find((x) => x.id === p.itemId), puntos: p.puntos })).filter((i) => i.id && !Object.values(i.publicado ?? {}).some(Boolean));
    // ¿Cuántos caben hoy? (por si ya hay algo programado para hoy, por ejemplo de antes de este cambio)
    const finHoy = aHoraDeHoy('23:59');
    const yaHoy = s.cola.filter((e) => !e.manual && e.cuando >= aHoraDeHoy('00:00') && e.cuando <= finHoy).length;
    const caben = Math.max(0, c.videosPorDia - yaHoy);
    if (!caben) { log('📅 Hoy ya hay videos programados; el plan del día no agrega más'); s.pool = s.pool.filter((p) => p.dia >= hoy()); guardar(); return; }
    let elegidos = [];
    let origen = 'de los directos de ayer';
    if (items.length) {
      log(`📅 Plan del día: Claude compara ${items.length} video(s) de los directos de ayer`);
      elegidos = await candidatos.elegirDelDia(items, caben);
    } else if (s.ultimoDirecto !== ayer()) {
      origen = 'del historial (ayer no hubo directo)';
      log('📅 Plan del día: ayer no hubo directo; busco en el historial');
      elegidos = await candidatos.videosHistorial(caben);
    }
    s.pool = s.pool.filter((p) => p.dia >= hoy()); // lo de días anteriores ya se consideró
    guardar();
    if (!elegidos.length) { log('📅 Plan del día: no hay videos buenos para hoy'); return; }
    // Horarios: los fijos que todavía no pasan (si el plan corre tarde, salen menos ese día; si ya pasaron todos, uno en 5 min).
    let horas = c.horarios.map(aHoraDeHoy).filter((t) => t > Date.now() + 5 * 60_000);
    if (!horas.length && Date.now() < aHoraDeHoy('22:00')) horas = [Date.now() + 5 * 60_000];
    const programados = [];
    elegidos.slice(0, horas.length).forEach((v, i) => {
      const saltar = i >= c.youtubePorDia ? ['youtube'] : []; // YouTube: solo los mejores (su límite diario)
      if (encolar({ ...v, plan: true }, horas[i], { conX: xPorBuffer() || (i === 0 && usarX()), saltar })) programados.push(`${horaCorta(horas[i])} · ${v.titulo}${saltar.length ? ' (sin YouTube)' : ''}`);
    });
    if (programados.length) avisar('📅 Videos de hoy', `${programados.join('\n')}\nSon los mejores ${origen}.`, { abrir: `${urlApp()}#publicar`, etiquetas: ['calendar'], clave: 'plan-' + hoy() });
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

  // ---------- Límite diario de YouTube ----------
  const maxYoutube = () => Math.max(1, Number(cfg().maxYoutubeDia ?? 2));
  // Horas (ms) de los Shorts que salieron o se mandaron a YouTube en las últimas 24 h.
  const salidasYoutube = () => s.cola.flatMap((e) => {
    const d = e.destinos.youtube;
    return d && ['ok', 'enviado', 'dudoso'].includes(d.estado) && d.hora && Date.now() - d.hora < 24 * HORA ? [d.hora] : [];
  }).sort((a, b) => a - b);
  // ¿Cuándo se libera el siguiente lugar en YouTube? (null = hay lugar ya)
  function turnoYoutube() {
    const h = salidasYoutube();
    if (h.length < maxYoutube()) return null;
    return fueraDeSilencio(h[h.length - maxYoutube()] + 24 * HORA + 10 * 60_000);
  }
  // Si el turno de YouTube queda más de 36 h después de lo programado, ese video ya no va a YouTube (se queda en las demás redes).
  function esperarTurnoYoutube(e, d, item) {
    const turno = turnoYoutube() ?? Date.now() + 3 * HORA;
    if (turno - e.cuando > 36 * HORA) {
      d.estado = 'cancelado'; d.error = `Sin lugar en YouTube (máx. ${maxYoutube()} Shorts al día); salió en las demás redes`;
      log(`⏭️ YouTube Shorts: "${item.titulo}" se queda fuera (límite de ${maxYoutube()} al día); sí sale en las demás redes`);
    } else {
      d.siguiente = turno; d.error = `Límite de YouTube (${maxYoutube()} al día): sale el ${new Date(turno).toLocaleString('es-MX', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
      log(`⏳ YouTube Shorts: "${item.titulo}" espera su turno (límite de ${maxYoutube()} al día)`);
    }
    guardar();
  }

  // Lo que falló por falta de internet (en las últimas 48 h) vuelve a la fila, espaciado como siempre.
  // Así, después de un apagón o un corte de internet, nada se queda atrasado para siempre.
  function recuperarCaidos() {
    const recientes = s.cola.filter((e) => e.cuando > Date.now() - 48 * HORA);
    const recuperados = [];
    for (const e of recientes) {
      let tocado = false;
      for (const [destino, d] of Object.entries(e.destinos)) {
        if (d.recuperado) continue; // se recupera una sola vez (si vuelve a fallar, ya no es por la red)
        const porRed = RED.test(d.error ?? '') || LIMITE_YT.test(d.error ?? '') || /Sin internet|No pude comprobar en Buffer|Tardó demasiado|Buffer tardó|Media upload has failed/i.test(d.error ?? '');
        if (d.estado === 'error' && porRed) { Object.assign(d, { estado: 'pendiente', intentos: 0, siguiente: 0 }); d.recuperado = true; tocado = true; }
        // Buffer: si quedó "dudoso" y tiene su número de post, se vuelve a confirmar (no se reenvía).
        else if (d.estado === 'dudoso' && d.info?.id && d.info?.canal) { Object.assign(d, { estado: 'enviado', confirmado: false, hora: Date.now() - 9 * 60_000 }); d.recuperado = true; tocado = true; }
        else if (d.estado === 'dudoso' && esDeBuffer(destino) && /Tardó demasiado/i.test(d.error ?? '')) { Object.assign(d, { estado: 'pendiente', intentos: 1, siguiente: 0 }); d.recuperado = true; tocado = true; }
      }
      if (tocado) { e.avisado = false; if (Object.values(e.destinos).some((d) => d.estado === 'pendiente')) recuperados.push(e); }
    }
    if (!recuperados.length) return;
    log(`🔁 Volvió el internet: ${recuperados.length} video(s) que no pudieron salir vuelven a la fila`);
    avisar('🔁 Publicaciones retomadas', `${recuperados.map((e) => e.titulo).join('\n')}\nNo pudieron salir por falta de internet; ya vuelven a la fila.`, { abrir: `${urlApp()}#publicar`, clave: 'retomadas-' + hoy() });
    guardar();
  }

  // Si se juntaron varios atrasados (corte de internet, PC apagada), sale uno ya y los demás cada N horas.
  function espaciarAtrasados() {
    const sep = cfg().horasEntre * HORA;
    const ahora = Date.now();
    const atrasados = s.cola
      .filter((e) => e.cuando <= ahora && !e.manual && Object.values(e.destinos).every((d) => d.estado === 'pendiente'))
      .sort((a, b) => a.cuando - b.cuando);
    if (atrasados.length < 2) return;
    let t = ahora;
    for (const e of atrasados.slice(1)) {
      t += sep;
      e.cuando = t;
      actualizar(e.itemId, { programado: new Date(t).toISOString() });
      log(`⏱️ "${e.titulo}" se había atrasado: sale a las ${new Date(t).toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' })}`);
    }
    guardar();
  }

  async function publicarPendientes() {
    const config = leerConfig();
    if (sinInternet()) return; // sin red no se gasta ningún intento
    recuperarCaidos();
    espaciarAtrasados();
    reacomodarSilencio();
    for (const e of s.cola) {
      if (e.cuando > Date.now()) continue;
      const item = bandeja().find((x) => x.id === e.itemId);
      if (!item) { for (const d of Object.values(e.destinos)) if (d.estado === 'pendiente') d.estado = 'cancelado'; e.avisado = true; continue; }
      for (const [destino, d] of Object.entries(e.destinos)) {
        if (d.estado === 'enviado' && Date.now() - d.hora > 8 * 60_000 && !d.confirmado) {
          // Buffer: ¿ya salió de verdad?
          const r = await confirmar(destino, d.info).catch(() => ({ estado: 'desconocido' }));
          if (r.estado === 'sent') { d.estado = 'ok'; d.url = r.url ?? d.url; d.confirmado = true; actualizar(item.id, { publicado: { [destino]: d.url || true } }); }
          else if (r.estado === 'error' && LIMITE_YT.test(r.error ?? '')) { d.estado = 'pendiente'; d.info = null; esperarTurnoYoutube(e, d, item); }
          else if (r.estado === 'error') { d.estado = 'pendiente'; d.intentos++; d.error = r.error; d.siguiente = Date.now() + 20 * 60_000; log(`⚠️ ${NOMBRES[destino]} rechazó "${item.titulo}": ${r.error}`, { nivel: 'aviso' }); }
          else if (Date.now() - d.hora > 2 * HORA && !sinInternet()) { d.confirmado = true; d.estado = 'dudoso'; log(`❔ No pude confirmar si "${item.titulo}" salió en ${NOMBRES[destino]}; revísalo en la app de ${NOMBRES[destino]}`, { nivel: 'aviso' }); }
          continue;
        }
        if (d.estado !== 'pendiente' || (d.siguiente ?? 0) > Date.now()) continue;
        if (destino === 'youtube' && turnoYoutube() !== null) { esperarTurnoYoutube(e, d, item); continue; }
        if (d.intentos >= 3) { d.estado = 'error'; continue; }
        // Antes de crear un post en Buffer: ¿ya existe uno igual? (un intento anterior que sí llegó)
        const yaIntentado = d.intentos > 0 || s.cola.some((o) => o !== e && o.itemId === e.itemId && o.destinos[destino]);
        if (esDeBuffer(destino)) {
          let previo = null;
          try { previo = await buscarPostBuffer(destino, item, config); } catch (err) {
            if (esDeRed(err)) { d.error = 'Sin internet; se publica cuando vuelva'; d.siguiente = Date.now() + 5 * 60_000; guardar(); continue; }
            if (yaIntentado) { // no se puede comprobar: mejor no arriesgar a duplicarlo; se vuelve a revisar en 20 min
              d.intentos++; d.error = 'No pude comprobar en Buffer si ya salió: ' + err.message; d.siguiente = Date.now() + 20 * 60_000;
              log(`⚠️ ${NOMBRES[destino]}: no pude comprobar si "${item.titulo}" ya está en Buffer; no lo reenvío todavía`, { nivel: 'aviso' });
              if (d.intentos >= 3) { d.estado = 'error'; avisar(`⚠️ No pude publicar en ${NOMBRES[destino]}`, `${item.titulo}\nRevisa en Buffer si salió.`, { clave: `pub-${destino}-${item.id}` }); }
              guardar(); continue;
            }
          }
          if (previo) {
            d.info = previo; d.estado = 'enviado'; d.hora = Date.now(); d.error = null;
            log(`🔁 ${NOMBRES[destino]}: "${item.titulo}" ya estaba en Buffer; no lo vuelvo a enviar`);
            guardar(); continue;
          }
        }
        try {
          const r = await publicarEn(destino, item, { config, carpetaClips: CARPETA_CLIPS });
          d.info = r; d.url = r.url ?? null; d.hora = Date.now(); d.error = null;
          if (r.pendiente) d.estado = 'enviado';
          else { d.estado = 'ok'; actualizar(item.id, { publicado: { [destino]: r.url || true } }); }
          if (destino === 'x' && !xPorBuffer()) { s.xMes.usados++; }
          log(`📤 ${NOMBRES[destino]}: "${item.titulo}" ${r.pendiente ? 'enviado (confirmando)' : 'publicado'}`);
          marcar('publicar', 'ok', `Último: ${NOMBRES[destino]} · ${item.titulo}`);
        } catch (err) {
          if (destino === 'youtube' && LIMITE_YT.test(err.message)) { esperarTurnoYoutube(e, d, item); continue; }
          // Sin internet: no cuenta como intento; se vuelve a probar cada 5 min hasta que regrese la red.
          if (esDeRed(err) && !(err.name === 'TimeoutError')) {
            d.error = 'Sin internet; se publica cuando vuelva'; d.siguiente = Date.now() + 5 * 60_000;
            log(`📴 Sin internet: "${item.titulo}" sale en ${NOMBRES[destino]} cuando vuelva la red`, { nivel: 'aviso' });
            guardar(); continue;
          }
          // En Buffer un tiempo agotado no es riesgo: antes de reenviar se revisa si ya existe (no se duplica).
          if ((err.name === 'TimeoutError' || /timeout|aborted/i.test(err.message)) && esDeBuffer(destino)) {
            d.intentos++; d.error = 'Buffer tardó en responder; reviso y reintento'; d.siguiente = Date.now() + 10 * 60_000;
            if (d.intentos >= 3) d.estado = 'error';
            guardar(); continue;
          }
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
      if (c.planDiario) {
        const [ph, pm] = String(c.horaPlan).split(':').map(Number);
        if (ahora.getHours() * 60 + ahora.getMinutes() >= ph * 60 + (pm || 0) && s.ultimoPlan !== hoy() && !s.pendiente?.procesando) await planDelDia();
      } else if (yaEsHora && !enVivo() && !s.pendiente && s.ultimoDirecto !== hoy() && s.ultimoGancho !== hoy()) await ganchoDelDia();
      reacomodarSilencio();
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
      if (!encolar({ ...item, manual: true }, Date.now(), { conX: usarX() && !yaSalio.has('x'), saltar: [...yaSalio] })) throw new Error('Ya está publicado en todas tus redes conectadas');
      setTimeout(() => { tick(); }, 1000);
    },
    // Lo que viene y lo que ya salió (para la app).
    cola: () => s.cola.map((e) => ({ id: e.itemId, titulo: e.titulo, cuando: new Date(e.cuando).toISOString(), destinos: Object.fromEntries(Object.entries(e.destinos).map(([k, d]) => [k, { estado: d.estado, url: d.url ?? null, error: d.error ?? null }])) })),
    pendiente: () => (s.pendiente ? { publicaA: new Date(s.pendiente.termino + cfg().minutosDespues * 60_000).toISOString() } : null),
    _tick: tick, _estado: () => s, _plan: planDelDia,
  };
}

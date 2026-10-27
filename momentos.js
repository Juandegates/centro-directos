// Detector de momentos: encuentra lo mejor del directo aunque nadie escriba en el chat.
// 1) Mide el volumen de cada pedacito de 10 s que ya se graba (explosiones, jefes, gritos).
// 2) Cuando algo suena más fuerte de lo normal (o cada cierto tiempo), la IA mira la pantalla
//    y califica el momento del 1 al 10.
// 3) Los momentos con buena calificación se vuelven clip solos.
// 3b) Si en 30 minutos no salió ningún clip, se hace uno del mejor momento de ese rato (mínimo 7/10).
// 3c) Si los últimos momentos fueron puro menú o pantalla de carga, se pregunta menos seguido (ahorra IA).
// 4) Peleas de jefe: se siguen por su BARRA DE VIDA (los jefes con varias fases cambian de sala).
//    La pelea solo termina con una señal clara (ganaste o perdiste). Entonces se revisa lo ya grabado
//    para encontrar el momento exacto y se hace el clip del final del primer intento y, si perdiste,
//    otro cuando por fin lo derrotas.
import { readdirSync, statSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARPETA } from './captura.js';
import { medirVolumen, correrFfmpeg } from './herramientas.js';

// Pedacitos de ~30 s de cada momento revisado: con ellos se arma el video resumen de 1:30 al final.
export const CARPETA_PIEZAS = fileURLToPath(new URL('./piezas/', import.meta.url));
const MAX_PIEZAS = 40;
import { preguntarIA } from './ia.js';
import { log } from './estado.js';

const mediana = (xs) => {
  const o = [...xs].sort((a, b) => a - b);
  return o.length ? o[Math.floor(o.length / 2)] : 0;
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const leerJSON = (r) => JSON.parse(r.slice(r.indexOf('{'), r.lastIndexOf('}') + 1));

export function crearMomentos({ captura, leerConfig, datos, clips }) {
  let medidos = new Set();
  let volumenes = []; // { nombre, media, pico }
  let momentos = []; // { hora, puntos, que, motivo, clip }
  let ultimaEvaluacion = 0;
  let ultimoClip = 0;
  let clipsHoy = 0;
  let evaluando = false;
  // Pelea de jefe en curso: { nombre, inicio, ultimoVisto, vida, intentos, primerClip }
  let jefe = null;
  // Jefes que creímos vencidos en este directo: nombre → { hora, inicio, intentos }.
  // Si vuelve a verse su barra con vida, la "victoria" era otra fase o un error: se retoma la pelea.
  let vencidos = new Map();
  let inicioVentana = Date.now(); // para "el mejor momento de cada 30 min"
  let ultimoClipHecho = 0;
  let piezas = []; // { hora, puntos, que, ruta }

  // Guarda ~30 s alrededor del momento (22 s antes y 10 s después), sin recomprimir.
  async function guardarPieza(m) {
    await esperar(12_000); // que se grabe lo que pasó justo después
    if (!captura.activa()) return;
    const rutas = captura.pedazosEntre(m.hora - 22_000, m.hora + 10_000);
    if (!rutas.length) return;
    mkdirSync(CARPETA_PIEZAS, { recursive: true });
    const lista = join(CARPETA_PIEZAS, `${m.hora}.txt`);
    const ruta = join(CARPETA_PIEZAS, `${m.hora}_${m.puntos}.ts`);
    writeFileSync(lista, rutas.map((r) => `file '${r.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    try {
      await correrFfmpeg(leerConfig(), ['-f', 'concat', '-safe', '0', '-i', lista, '-c', 'copy', ruta]);
      piezas.push({ hora: m.hora, puntos: m.puntos, que: m.que, ruta });
      // Si ya hay muchas, se borra la peor calificada (las buenas se quedan).
      if (piezas.length > MAX_PIEZAS) {
        const peor = [...piezas].sort((a, b) => a.puntos - b.puntos || a.hora - b.hora)[0];
        piezas = piezas.filter((p) => p !== peor);
        rmSync(peor.ruta, { force: true });
      }
    } catch { /* pedacitos en uso: no pasa nada */ } finally {
      rmSync(lista, { force: true });
    }
  }

  const cfg = () => ({
    activo: true, dbSobreNormal: 6, puntosParaClip: 7, minutosEntreClips: 8, maxPorDirecto: 6, minutosRevision: 12,
    segundosRevisionJefe: 120, minutosSinVerJefe: 20, minutosMejorMomento: 30, minimoMejorMomento: 7,
    ...(leerConfig().momentos ?? {}),
  });
  const MUERTE = /muer[eit]|muerte|derrot|game ?over|ca[ií]d[oa]|perdi[oó]|reaparec/i;
  let destacados = []; // lo más fuerte del directo (por ejemplo, jefes vencidos), para el título del resumen

  // ---------- revisión de lo ya grabado: ¿cuándo terminó la pelea y quién ganó? ----------
  // tipo: lo que creemos ('victoria', 'derrota' o 'no_se'). Devuelve { hora, resultado, que, foto }.
  async function buscarFinal(tipo, { desde = null, hasta = null } = {}) {
    const ahora = Date.now();
    // Por defecto: desde poco antes de la última vez que vimos al jefe (máx. 6 min atrás) hasta ahora.
    const ini = desde ?? Math.max(ahora - 6 * 60_000, (jefe.ultimoVisto || ahora) - 90_000);
    const fin = Math.min(hasta ?? ahora, ahora - 5_000);
    for (let intento = 0; intento < 4; intento++) {
      const cuadros = await captura.cuadrosEntre(ini, fin, 10);
      if (cuadros.length < 3) break;
      try {
        const r = await preguntarIA({
          sistema: 'Eres editor de videos de videojuegos. Analizas una secuencia de capturas de un directo para encontrar el momento exacto en que termina una pelea contra un jefe.',
          imagenes: cuadros,
          texto:
            `Juego: ${datos.actual().juego}. Jefe: ${jefe.nombre || '(sin nombre)'}. Te mando ${cuadros.length} imagenes en orden, una cada 10 segundos (la 1 es la mas vieja).\n` +
            'Ojo: el jefe puede tener varias fases y cambiar de sala; mientras su barra de vida siga en pantalla o no llegue a cero, la pelea NO ha terminado.\n' +
            'Victoria = se ve que el jefe cae, su barra llega a cero, mensaje de victoria, escena o dialogo tras vencerlo, o recompensa del jefe. ' +
            'Derrota = pantalla de muerte o game over del jugador, o el jugador reaparece lejos sin haber vencido al jefe.\n' +
            (tipo === 'no_se' ? 'No sabemos que paso: decide tu con lo que se ve.\n' : `Lo que creemos que paso: ${tipo === 'victoria' ? 'el jugador gano' : 'el jugador perdio'}. Confirmalo o corrigelo.\n`) +
            'Devuelve SOLO un JSON: {"fin": numero de la imagen donde se ve el golpe final al jefe o la muerte del jugador, ' +
            '"resultado": "victoria" | "derrota" | "no_se" (si en estas imagenes no termina la pelea o no se puede saber), "que": "lo que pasa en 4 a 10 palabras, en espanol"}',
        });
        const j = leerJSON(r);
        const n = Math.max(1, Math.min(cuadros.length, Math.round(Number(j.fin) || cuadros.length)));
        const resultado = ['victoria', 'derrota'].includes(j.resultado) ? j.resultado : (tipo === 'no_se' ? 'no_se' : tipo);
        return { hora: cuadros[n - 1].hora, resultado, que: String(j.que ?? '').slice(0, 80), foto: cuadros[n - 1] };
      } catch {
        log('⚔️ La IA está ocupada; vuelvo a revisar lo grabado en 1 minuto', { parte: 'clips' });
        await esperar(60_000);
      }
    }
    // Sin IA: usamos la última vez que vimos al jefe.
    return { hora: (jefe.ultimoVisto || ahora) + 15_000, resultado: tipo, que: '', foto: null };
  }

  // Texto honesto de cuánto costó: intentos contados y/o tiempo de pelea.
  function cuantoCosto() {
    const intento = jefe.intentos + 1;
    const min = Math.round((Date.now() - jefe.inicio) / 60_000);
    if (intento === 1 && min < 8) return 'al primer intento';
    const tiempo = min >= 50 ? 'casi una hora' : `${min} minutos`;
    if (intento >= 3) return `despues de ${intento} intentos${min >= 15 ? ` y ${tiempo} de pelea` : ''}`;
    return `despues de ${tiempo} de intentos`; // con pocos intentos contados pero mucho tiempo, decimos el tiempo
  }

  // Clip del final de una pelea: ~55 s antes del momento final y ~12 s después.
  async function clipFinal(tipo, previo = null) {
    const final = previo ?? await buscarFinal(tipo);
    const n = jefe.nombre || 'el jefe';
    let que;
    if (final.resultado === 'victoria') {
      const costo = cuantoCosto();
      const aQuien = jefe.nombre ? `a ${jefe.nombre}` : 'al jefe';
      que = costo === 'al primer intento' ? `derroto ${aQuien} al primer intento` : `por fin derroto ${aQuien} ${costo}`;
      destacados.push(que);
    } else {
      que = `${n} me derroto en el intento ${jefe.intentos + 1}`;
    }
    if (final.que) que += ` · ${final.que}`;
    log(`⚔️ Final de la pelea encontrado (${final.resultado}); armando clip: ${que}`, { parte: 'clips' });
    // El final también entra al video resumen.
    guardarPieza({ hora: final.hora, puntos: final.resultado === 'victoria' ? 10 : 8, que }).catch(() => {});
    // Si se está armando otro clip, esperamos un poco (los pedacitos se guardan 35 min).
    for (let i = 0; i < 12; i++) {
      const item = await clips.crear(`jefe: ${que}`, {
        puntos: 10, que, saltarEspera: true,
        rango: { desde: final.hora - 55_000, hasta: final.hora + 12_000 },
        fotosMomento: final.foto ? [final.foto] : null,
      }).catch(() => null);
      if (item) { clipsHoy++; ultimoClipHecho = Date.now(); return final.resultado; }
      await esperar(10_000);
    }
    return final.resultado;
  }

  // Termina un intento (ganaste o perdiste). `previo`: lo que ya encontró la revisión de lo grabado.
  async function terminarIntento(tipo, previo = null) {
    const j = jefe;
    const debeGrabar = tipo === 'victoria' || !j.primerClip; // el primer intento siempre; luego solo la victoria
    let resultado = tipo;
    if (debeGrabar) resultado = await clipFinal(tipo, previo);
    if (resultado === 'victoria') {
      log(`⚔️ ¡Jefe vencido${j.nombre ? `: ${j.nombre}` : ''}!`, { parte: 'clips' });
      if (j.nombre) vencidos.set(j.nombre.toLowerCase(), { hora: Date.now(), inicio: j.inicio, intentos: j.intentos });
      jefe = null;
    } else {
      j.intentos++;
      j.primerClip = true;
      j.vida = 100;
      log(`⚔️ Intento perdido (${j.intentos} en total); sigo atento a la pelea`, { parte: 'clips' });
    }
  }

  // El jefe ya no se ve: revisamos lo grabado para saber si ganaste, perdiste o solo cambió de sala.
  async function revisarDesaparicion() {
    const final = await buscarFinal('no_se');
    if (!jefe) return;
    if (final.resultado === 'victoria' || final.resultado === 'derrota') {
      log(`⚔️ Lo grabado dice: ${final.resultado}${final.que ? ` (${final.que})` : ''}`, { parte: 'clips' });
      await terminarIntento(final.resultado, final);
    }
  }

  // Sigue la pelea con lo que respondió la IA. Devuelve true si la pelea se está siguiendo.
  async function seguirJefe(j) {
    let senal = String(j.resultado ?? '').toLowerCase();
    const barra = j.vidaJefe === null || j.vidaJefe === undefined || j.vidaJefe === '' ? null : Number(j.vidaJefe);
    const enPelea = j.jefe === true || j.jefe === 'true' || Number.isFinite(barra);
    const nombre = String(j.nombreJefe ?? '').slice(0, 40);
    if (!jefe) {
      if (!enPelea) return false;
      const antes = nombre ? vencidos.get(nombre.toLowerCase()) : null;
      if (antes) {
        // Justo después de vencerlo puede seguir viéndose su barra vacía o la escena final: eso no cuenta.
        const conVida = Number.isFinite(barra) && barra > 0;
        if (!conVida && Date.now() - antes.hora < 5 * 60_000) return false;
        if (!conVida && senal !== 'pelea') return false;
        // Su barra volvió con vida: la "victoria" fue otra fase o un error. Retomamos la misma pelea.
        vencidos.delete(nombre.toLowerCase());
        destacados = destacados.filter((d) => !d.toLowerCase().includes(nombre.toLowerCase()));
        jefe = { nombre, inicio: antes.inicio, ultimoVisto: Date.now(), vida: Number.isFinite(barra) ? barra : 100, intentos: antes.intentos + 1, primerClip: true, revisado: false };
        log(`⚔️ ${nombre} sigue en pie (era otra fase o no lo habías vencido); retomo la pelea`, { parte: 'clips' });
        if (senal !== 'victoria' && senal !== 'derrota') return true;
      } else {
        jefe = { nombre, inicio: Date.now(), ultimoVisto: Date.now(), vida: Number.isFinite(barra) ? barra : 100, intentos: 0, primerClip: false, revisado: false };
        log(`⚔️ Empezó una pelea de jefe${nombre ? `: ${nombre}` : ''}; la sigo hasta que ganes`, { parte: 'clips' });
      }
      if (senal !== 'victoria' && senal !== 'derrota') return true;
    }
    if (nombre && !jefe.nombre) jefe.nombre = nombre;
    // Si la IA describe una muerte a media pelea, cuenta como intento perdido aunque no lo marque.
    if (senal !== 'victoria' && senal !== 'derrota' && MUERTE.test(String(j.que ?? ''))) senal = 'derrota';
    // Si la barra del jefe "se llenó" de nuevo, es que perdiste y volviste a intentarlo.
    if (Number.isFinite(barra) && jefe.vida <= 60 && barra >= jefe.vida + 35 && senal !== 'victoria') {
      log(`⚔️ La vida del jefe volvió a ${barra}% (estaba en ${jefe.vida}%): cuento un intento perdido`, { parte: 'clips' });
      await terminarIntento('derrota');
      if (!jefe) return true;
      jefe.ultimoVisto = Date.now();
      jefe.vida = barra;
      return true;
    }
    if (enPelea) {
      jefe.ultimoVisto = Date.now();
      jefe.revisado = false;
      if (Number.isFinite(barra)) jefe.vida = barra;
    }
    if (senal === 'victoria') { await terminarIntento('victoria'); return true; }
    if (senal === 'derrota') { await terminarIntento('derrota'); return true; }
    if (!enPelea) {
      // La primera vez que deja de verse, revisamos lo grabado: ¿ganaste, perdiste o cambió de sala?
      if (!jefe.revisado) {
        jefe.revisado = true;
        await revisarDesaparicion();
        if (!jefe) return true;
      }
      const minutos = (Date.now() - jefe.ultimoVisto) / 60_000;
      if (minutos >= cfg().minutosSinVerJefe) {
        // Antes de soltarla: ¿ganaste poco después de la última vez que lo vimos?
        log('⚔️ Hace rato que no veo la pelea; reviso lo grabado antes de soltarla', { parte: 'clips' });
        const final = await buscarFinal('no_se', { desde: jefe.ultimoVisto - 60_000, hasta: jefe.ultimoVisto + 7 * 60_000 });
        if (jefe && final.resultado === 'victoria') { await terminarIntento('victoria', final); return true; }
        if (jefe) log('⚔️ No encontré la victoria; dejo de seguir la pelea', { parte: 'clips' });
        jefe = null;
      }
      return false;
    }
    return true;
  }

  async function evaluar(motivo) {
    const c = cfg();
    // Si los 2 últimos momentos fueron menús, mapa o cargas (3/10 o menos), esperamos 4 min en vez de 1.5.
    const ultimos = momentos.slice(-2);
    const aburrido = ultimos.length === 2 && ultimos.every((m) => m.puntos <= 3);
    const espera = jefe ? c.segundosRevisionJefe * 1000 - 5_000 : aburrido ? 240_000 : 90_000;
    if (evaluando || Date.now() - ultimaEvaluacion < espera) return;
    const fotos = captura.recientes(5);
    if (!fotos.length) return;
    evaluando = true;
    ultimaEvaluacion = Date.now();
    const d = datos.actual();
    try {
      const r = await preguntarIA({
        sistema: 'Eres editor de videos cortos de videojuegos para TikTok y YouTube Shorts. Calificas que tan buen clip seria un momento de un directo.',
        imagenes: fotos,
        texto:
          `Juego: ${d.juego}. Estas son imagenes de los ultimos segundos del directo (la ultima es la mas reciente). Motivo de la revision: ${motivo}.\n` +
          'Califica del 1 al 10 que tan atractivo seria como clip corto para gente que NO conoce el canal: ' +
          '9-10 = pelea de jefe intensa, victoria o muerte espectacular, algo chistoso o sorprendente; 6-8 = combate con accion, descubrimiento o zona impresionante; ' +
          '1-5 = menus, mapa, inventario, caminar, dialogos, pantallas de carga o nada pasando.\n' +
          (jefe ? `IMPORTANTE: hay una pelea en curso contra el jefe ${jefe.nombre || '(sin nombre)'} (ultima vida vista: ${jefe.vida}%). Puede tener varias fases y cambiar de sala.\n` : '') +
          'Devuelve SOLO un JSON: {"puntos": numero, "que": "lo que pasa, en 3 a 8 palabras, en espanol", ' +
          '"jefe": true si se ve una pelea contra un jefe (barra de vida grande de jefe), si no false, ' +
          '"nombreJefe": "nombre del jefe si se lee en pantalla, o vacio", ' +
          '"vidaJefe": porcentaje aproximado de vida que le queda al jefe segun su barra (0 a 100), o null si no se ve su barra, ' +
          '"resultado": "victoria" SOLO si se ve claramente que el jefe fue vencido (barra en cero, mensaje de victoria, recompensa del jefe o escena de su derrota), ' +
          '"derrota" SOLO si se ve la pantalla de muerte o de game over del jugador, "pelea" si la pelea sigue, o "nada"}',
      });
      const j = leerJSON(r);
      const puntos = Math.max(1, Math.min(10, Math.round(Number(j.puntos) || 0)));
      const que = String(j.que ?? '').slice(0, 80);
      const m = { hora: Date.now(), puntos, que, motivo, clip: false, foto: puntos >= 5 ? fotos.at(-1) : null };
      momentos.push(m);
      if (momentos.length > 200) momentos.shift();
      if (puntos >= 3) guardarPieza(m).catch(() => {}); // menús y pantallas de carga no sirven para el resumen
      const vida = j.vidaJefe !== null && j.vidaJefe !== undefined && Number.isFinite(Number(j.vidaJefe)) ? ` · jefe ${j.vidaJefe}%` : '';
      log(`🎯 Momento (${motivo}): ${puntos}/10 · ${que}${vida}`, { parte: 'clips' });
      // Las peleas de jefe se graban al final (ver seguirJefe), no al empezar.
      if (await seguirJefe(j)) return;
      if (jefe) return; // a media pelea (cambio de sala) no hacemos clips sueltos
      if (puntos >= c.puntosParaClip && clipsHoy < c.maxPorDirecto && Date.now() - ultimoClip > c.minutosEntreClips * 60_000) {
        ultimoClip = Date.now(); // se aparta de una vez para no lanzar dos clips del mismo momento
        clips.crear(`momento: ${que}`, { puntos, que, saltarEspera: true })
          .then((item) => { if (item) { clipsHoy++; m.clip = true; ultimoClipHecho = Date.now(); } else ultimoClip = 0; })
          .catch(() => { ultimoClip = 0; });
      }
    } catch { /* la IA estaba ocupada; habrá más momentos */ } finally {
      evaluando = false;
    }
  }

  async function revisarAudio() {
    const c = cfg();
    if (!c.activo || !captura.activa()) return;
    let archivos;
    try {
      archivos = readdirSync(CARPETA).filter((f) => f.endsWith('.ts')).sort();
    } catch { return; }
    // El último pedacito todavía se está grabando: lo dejamos para la siguiente vuelta.
    const listos = archivos.slice(0, -1).filter((f) => !medidos.has(f)).slice(-2);
    for (const f of listos) {
      medidos.add(f);
      const ruta = join(CARPETA, f);
      try {
        if (Date.now() - statSync(ruta).mtimeMs > 60_000) continue; // viejo: ya no sirve para un clip
        const v = await medirVolumen(leerConfig(), ruta);
        const normal = mediana(volumenes.map((x) => x.media));
        volumenes.push({ nombre: f, ...v });
        if (volumenes.length > 60) volumenes.shift();
        if (volumenes.length < 8) continue; // primero aprendemos cómo suena normalmente tu juego
        const sobre = v.media - normal;
        if (!jefe && (sobre >= c.dbSobreNormal || (v.pico > -1.5 && sobre >= c.dbSobreNormal / 2))) {
          await evaluar(`sonido fuerte (+${sobre.toFixed(1)} dB)`);
        }
      } catch { /* pedacito sin audio o en uso */ }
    }
    if (medidos.size > 2000) medidos = new Set([...medidos].slice(-500));
    // En plena pelea de jefe revisamos cada 2 min (el momento exacto se busca después en lo grabado).
    if (jefe) await evaluar('pelea de jefe');
    // Juegos con sonido parejo: cada tanto revisamos la pantalla aunque no haya picos.
    else if (Date.now() - ultimaEvaluacion > c.minutosRevision * 60_000) await evaluar('revisión periódica');
  }

  // Cada 30 min sin clips: clip del mejor momento de ese rato (de lo ya grabado).
  async function mejorDelRato() {
    const c = cfg();
    if (!captura.activa() || jefe) return;
    const ahora = Date.now();
    for (const m of momentos) if (m.foto && ahora - m.hora > 35 * 60_000) m.foto = null; // no guardar imágenes viejas
    if (ahora - inicioVentana < c.minutosMejorMomento * 60_000) return;
    const desde = inicioVentana;
    inicioVentana = ahora;
    if (ultimoClipHecho > desde) return; // ya salió algún clip en este rato
    // Solo momentos que todavía estén grabados (se guardan 35 min).
    const mejor = momentos.filter((m) => m.hora > desde && ahora - m.hora < 33 * 60_000 && !m.clip && m.puntos >= c.minimoMejorMomento)
      .sort((a, b) => b.puntos - a.puntos || b.hora - a.hora)[0];
    if (!mejor) { log(`🎬 En los últimos ${c.minutosMejorMomento} min no hubo un momento de al menos ${c.minimoMejorMomento}/10 para clip`, { parte: 'clips' }); return; }
    log(`🎬 Mejor momento de los últimos ${c.minutosMejorMomento} min (${mejor.puntos}/10): ${mejor.que}`, { parte: 'clips' });
    const item = await clips.crear(`mejor momento del rato: ${mejor.que}`, {
      puntos: mejor.puntos, que: mejor.que, saltarEspera: true,
      rango: { desde: mejor.hora - 45_000, hasta: mejor.hora + 15_000 },
      fotosMomento: mejor.foto ? [mejor.foto] : null,
    }).catch(() => null);
    if (item) { mejor.clip = true; clipsHoy++; ultimoClipHecho = Date.now(); }
  }

  setInterval(() => { revisarAudio().catch(() => {}); }, 10_000);
  setInterval(() => { mejorDelRato().catch(() => {}); }, 60_000);

  return {
    nuevoDirecto() {
      volumenes = [];
      momentos = [];
      clipsHoy = 0;
      ultimoClip = 0;
      jefe = null;
      vencidos = new Map();
      destacados = [];
      piezas = [];
      rmSync(CARPETA_PIEZAS, { recursive: true, force: true }); // las del directo anterior ya no sirven
      inicioVentana = Date.now();
      ultimoClipHecho = 0;
      ultimaEvaluacion = Date.now(); // la primera revisión periódica, a los pocos minutos
    },
    lista: () => momentos,
    piezas: () => piezas,
    destacados: () => destacados,
    // El Centro se reinició a media transmisión: recuperamos las piezas ya guardadas.
    retomar() {
      inicioVentana = Date.now();
      ultimaEvaluacion = Date.now();
      try {
        piezas = readdirSync(CARPETA_PIEZAS).filter((f) => /^\d+_\d+\.ts$/.test(f)).map((f) => {
          const [hora, puntos] = f.replace('.ts', '').split('_').map(Number);
          return { hora, puntos, que: '', ruta: join(CARPETA_PIEZAS, f) };
        });
      } catch { piezas = []; }
    },
    borrarPiezas() { piezas = []; rmSync(CARPETA_PIEZAS, { recursive: true, force: true }); },
    _evaluar: (motivo) => evaluar(motivo), // para pruebas
  };
}

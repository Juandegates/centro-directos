// Detector de momentos: encuentra lo mejor del directo aunque nadie escriba en el chat.
// 1) Mide el volumen de cada pedacito de 10 s que ya se graba (explosiones, jefes, gritos).
// 2) Cuando algo suena más fuerte de lo normal (o cada cierto tiempo), la IA mira la pantalla
//    y califica el momento del 1 al 10.
// 3) Los momentos con buena calificación se vuelven clip solos.
// 4) Peleas de jefe: no se graba el inicio. Se graba el FINAL del primer intento (ganes o pierdas)
//    y, si perdiste, el Centro sigue atento y graba el final de la pelea en que por fin lo derrotas.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CARPETA } from './captura.js';
import { medirVolumen } from './herramientas.js';
import { preguntarIA } from './ia.js';
import { log } from './estado.js';

const mediana = (xs) => {
  const o = [...xs].sort((a, b) => a - b);
  return o.length ? o[Math.floor(o.length / 2)] : 0;
};

export function crearMomentos({ captura, leerConfig, datos, clips }) {
  let medidos = new Set();
  let volumenes = []; // { nombre, media, pico }
  let momentos = []; // { hora, puntos, que, motivo, clip }
  let ultimaEvaluacion = 0;
  let ultimoClip = 0;
  let clipsHoy = 0;
  let evaluando = false;
  let jefe = null; // { nombre, intentos, primerClip, noVisto }

  const cfg = () => ({
    activo: true, dbSobreNormal: 6, puntosParaClip: 7, minutosEntreClips: 8, maxPorDirecto: 6, minutosRevision: 12,
    ...(leerConfig().momentos ?? {}),
  });

  // Clip del final de una pelea de jefe: ventana más larga (lo que pasó en el último minuto).
  async function clipJefe(tipo) {
    const n = jefe?.nombre || 'el jefe';
    const que = tipo === 'victoria'
      ? `por fin derroto a ${n}${jefe?.intentos ? ` despues de ${jefe.intentos + 1} intentos` : ' al primer intento'}`
      : `primer intento contra ${n}: ${tipo === 'derrota' ? 'me derroto' : 'final de la pelea'}`;
    log(`⚔️ Clip de jefe (${tipo === 'victoria' ? 'victoria' : 'primer intento'}): ${que}`, { parte: 'clips' });
    const item = await clips.crear(`jefe: ${que}`, { puntos: 10, que, saltarEspera: true, segundos: 70 }).catch(() => null);
    if (item) clipsHoy++;
    return Boolean(item);
  }

  // Sigue la pelea de jefe con lo que respondió la IA. Devuelve true si la IA está viendo una pelea de jefe.
  async function seguirJefe(j) {
    const resultado = String(j.resultado ?? '').toLowerCase();
    const enPelea = j.jefe === true || j.jefe === 'true';
    if (!jefe) {
      if (!enPelea) return false;
      jefe = { nombre: String(j.nombreJefe ?? '').slice(0, 40), intentos: 0, primerClip: false, noVisto: 0 };
      log(`⚔️ Empezó una pelea de jefe${jefe.nombre ? `: ${jefe.nombre}` : ''}; grabo el final de la pelea`, { parte: 'clips' });
      if (resultado !== 'victoria' && resultado !== 'derrota') return true;
    }
    if (j.nombreJefe && !jefe.nombre) jefe.nombre = String(j.nombreJefe).slice(0, 40);
    if (resultado === 'victoria') {
      await clipJefe('victoria');
      jefe = null;
      return true;
    }
    if (resultado === 'derrota') {
      jefe.intentos++;
      jefe.noVisto = 0;
      if (!jefe.primerClip) jefe.primerClip = await clipJefe('derrota');
      return true;
    }
    if (enPelea) { jefe.noVisto = 0; return true; }
    // Ya no se ve la pelea: probablemente acaba de terminar (o reapareciste tras morir).
    jefe.noVisto++;
    if (jefe.noVisto === 1 && !jefe.primerClip) jefe.primerClip = await clipJefe('fin');
    if (jefe.noVisto >= 6) { log('⚔️ Ya no veo la pelea de jefe; dejo de seguirla', { parte: 'clips' }); jefe = null; }
    return false;
  }

  async function evaluar(motivo) {
    if (evaluando || Date.now() - ultimaEvaluacion < (jefe ? 50_000 : 90_000)) return;
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
          '1-5 = menus, mapa, inventario, caminar, pantallas de carga o nada pasando.\n' +
          (jefe ? `Hace poco habia una pelea contra el jefe ${jefe.nombre || '(sin nombre)'}; fijate si sigue, si gano el jugador o si lo derrotaron.\n` : '') +
          'Devuelve SOLO un JSON: {"puntos": numero, "que": "lo que pasa, en 3 a 8 palabras, en espanol", ' +
          '"jefe": true si en pantalla hay una pelea contra un jefe (barra de vida grande del jefe, arena de jefe) o false, ' +
          '"nombreJefe": "nombre del jefe si se ve, o vacio", ' +
          '"resultado": "victoria" si se ve que el jugador acaba de vencer a un jefe, "derrota" si se ve pantalla de muerte o de game over, "pelea" si la pelea sigue, o "nada"}',
      });
      const j = JSON.parse(r.slice(r.indexOf('{'), r.lastIndexOf('}') + 1));
      const puntos = Math.max(1, Math.min(10, Math.round(Number(j.puntos) || 0)));
      const que = String(j.que ?? '').slice(0, 80);
      const m = { hora: Date.now(), puntos, que, motivo, clip: false };
      momentos.push(m);
      if (momentos.length > 200) momentos.shift();
      log(`🎯 Momento (${motivo}): ${puntos}/10 · ${que}`, { parte: 'clips' });
      // Las peleas de jefe se graban al final (ver seguirJefe), no al empezar.
      if (await seguirJefe(j)) return;
      const c = cfg();
      if (puntos >= c.puntosParaClip && clipsHoy < c.maxPorDirecto && Date.now() - ultimoClip > c.minutosEntreClips * 60_000) {
        ultimoClip = Date.now(); // se aparta de una vez para no lanzar dos clips del mismo momento
        clips.crear(`momento: ${que}`, { puntos, que, saltarEspera: true })
          .then((item) => { if (item) { clipsHoy++; m.clip = true; } else ultimoClip = 0; })
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
        if (sobre >= c.dbSobreNormal || (v.pico > -1.5 && sobre >= c.dbSobreNormal / 2)) {
          await evaluar(`sonido fuerte (+${sobre.toFixed(1)} dB)`);
        }
      } catch { /* pedacito sin audio o en uso */ }
    }
    if (medidos.size > 2000) medidos = new Set([...medidos].slice(-500));
    // En plena pelea de jefe revisamos cada minuto para no perdernos el final.
    if (jefe) await evaluar('pelea de jefe');
    // Juegos con sonido parejo: cada tanto revisamos la pantalla aunque no haya picos.
    if (Date.now() - ultimaEvaluacion > c.minutosRevision * 60_000) await evaluar('revisión periódica');
  }

  setInterval(() => { revisarAudio().catch(() => {}); }, 10_000);

  return {
    nuevoDirecto() {
      volumenes = [];
      momentos = [];
      clipsHoy = 0;
      ultimoClip = 0;
      jefe = null;
      ultimaEvaluacion = Date.now(); // la primera revisión periódica, a los pocos minutos
    },
    lista: () => momentos,
  };
}

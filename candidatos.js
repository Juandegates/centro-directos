// Candidatos y selección con Claude (v5).
// Durante el directo NO se arman clips: cada momento prometedor se guarda como "candidato" (~60 s de lo
// grabado, sin recomprimir). Al terminar, Claude ve todos los candidatos y elige los 3 mejores, escribe
// sus textos viendo lo que pasa, y revisa el video final antes de publicarlo.
// Lo que no se publica se guarda en una "reserva" para los días sin directo.
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { correrFfmpeg, letraParaTextos } from './herramientas.js';
import { filtroVertical, partirGancho, lineasCuentas, lineaCuentas } from './clips.js';
import { recortar } from './promos.js';
import { agregar, nuevoId, lista as bandeja, CARPETA_CLIPS } from './bandeja.js';
import { preguntarClaude, claudeDisponible } from './claude.js';
import { preguntarIA } from './ia.js';
import { esCritico, CRITERIO_CRITICO, REGLAS_TEXTO_CRITICO, REVISION_CRITICA, frasesGastadas } from './tono.js';
import { infoVideo } from './editor.js';
import { log, marcar } from './estado.js';

export const CARPETA_CANDIDATOS = fileURLToPath(new URL('./candidatos/', import.meta.url));
const CARPETA_RESERVA = join(CARPETA_CANDIDATOS, 'reserva');
const CARPETA_TRABAJO = join(CARPETA_CANDIDATOS, 'trabajo');
const INDICE = join(CARPETA_CANDIDATOS, 'indice.json');
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const limpiarGancho = (t) => String(t ?? '').replace(/[#"\p{Extended_Pictographic}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);

function leerIndice() {
  try { return JSON.parse(readFileSync(INDICE, 'utf8')); } catch { return { sesion: null, items: [], reserva: [] }; }
}

export function crearCandidatos({ captura, leerConfig, datos, canalLogin = '', momentos }) {
  mkdirSync(CARPETA_RESERVA, { recursive: true });
  let indice = leerIndice();
  const guardar = () => writeFileSync(INDICE, JSON.stringify(indice, null, 2));
  const cfg = () => ({ maximo: 30, segundosAntes: 45, segundosDespues: 15, ...(leerConfig().autoPublicar?.candidatos ?? {}) });

  // Directo nuevo (o el mismo si te reconectaste antes de que se publicara lo anterior).
  function nuevaSesion({ continuar = false } = {}) {
    if (continuar && indice.sesion) { log('🔁 Sigue el mismo directo: junto los momentos con los de antes'); return indice.sesion; }
    // Lo que haya quedado sin revisar de una sesión vieja pasa a la reserva (menos lo que Claude está revisando ahorita).
    for (const c of indice.items.filter((x) => x.sesion !== indice.procesando)) moverAReserva(c);
    indice.items = indice.items.filter((x) => x.sesion === indice.procesando);
    indice.sesion = nuevoId();
    guardar();
    return indice.sesion;
  }

  // Un momento prometedor del directo: se guarda ~1 min de lo grabado. No usa IA.
  async function agregarCandidato({ motivo, puntos = 6, que = '', rango = null }) {
    if (!captura.activa()) return null;
    if (!indice.sesion) nuevaSesion();
    const c = cfg();
    // Lo que pide el chat cuenta, pero máximo 5 por directo (para que nadie llene todo con !clip).
    if (/chat/.test(motivo) && indice.items.filter((x) => x.sesion === indice.sesion && /chat/.test(x.motivo)).length >= 5) return null;
    let desde = rango?.desde;
    let hasta = rango?.hasta;
    if (!rango) {
      await esperar(c.segundosDespues * 1000 + 2_000); // que se grabe lo que pasó justo después
      hasta = Date.now();
      desde = hasta - (c.segundosAntes + c.segundosDespues) * 1000;
    }
    // ¿Ya hay un candidato que cubre casi lo mismo? Nos quedamos con el de mejor calificación.
    const parecido = indice.items.find((x) => x.sesion === indice.sesion && Math.abs(x.hora - hasta) < 40_000);
    if (parecido) {
      if (puntos > parecido.puntos || (que && !parecido.que)) Object.assign(parecido, { puntos: Math.max(puntos, parecido.puntos), que: que || parecido.que, motivo: puntos > parecido.puntos ? motivo : parecido.motivo });
      guardar();
      return parecido;
    }
    const pedazos = captura.pedazosEntre(desde, hasta);
    if (pedazos.length < 2) return null;
    const id = 'c' + nuevoId();
    const archivo = join(CARPETA_CANDIDATOS, `${id}.ts`);
    const listaTxt = join(CARPETA_CANDIDATOS, `${id}.txt`);
    writeFileSync(listaTxt, pedazos.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    try {
      await correrFfmpeg(leerConfig(), ['-f', 'concat', '-safe', '0', '-i', listaTxt, '-c', 'copy', archivo]);
    } catch (e) {
      log('No pude guardar el candidato: ' + e.message, { nivel: 'aviso' });
      return null;
    } finally { rmSync(listaTxt, { force: true }); }
    const item = { id, sesion: indice.sesion, hora: hasta, motivo, puntos, que, archivo: `${id}.ts`, juego: datos.actual().juego };
    indice.items.push(item);
    // Muchos candidatos: se descarta el peor (los jefes y lo del chat valen más).
    const deEsta = indice.items.filter((x) => x.sesion === indice.sesion);
    if (deEsta.length > c.maximo) {
      // Se va primero lo del chat de menor valor, luego lo peor calificado.
      const peor = [...deEsta].sort((a, b) => a.puntos - b.puntos || Number(/chat/.test(b.motivo)) - Number(/chat/.test(a.motivo)) || a.hora - b.hora)[0];
      borrarArchivo(peor);
      indice.items = indice.items.filter((x) => x !== peor);
    }
    guardar();
    log(`⭐ Candidato guardado (${puntos}/10): ${que || motivo}`, { parte: 'clips' });
    marcar('clips', 'ok', `${indice.items.length} candidato(s) en este directo`);
    return item;
  }

  const rutaDe = (c) => join(c.enReserva ? CARPETA_RESERVA : CARPETA_CANDIDATOS, c.archivo);
  const borrarArchivo = (c) => rmSync(rutaDe(c), { force: true });

  function moverAReserva(c) {
    const r = leerConfig().autoPublicar?.reserva ?? {};
    if (c.puntos < (r.minimo ?? 6) || !existsSync(rutaDe(c))) { borrarArchivo(c); return; }
    try { renameSync(rutaDe(c), join(CARPETA_RESERVA, c.archivo)); } catch { return; }
    indice.reserva.push({ ...c, enReserva: true, guardado: Date.now() });
    // Máximo 20 en la reserva y nada de más de 14 días.
    const limite = Date.now() - (r.dias ?? 14) * 24 * 3600_000;
    const quedan = [];
    for (const x of [...indice.reserva].sort((a, b) => b.puntos - a.puntos || b.hora - a.hora)) {
      if (x.guardado > limite && quedan.length < (r.maximo ?? 20)) quedan.push(x);
      else rmSync(join(CARPETA_RESERVA, x.archivo), { force: true });
    }
    indice.reserva = quedan;
  }

  // Hoja de contacto: 6 imágenes repartidas en el video, en una sola imagen (3 x 2), para que Claude lo "vea".
  async function hoja(entrada, salida, { duracion, columnas = 3, filas = 2, ancho = 480 }) {
    const n = columnas * filas;
    const fps = Math.max(0.01, n / Math.max(1, duracion));
    await correrFfmpeg(leerConfig(), ['-i', entrada, '-vf', `fps=${fps.toFixed(4)},scale=${ancho}:-2,tile=${columnas}x${filas}`, '-frames:v', '1', '-q:v', '4', salida]);
    return Array.from({ length: n }, (_, i) => Math.round((i * duracion) / n));
  }

  const recientes = () => bandeja().filter((i) => i.tipo === 'clip' && (i.auto || Object.values(i.publicado ?? {}).some(Boolean))).slice(0, 25);
  const publicadosRecientes = () => recientes()
    .map((i) => `- "${i.gancho ?? ''}" / ${i.titulo ?? ''}${i.angulo ? ` [angulo: ${i.angulo}]` : ''}`).join('\n') || '(ninguno todavía)';
  // Modo crítico: frases que ya se gastaron y ángulos usados en los últimos videos del mismo juego (para no repetir).
  function antiRepeticion(juego) {
    const mismos = recientes().filter((i) => !juego || i.juego === juego);
    const gastadas = frasesGastadas(mismos.flatMap((i) => [i.gancho, i.titulo]), { juego });
    const angulos = [...new Set(mismos.slice(0, 8).map((i) => i.angulo).filter(Boolean))];
    return (gastadas.length ? `FRASES GASTADAS (PROHIBIDO usarlas, ni parecidas): ${gastadas.map((f) => `"${f}"`).join(', ')}.\n` : '') +
      (angulos.length ? `ANGULOS YA USADOS en los ultimos videos (evitalos si hay otro hallazgo valido): ${angulos.join('; ')}.\n` : '');
  }

  // Arma el clip final (horizontal + vertical con el gancho y tus cuentas).
  async function armarClip({ entrada, inicio, fin, textos, carpeta, yaVertical = false }) {
    const config = leerConfig();
    const horizontal = join(carpeta, 'horizontal.mp4');
    const vertical = join(carpeta, 'vertical.mp4');
    await correrFfmpeg(config, ['-ss', String(inicio), '-i', entrada, '-t', String(Math.max(5, fin - inicio)),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', horizontal]);
    const c = config.clips ?? {};
    const zoom = Math.min(1, Math.max(0.4, Number(c.zoomVertical ?? 0.7)));
    const letra = c.gancho === false ? null : letraParaTextos();
    const lineas = letra ? partirGancho(textos.gancho) : [];
    const marcas = letra && c.marcaCanal !== false ? lineasCuentas(config, canalLogin) : [];
    for (let i = 1; i <= 2; i++) rmSync(join(carpeta, `linea${i}.txt`), { force: true });
    lineas.forEach((l, i) => writeFileSync(join(carpeta, `linea${i + 1}.txt`), l));
    marcas.forEach((m, i) => writeFileSync(join(carpeta, `marca${i + 1}.txt`), m));
    const armar = (conTexto) => correrFfmpeg(config, ['-i', horizontal, '-filter_complex',
      filtroVertical({ zoom, lineas: conTexto ? lineas : [], marcas: conTexto ? marcas : [], letra: conTexto ? letra : null, yaVertical }),
      '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', vertical], { cwd: carpeta });
    await armar(Boolean(letra)).catch(() => armar(false));
    await correrFfmpeg(config, ['-ss', String(Math.max(0, (fin - inicio) / 2)), '-i', horizontal, '-frames:v', '1', '-vf', 'scale=480:-2', join(carpeta, 'portada.jpg')]).catch(() => {});
  }

  // Textos finales: título de Shorts (máx. 100 con #Shorts) y tus cuentas al final de la descripción.
  function textosFinales(t) {
    const config = leerConfig();
    const d = datos.actual();
    const juego = t.juego || d.juego || '';
    const base = recortar(String(t.tituloShorts || t.titulo || `Momento en ${juego}`).replace(/#\S+/g, '').replace(/\s+/g, ' ').trim(), 100 - ' #Shorts'.length);
    const cuentas = lineaCuentas(config, canalLogin);
    // Si la descripción ya trae la línea de cuentas (p. ej. Claude la copió al corregir), se quita para no repetirla.
    const tiktok = String(t.tiktok || `${t.titulo || base} 🎮 #${juego.replace(/[^a-z0-9]/gi, '')} #PS5 #gaming`).split('\n').filter((l) => !/^\s*🎮\s*En vivo en /.test(l)).join('\n').trim().slice(0, 1800);
    return {
      gancho: limpiarGancho(t.gancho) || 'Mira esto',
      titulo: recortar(String(t.titulo || base), 70),
      tituloShorts: `${base} #Shorts`,
      tiktok: cuentas ? `${tiktok}\n${cuentas}` : tiktok,
      x: recortar(String(t.x || t.titulo || base).replace(/https?:\/\/\S+/g, ''), 240),
    };
  }

  const critico = (juego) => esCritico(juego ?? datos.actual().juego, leerConfig());
  const criterioNormal =
    'QUE HACE UN BUEN VIDEO CORTO (metroidvania en PS5, para gente que NO conoce el canal):\n' +
    '- SI: jefe vencido (mejor si costo muchos intentos), muerte epica o absurda, habilidad o arma nueva, secreto o cuarto escondido, escape por un pelo, algo chistoso o sorprendente, una zona visualmente impresionante con accion.\n' +
    '- NO: menus, mapa, inventario, pantallas de carga, caminar sin que pase nada, dialogos largos, pantallas negras o borrosas.\n' +
    '- Los textos deben describir lo que DE VERDAD se ve. Prohibido inventar (no digas "lo derrote" si no se ve que gana, ni "al primer intento" si no se sabe). Nada de frases genericas ("momentazo", "epico", "no te lo pierdas").\n';

  const reglasTextos = (juego) =>
    `Escribes en espanol mexicano natural, en primera persona como el streamer (Juan, canal ${canalLogin || 'juangates'}). Juego: ${juego}.\n` +
    'Para cada video escribe: "gancho" (frase escrita ENCIMA del video en los primeros segundos, max 32 caracteres, sin hashtags ni emojis, pregunta o reaccion), ' +
    '"titulo" (max 60), "tituloShorts" (max 85, con el nombre del juego, sin hashtags), "tiktok" (descripcion con 4 a 6 hashtags, max 180), "x" (texto para X, max 200, sin links).\n' +
    (critico(juego) ? REGLAS_TEXTO_CRITICO + antiRepeticion(juego) : '') +
    `VIDEOS QUE YA PUBLICASTE (no repitas sus frases ni su estructura; varia el estilo):\n${publicadosRecientes()}\n`;

  // ---------- Selección: Claude elige los mejores ----------
  // opciones: [{ id, ruta, duracion, info }]; devuelve [{ id, inicio, fin, textos }] en orden de calidad.
  async function elegirConClaude({ opciones, cuantos, contexto }) {
    const config = leerConfig();
    const carpeta = join(CARPETA_TRABAJO, 'sel-' + nuevoId());
    mkdirSync(carpeta, { recursive: true });
    const lineas = [];
    for (const [n, o] of opciones.entries()) {
      const nombre = `cand${String(n + 1).padStart(2, '0')}.jpg`;
      try {
        const tiempos = await hoja(o.ruta, join(carpeta, nombre), { duracion: o.duracion });
        o.codigo = `C${n + 1}`;
        lineas.push(`${o.codigo}: imagen ${nombre} (6 cuadros, izquierda a derecha y arriba a abajo, en los segundos ${tiempos.join(', ')} de un video de ${Math.round(o.duracion)} s). Dato del detector: ${o.info}`);
      } catch { /* sin imagen no se puede revisar */ }
    }
    const validas = opciones.filter((o) => o.codigo);
    if (!validas.length) return [];
    const prompt =
      'Eres el editor de videos cortos (TikTok y YouTube Shorts) del canal de un streamer mexicano de PS5.\n' +
      `${contexto}\n\nAbre con la herramienta Read CADA imagen de esta carpeta (son hojas de cuadros de cada video candidato) y miralas con calma antes de decidir:\n${lineas.join('\n')}\n\n` +
      (critico(validas[0]?.juego) ? CRITERIO_CRITICO : criterioNormal) + reglasTextos(validas[0]?.juego ?? datos.actual().juego) +
      `\nElige los ${cuantos} MEJORES candidatos (y hasta 2 de respaldo, por si alguno falla), del mejor al peor. ` +
      'Para cada uno decide el recorte: "inicio" y "fin" en segundos dentro de ese video, para que dure entre 15 y 50 s, empiece justo antes de la accion y termine poco despues (no cortes el final de la pelea o la caida).\n' +
      'Responde SOLO con un JSON: {"elegidos":[{"codigo":"C3","inicio":8,"fin":44,"porque":"...","gancho":"...","titulo":"...","tituloShorts":"...","tiktok":"...","x":"..."}]}';
    try {
      const r = await preguntarClaude({ prompt, carpeta, config });
      const vistos = new Set();
      const elegidos = (r.elegidos ?? []).filter((e) => { const k = String(e.codigo).toUpperCase().trim(); if (vistos.has(k)) return false; vistos.add(k); return true; }).map((e) => {
        const o = validas.find((x) => x.codigo === String(e.codigo).toUpperCase().trim());
        if (!o) return null;
        let inicio = Math.max(0, Number(e.inicio) || 0);
        let fin = Math.min(o.duracion, Number(e.fin) || o.duracion);
        if (fin - inicio < 12) { inicio = Math.max(0, o.duracion - 45); fin = o.duracion; }
        if (fin - inicio > 58) inicio = fin - 58;
        const analisis = [e.observacion, e.fundamento].filter(Boolean).join(' · ');
        return { id: o.id, opcion: o, inicio, fin, porque: e.porque || analisis, angulo: e.angulo ?? null, fundamento: e.fundamento ?? null, textos: e };
      }).filter(Boolean);
      log(`🤖 Claude eligió: ${elegidos.map((e) => `${e.opcion.codigo} (${e.porque.slice(0, 60)})`).join(' · ')}`);
      return elegidos;
    } finally {
      rmSync(carpeta, { recursive: true, force: true });
    }
  }

  // Sin Claude (no instalado o sin cupo): los de mejor calificación y textos de la IA gratis.
  async function elegirSinClaude({ opciones, cuantos }) {
    const orden = [...opciones].sort((a, b) => (b.puntos ?? 0) - (a.puntos ?? 0) || b.hora - a.hora).slice(0, cuantos + 2);
    const salida = [];
    for (const o of orden) {
      let textos = { gancho: o.que || 'Mira esto', titulo: o.que || `Momento en ${o.juego ?? ''}` };
      try {
        const r = await preguntarIA({
          sistema: 'Eres el community manager de un streamer mexicano de PS5. Escribes en espanol mexicano, con gancho, sin mentir.',
          texto: `Juego: ${o.juego}. Lo que paso: ${o.que || o.info}.\n${reglasTextos(o.juego)}Devuelve SOLO un JSON con gancho, titulo, tituloShorts, tiktok, x.`,
        });
        textos = JSON.parse(r.slice(r.indexOf('{'), r.lastIndexOf('}') + 1));
      } catch { /* textos de respaldo */ }
      salida.push({ id: o.id, opcion: o, inicio: Math.max(0, o.duracion - 45), fin: o.duracion, porque: 'mejor calificación', textos });
    }
    return salida;
  }

  // Revisión final: Claude ve el video vertical ya armado (con el texto encima) y decide.
  async function revisarFinal({ carpeta, textos, que, juego: juegoRevision }) {
    const config = leerConfig();
    if (!claudeDisponible(config) || config.autoPublicar?.revisionFinal === false) return { publicar: true };
    const vertical = join(carpeta, 'vertical.mp4');
    const trabajo = join(CARPETA_TRABAJO, 'rev-' + nuevoId());
    mkdirSync(trabajo, { recursive: true });
    try {
      const { duracion } = await infoVideo(config, vertical);
      await hoja(vertical, join(trabajo, 'video.jpg'), { duracion, columnas: 4, filas: 1, ancho: 270 });
      const prompt =
        'Eres el revisor final antes de publicar un video corto en TikTok y YouTube Shorts del canal de un streamer mexicano de PS5.\n' +
        'Abre con Read la imagen video.jpg (4 cuadros del video vertical ya terminado, con su texto encima) y revisa:\n' +
        '1) que el texto escrito encima y el titulo tengan logica con lo que se ve; 2) que no se repita con videos anteriores; 3) que el video no sea puro menu, mapa, carga o pantalla negra; 4) que el texto se lea bien.\n' +
        (critico(juegoRevision) ? REVISION_CRITICA + REGLAS_TEXTO_CRITICO + antiRepeticion(juegoRevision) : '') +
        `Lo que se cree que pasa: ${que || '(sin dato)'}\nTextos: ${JSON.stringify({ gancho: textos.gancho, titulo: textos.titulo, tituloShorts: textos.tituloShorts, tiktok: textos.tiktok, x: textos.x })}\n` +
        `Videos ya publicados:\n${publicadosRecientes()}\n\n` +
        'Responde SOLO con un JSON: {"publicar": true} si esta bien; {"publicar": true, "corregir": {"gancho":"...","titulo":"...","tituloShorts":"...","tiktok":"...","x":"..."}} si solo hay que mejorar textos (pon solo los que cambian); o {"publicar": false, "motivo": "..."} si el video no sirve.';
      const r = await preguntarClaude({ prompt, carpeta: trabajo, config, minutos: 6 });
      return { publicar: r.publicar !== false, corregir: r.corregir ?? null, motivo: r.motivo ?? '' };
    } catch (e) {
      log('⚠️ La revisión final de Claude falló; publico con los textos elegidos: ' + e.message, { nivel: 'aviso' });
      return { publicar: true };
    } finally {
      rmSync(trabajo, { recursive: true, force: true });
    }
  }

  // Arma un elegido, lo revisa y lo deja en la bandeja. Devuelve el item o null si se descartó.
  async function construir(e, { motivo, auto = 'clip' }) {
    const id = nuevoId();
    const carpeta = join(CARPETA_CLIPS, id);
    mkdirSync(carpeta, { recursive: true });
    let textos = textosFinales({ ...e.textos, juego: e.opcion.juego });
    try {
      await armarClip({ entrada: e.opcion.ruta, inicio: e.inicio, fin: e.fin, textos, carpeta });
      const rev = await revisarFinal({ carpeta, textos, que: e.opcion.que || e.opcion.info, juego: e.opcion.juego });
      if (!rev.publicar) {
        e.descartado = true;
        log(`🤖 Claude descartó un video: ${rev.motivo}`);
        rmSync(carpeta, { recursive: true, force: true });
        return null;
      }
      if (rev.corregir) {
        const antes = textos.gancho;
        const titulo0 = textos.titulo;
        textos = textosFinales({ ...textos, ...rev.corregir, tiktok: rev.corregir.tiktok ?? e.textos.tiktok, juego: e.opcion.juego });
        if (textos.gancho !== antes) await armarClip({ entrada: e.opcion.ruta, inicio: e.inicio, fin: e.fin, textos, carpeta });
        log(`🤖 Claude corrigió los textos${textos.gancho !== antes ? ` (frase: "${textos.gancho}")` : ''}${textos.titulo !== titulo0 ? ` (título: "${textos.titulo}")` : ''}`);
      }
      return agregar({
        id, tipo: 'clip', auto, motivo, puntos: e.opcion.puntos ?? 8, gancho: textos.gancho, juego: e.opcion.juego,
        titulo: textos.titulo, textoTikTok: textos.tiktok, tituloShorts: textos.tituloShorts, textoX: textos.x, porque: e.porque,
        ...(e.angulo ? { angulo: String(e.angulo).slice(0, 80) } : {}),
        archivos: { horizontal: `${id}/horizontal.mp4`, vertical: `${id}/vertical.mp4`, portada: `${id}/portada.jpg` },
      });
    } catch (err) {
      log('⚠️ No pude armar un clip elegido: ' + err.message, { nivel: 'aviso' });
      rmSync(carpeta, { recursive: true, force: true });
      return null;
    }
  }

  async function opcionesDe(lista) {
    const config = leerConfig();
    const salida = [];
    for (const c of lista) {
      const ruta = rutaDe(c);
      if (!existsSync(ruta)) continue;
      const { duracion } = await infoVideo(config, ruta);
      if (duracion < 8) continue;
      salida.push({ ...c, ruta, duracion, info: `${c.motivo}${c.que ? ` · ${c.que}` : ''} · calificacion rapida ${c.puntos}/10` });
    }
    return salida;
  }

  // Al terminar (1 h después): elige y arma los mejores del directo. Devuelve los items listos para publicar.
  async function seleccionarDirecto({ cuantos = 3, minutos = 0 } = {}) {
    // Se "cierra" la sesión: si empiezas otro directo mientras Claude revisa, lo nuevo va aparte.
    const sesion = indice.procesando ?? indice.sesion;
    indice.procesando = sesion;
    if (indice.sesion === sesion) indice.sesion = null;
    guardar();
    const deSesion = () => indice.items.filter((x) => x.sesion === sesion);
    let lista = [...deSesion()];
    // Pocos candidatos: completamos con los pedacitos del resumen (cada momento revisado deja uno).
    if (lista.length < cuantos + 2) {
      for (const p of momentos.piezas()) {
        if (lista.some((x) => Math.abs(x.hora - p.hora) < 40_000)) continue;
        lista.push({ id: 'p' + p.hora, hora: p.hora, puntos: p.puntos, que: p.que, motivo: 'momento revisado', rutaFija: p.ruta, juego: datos.actual().juego });
      }
    }
    const opciones = [];
    for (const o of await opcionesDe(lista.filter((x) => !x.rutaFija))) opciones.push(o);
    for (const x of lista.filter((y) => y.rutaFija && existsSync(y.rutaFija))) {
      const { duracion } = await infoVideo(leerConfig(), x.rutaFija);
      if (duracion >= 8) opciones.push({ ...x, ruta: x.rutaFija, duracion, info: `${x.motivo}${x.que ? ` · ${x.que}` : ''} · calificacion rapida ${x.puntos}/10` });
    }
    // A Claude le mandamos máximo 12 (los de mejor calificación).
    const top = opciones.sort((a, b) => b.puntos - a.puntos || b.hora - a.hora).slice(0, 12).sort((a, b) => a.hora - b.hora);
    if (!top.length) { log('🎬 No hubo candidatos en este directo'); terminarSesion(sesion, new Set(), new Set()); return []; }
    const destacados = momentos.destacados?.() ?? [];
    const contexto = `Directo de ${minutos} min jugando ${datos.actual().juego}.` + (destacados.length ? ` Lo mas fuerte que detecto el sistema: ${destacados.join('; ')}.` : '');
    let elegidos = [];
    if (claudeDisponible(leerConfig())) {
      try { elegidos = await elegirConClaude({ opciones: top, cuantos, contexto }); } catch (e) {
        log('⚠️ Claude no pudo elegir; uso la calificación rápida: ' + e.message, { nivel: 'aviso' });
        marcar('claude', 'aviso', 'Claude no pudo revisar los videos', e.message);
      }
    }
    if (!elegidos.length) elegidos = await elegirSinClaude({ opciones: top, cuantos });
    const listos = [];
    for (const e of elegidos) {
      if (listos.length >= cuantos) break;
      const item = await construir(e, { motivo: `elegido por Claude: ${e.porque || e.opcion.que || e.opcion.motivo}`.slice(0, 160) });
      if (item) { listos.push(item); e.usado = true; }
    }
    // Lo que no salió se queda en la reserva (para los días sin directo); lo que Claude descartó se borra.
    terminarSesion(sesion, new Set(elegidos.filter((e) => e.usado).map((e) => e.id)), new Set(elegidos.filter((e) => e.descartado).map((e) => e.id)));
    return listos;
  }

  function terminarSesion(sesion, usados, descartados) {
    for (const c of indice.items.filter((x) => x.sesion === sesion)) {
      if (usados.has(c.id) || descartados.has(c.id)) borrarArchivo(c); else moverAReserva(c);
    }
    indice.items = indice.items.filter((x) => x.sesion !== sesion);
    indice.procesando = null;
    guardar();
  }

  // Directo demasiado corto para publicar (por ejemplo, una prueba): lo que hubo va a la reserva.
  function archivarSesion() {
    const sesion = indice.procesando ?? indice.sesion;
    if (indice.sesion === sesion) indice.sesion = null;
    terminarSesion(sesion, new Set(), new Set());
  }

  // Días sin directo: un video "gancho" con lo mejor de la reserva.
  async function videoGancho() {
    const opciones = await opcionesDe(indice.reserva);
    if (!opciones.length) return null;
    const top = opciones.sort((a, b) => b.puntos - a.puntos || b.hora - a.hora).slice(0, 8);
    const d = datos.actual();
    const contexto = `Hoy NO hubo directo. Este video sale para atraer gente al canal: debe ser llamativo por si solo y su descripcion debe invitar a los directos (${d.horario}). Son momentos guardados de directos anteriores.`;
    let elegidos = [];
    if (claudeDisponible(leerConfig())) {
      try { elegidos = await elegirConClaude({ opciones: top, cuantos: 1, contexto }); } catch (e) { log('⚠️ Claude no pudo elegir el gancho: ' + e.message, { nivel: 'aviso' }); }
    }
    if (!elegidos.length) elegidos = await elegirSinClaude({ opciones: top, cuantos: 1 });
    for (const e of elegidos) {
      const item = await construir(e, { motivo: 'gancho de un día sin directo', auto: 'gancho' });
      const c = indice.reserva.find((x) => x.id === e.id);
      if (c) { rmSync(join(CARPETA_RESERVA, c.archivo), { force: true }); indice.reserva = indice.reserva.filter((x) => x !== c); guardar(); }
      if (item) return item;
    }
    return null;
  }

  // Plan diario: de los videos YA ARMADOS de los directos de ayer, Claude elige los mejores (máximo `cuantos`),
  // del mejor al peor y con variedad. Devuelve los items en ese orden (puede devolver menos si hay flojos).
  async function elegirDelDia(items, cuantos = 3) {
    const porPuntos = [...items].sort((a, b) => (b.puntos ?? 0) - (a.puntos ?? 0));
    const sinClaude = () => {
      const salida = [];
      for (const i of porPuntos) {
        if (salida.length >= cuantos) break;
        if (i.resumen && salida.some((x) => x.resumen)) continue; // máximo un resumen
        salida.push(i);
      }
      return salida;
    };
    if (items.length <= 1 || !claudeDisponible(leerConfig())) return sinClaude();
    const carpeta = join(CARPETA_TRABAJO, 'dia-' + nuevoId());
    mkdirSync(carpeta, { recursive: true });
    const lineas = [];
    const conCodigo = [];
    for (const [n, i] of items.slice(0, 15).entries()) {
      const vertical = join(CARPETA_CLIPS, i.archivos?.vertical ?? '');
      if (!existsSync(vertical)) continue;
      try {
        const { duracion } = await infoVideo(leerConfig(), vertical);
        const nombre = `video${String(n + 1).padStart(2, '0')}.jpg`;
        await hoja(vertical, join(carpeta, nombre), { duracion, columnas: 4, filas: 1, ancho: 240 });
        const codigo = `V${n + 1}`;
        conCodigo.push({ codigo, item: i });
        lineas.push(`${codigo}: imagen ${nombre} (4 cuadros del video vertical terminado, ${Math.round(duracion)} s)${i.resumen ? ' · ES EL RESUMEN de un directo' : ''} · juego: ${i.juego ?? '?'} · ` +
          `gancho: "${i.gancho ?? ''}" · titulo: "${i.titulo ?? ''}"${i.angulo ? ` · angulo: ${i.angulo}` : ''}${i.porque ? ` · por que se eligio: ${String(i.porque).slice(0, 160)}` : ''}`);
      } catch { /* sin imagen no se puede comparar */ }
    }
    if (conCodigo.length <= 1) return sinClaude();
    const critico = conCodigo.some((x) => esCritico(x.item.juego, leerConfig()));
    const prompt =
      'Eres el editor del canal de un streamer mexicano de PS5. Estos son los videos cortos YA ARMADOS de sus directos de ayer; hoy solo salen los mejores.\n' +
      `Abre con Read cada imagen y compara:\n${lineas.join('\n')}\n\n` +
      `Elige como maximo ${cuantos}, ordenados del MEJOR al peor (los 2 primeros salen tambien en YouTube, donde solo caben 2 al dia). ` +
      'Criterio: que enganchen en el primer segundo a gente que NO conoce el canal, que el texto cuadre con lo que se ve, y VARIEDAD (no dos del mismo tipo de momento ni del mismo angulo). Maximo un resumen. ' +
      (critico ? 'En los de critica, prefiere los hallazgos mas originales y con mejor fundamento, y descarta los que repiten una critica que ya salio. ' : '') +
      'Si un video es flojo, mejor no lo elijas (puedes elegir menos).\n' +
      'Responde SOLO con un JSON: {"elegidos":["V3","V1"],"porque":"una frase"}';
    try {
      const r = await preguntarClaude({ prompt, carpeta, config: leerConfig(), minutos: 6 });
      const orden = (r.elegidos ?? []).map((c) => conCodigo.find((x) => x.codigo === String(c).toUpperCase().trim())?.item).filter(Boolean);
      const unicos = [...new Set(orden)].slice(0, cuantos);
      if (unicos.length) { log(`🤖 Claude eligió los videos de hoy: ${unicos.map((i) => i.titulo).join(' · ')}${r.porque ? ` (${String(r.porque).slice(0, 120)})` : ''}`); return unicos; }
    } catch (e) {
      log('⚠️ Claude no pudo comparar los videos del día; uso la calificación: ' + e.message, { nivel: 'aviso' });
    } finally { rmSync(carpeta, { recursive: true, force: true }); }
    return sinClaude();
  }

  // Días sin directo ayer: hasta `cuantos` videos del historial (la reserva de momentos guardados), sin rellenar con flojos.
  async function videosHistorial(cuantos = 3) {
    const opciones = await opcionesDe(indice.reserva);
    if (!opciones.length) return [];
    const top = opciones.sort((a, b) => b.puntos - a.puntos || b.hora - a.hora).slice(0, 10);
    const d = datos.actual();
    const contexto = `Ayer NO hubo directo. Estos son momentos guardados de directos anteriores; los videos salen para atraer gente al canal: deben ser llamativos por si solos y su descripcion puede invitar a los directos (${d.horario}). Si alguno es flojo, no lo elijas.`;
    let elegidos = [];
    if (claudeDisponible(leerConfig())) {
      try { elegidos = await elegirConClaude({ opciones: top, cuantos, contexto }); } catch (e) { log('⚠️ Claude no pudo elegir del historial: ' + e.message, { nivel: 'aviso' }); }
    }
    if (!elegidos.length) elegidos = (await elegirSinClaude({ opciones: top.filter((o) => o.puntos >= 7), cuantos }));
    const listos = [];
    for (const e of elegidos) {
      if (listos.length >= cuantos) break;
      const item = await construir(e, { motivo: 'del historial (ayer no hubo directo)', auto: 'gancho' });
      const c = indice.reserva.find((x) => x.id === e.id);
      if (c) { rmSync(join(CARPETA_RESERVA, c.archivo), { force: true }); indice.reserva = indice.reserva.filter((x) => x !== c); guardar(); }
      if (item) listos.push(item);
    }
    return listos;
  }

  // Al arrancar: borra restos de trabajos a medias.
  try { for (const f of readdirSync(CARPETA_TRABAJO)) rmSync(join(CARPETA_TRABAJO, f), { recursive: true, force: true }); } catch { /* no existe */ }
  // Candidatos cuyo archivo ya no está (por ejemplo, se borró a mano) se olvidan.
  indice.items = indice.items.filter((c) => existsSync(rutaDe(c)));
  indice.reserva = indice.reserva.filter((c) => existsSync(join(CARPETA_RESERVA, c.archivo)));
  guardar();

  return {
    agregarCandidato,
    nuevaSesion,
    seleccionarDirecto,
    archivarSesion,
    videoGancho,
    elegirDelDia,
    videosHistorial,
    ultimaHora: () => Math.max(0, ...indice.items.map((x) => x.hora)),
    sesion: () => indice.sesion,
    cuantos: () => indice.items.length,
    reserva: () => indice.reserva.length,
    // Revisión final de un video ya hecho (por ejemplo, el resumen): solo corrige textos.
    async revisarItem(item) {
      const carpeta = join(CARPETA_CLIPS, item.id);
      const t = { gancho: item.gancho, titulo: item.titulo, tituloShorts: item.tituloShorts, tiktok: item.textoTikTok, x: item.textoX };
      const r = await revisarFinal({ carpeta, textos: t, que: item.motivo, juego: item.juego });
      if (!r.publicar) return { publicar: false, motivo: r.motivo };
      if (!r.corregir) return { publicar: true };
      const f = textosFinales({ ...t, ...r.corregir, gancho: t.gancho, tiktok: r.corregir.tiktok ?? String(t.tiktok ?? '').split('\n')[0], juego: item.juego });
      return { publicar: true, cambios: { titulo: f.titulo, tituloShorts: f.tituloShorts, textoTikTok: f.tiktok, textoX: f.x } };
    },
    _armarClip: armarClip, _textosFinales: textosFinales, _hoja: hoja, // para pruebas
  };
}

// Tamaño de un archivo (0 si no existe).
export const tamano = (ruta) => { try { return statSync(ruta).size; } catch { return 0; } };

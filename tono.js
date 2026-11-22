// Tono "crítico" para juegos que elijas (por ahora GTA VI): los videos se enfocan en fallos REALES del juego
// —bugs, NPCs repetitivos, automatismos, malos controles, misiones simples— y también critican los logros
// ("lo conseguí… pero fue demasiado fácil"), con sarcasmo duro, para generar polémica con fundamento.
// Solo afecta a los videos (clips, resumen, gancho); el bot del chat sigue normal.
// Se cambia en config.json → "tonoCritico": ["grand theft auto", "gta"]  (lista vacía = apagado).
const PREDETERMINADO = ['grand theft auto', 'gta', 'gta5', 'gta6']; // cualquier GTA (V, VI, Online…), sin importar cómo lo nombre Twitch

export function esCritico(juego, config = {}) {
  const lista = Array.isArray(config.tonoCritico) ? config.tonoCritico : PREDETERMINADO;
  const j = String(juego ?? '').toLowerCase();
  return lista.some((p) => {
    const x = String(p ?? '').toLowerCase().trim();
    if (!x) return false;
    // Palabras cortas (como "gta") cuentan solo como palabra completa: "GTA VI" sí, "Gtavania" no.
    return x.length <= 4 ? new RegExp(`(^|[^a-z0-9])${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(j) : j.includes(x);
  });
}

// Ángulos de crítica: cada video debe atacar algo DISTINTO. Son categorías, no frases para copiar.
export const ANGULOS = [
  'IA de los NPCs (reacciones, rutinas, peatones que no reaccionan)',
  'IA de enemigos (se quedan parados, no flanquean, mueren igual)',
  'policia y sistema de busqueda (llega tarde, no llega, se va solo)',
  'fisica y choques (autos de papel o de tanque, cuerpos de trapo, cosas que no se rompen)',
  'conduccion (agarre irreal, derrapes, camara al manejar)',
  'apuntado y combate (asistencia exagerada, armas sin peso, coberturas)',
  'diseño de misiones (lineales, guiadas con flechas, sin libertad, fallar = repetir igual)',
  'mundo vivo (ciudad de utileria, interiores falsos, gente que aparece y desaparece)',
  'graficos y rendimiento (cosas que aparecen de golpe, texturas, agua, sombras, resolucion)',
  'animaciones (personajes tiesos, transiciones bruscas, manos que atraviesan)',
  'camara e interfaz (camara que se atora, avisos en pantalla que te dicen todo)',
  'historia contra juego (lo que pasa en la escena no cuadra con lo que haces al jugar)',
  'economia y recompensas (dinero facil, logros regalados, progreso inflado)',
  'realismo incongruente (presume realismo pero algo basico no lo es)',
  'repeticion (actividades y frases que ya viste antes)',
];

// Para calificar momentos (imágenes del directo).
export const RUBRICA_CRITICA =
  'Este canal hace CRITICA ANALITICA de este juego: lo valioso es todo lo que no deberia pasar en un juego de este presupuesto. ' +
  'Fijate en: ' + ANGULOS.join('; ') + '. Tambien misiones o logros conseguidos demasiado facil. ' +
  '9-10 = un fallo claro y visible que casi nadie ha señalado, o algo absurdo; 6-8 = un fallo visible normal, o mision/logro que se ve demasiado facil; ' +
  '4-5 = accion normal sin nada que criticar o escena de historia; 1-3 = menus, mapa, carga, caminar o paisaje sin nada que criticar. ' +
  'En "que" describe EXACTAMENTE lo que se ve y que tiene de criticable (objeto, personaje, momento), no una opinion generica.\n';

// Para elegir los clips: el análisis viene ANTES que el título.
export const CRITERIO_CRITICO =
  'ESTE CANAL HACE CRITICA ANALITICA DE ESTE JUEGO. No buscas solo "algo malo": buscas el hallazgo mas interesante y defendible de cada video, como un critico que ya jugo mucho.\n' +
  'Para CADA candidato, antes de elegir, piensa en este orden:\n' +
  '1) OBSERVACION: que se ve exactamente en los cuadros (que personaje u objeto, que pasa, en que segundo).\n' +
  '2) FUNDAMENTO: por que eso no deberia pasar en un juego de este nivel: compara con como funciona en la vida real, con lo que el propio juego hace en otra parte, o con lo que otros juegos de mundo abierto resuelven. Si no hay fundamento claro, ese candidato no sirve.\n' +
  '3) ANGULO: a que categoria pertenece. Categorias: ' + ANGULOS.join('; ') + '.\n' +
  'Elige los candidatos con el hallazgo mas ORIGINAL y polemico. Prefiere angulos que NO se han usado en los videos recientes; si el mismo tipo de critica ya salio (por ejemplo "el juego te dice que hacer"), busca otro detalle del video aunque sea mas sutil.\n' +
  '- NO: menus, mapa, carga, caminar sin que pase nada, pantallas negras o borrosas.\n' +
  '- Prohibido inventar: solo critica lo que DE VERDAD se ve en los cuadros. No afirmes cifras, datos de desarrollo ni declaraciones de nadie.\n' +
  'Agrega a cada elegido en el JSON: "observacion" (1 frase), "fundamento" (1 frase) y "angulo" (la categoria).\n';

// Para escribir gancho, títulos y descripciones.
export const REGLAS_TEXTO_CRITICO =
  'TONO: critica dura, analitica y con sarcasmo, para generar debate CON FUNDAMENTO entre quienes defienden el juego.\n' +
  '- El TITULO es una TESIS concreta sobre el hallazgo de ESE video: nombra lo que se ve (el objeto, el personaje, la situacion) y la critica, de forma que alguien que lo defiende quiera responder. Nada de frases que sirvan para cualquier video.\n' +
  '- El GANCHO es una reaccion o pregunta corta sobre ese detalle especifico, distinta del titulo.\n' +
  '- La DESCRIPCION explica en 1 o 2 frases el fundamento (por que no deberia pasar) y termina con una pregunta de debate sobre ese punto concreto (no una pregunta generica sobre si defienden el juego).\n' +
  '- Cada video debe sonar distinto: cambia la estructura (afirmacion, pregunta, comparacion, ironia, dato de lo que se ve), el inicio y las palabras.\n' +
  '- Puedes usar expresiones mexicanas, pero sin groserias fuertes y sin insultar a quien le guste el juego: la critica es al juego, no a la gente. Nunca inventes algo que no se vea.\n';

// Para la revisión final del video ya armado.
export const REVISION_CRITICA =
  '5) este canal hace critica analitica de este juego: lo que critican el texto y el titulo debe VERSE en los cuadros; el titulo debe ser una tesis sobre ese detalle concreto (no una frase que sirva para cualquier video) y no debe repetir frases ni estructuras de los videos ya publicados. ' +
  'Si critica algo que no se ve, o es generico o repetido, reescribelo con el hallazgo concreto; rechaza el video solo si no hay nada que criticar.\n';

// Para el video resumen del directo.
export const RESUMEN_CRITICO =
  'Este canal hace critica analitica de este juego: el resumen junta los hallazgos del directo en UNA tesis del dia (cual fue el problema que mas se repitio o el mas grave de lo que se vio), ' +
  'con titulo y gancho duros y especificos sobre esos momentos, distintos de los videos anteriores. Sin groserias fuertes ni insultos a los fans; no inventes nada que no este en los datos. ';

// Frases que ya se gastaron: las de 2 a 4 palabras que se repiten en los títulos y ganchos recientes.
const VACIAS = new Set('el la los las un una de del y o a en por para con que es se me mi te lo le su sus al como pero ya no si mas muy esto este esta eso'.split(' '));
export function frasesGastadas(textos, { minimo = 2, juego = '' } = {}) {
  // Las palabras del nombre del juego no cuentan como frase gastada (el título de Shorts debe llevarlo).
  const delJuego = new Set(['gta', 'vi', 'v', 'grand', 'theft', 'auto', ...String(juego).toLowerCase().split(/[^a-z0-9]+/)]);
  const cuenta = new Map();
  for (const t of textos) {
    const palabras = String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ\s]/g, ' ').split(/\s+/).filter(Boolean);
    const vistas = new Set();
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= palabras.length; i++) {
        const g = palabras.slice(i, i + n);
        if (g.every((w) => VACIAS.has(w) || delJuego.has(w)) || VACIAS.has(g[0]) && VACIAS.has(g[n - 1])) continue;
        const f = g.join(' ');
        if (vistas.has(f)) continue;
        vistas.add(f);
        cuenta.set(f, (cuenta.get(f) ?? 0) + 1);
      }
    }
  }
  // Quita las que quedan contenidas en otra más larga con la misma cuenta.
  const lista = [...cuenta].filter(([, c]) => c >= minimo).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  const final = [];
  for (const [f, c] of lista) if (!final.some(([g, d]) => d >= c && g.includes(f))) final.push([f, c]);
  return final.slice(0, 15).map(([f]) => f);
}

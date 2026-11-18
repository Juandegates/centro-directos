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

// Todo lo que se puede criticar con fundamento (se usa en las tres etapas).
const QUE_CRITICAR =
  'bugs y glitches (cosas o personajes atravesando paredes, fisica rota, algo flotando, animaciones rotas, texturas que tardan en cargar, objetos o autos que aparecen de golpe), ' +
  'NPCs y enemigos que repiten siempre la misma accion, que reaccionan absurdo o que se quedan parados, ' +
  'automatismos (el juego apunta, maneja, se cubre o resuelve solo; ayudas exageradas, flechas y marcadores que te llevan de la mano), ' +
  'malos controles (apuntado torpe, manejo raro, camara mala), misiones que se resuelven demasiado facil o se repiten, ' +
  'LOGROS Y METAS (mision completada, trofeo o logro, nivel o recompensa) que se consiguieron demasiado facil o "a pesar de" un fallo, ' +
  'y el contraste entre lo "realista" y los años de desarrollo que presume el juego contra lo que de verdad pasa';

// Para calificar momentos (imágenes del directo).
export const RUBRICA_CRITICA =
  'Este canal hace CRITICA DURA de este juego: lo valioso es todo lo que no deberia pasar en un juego de este nivel. Busca: ' + QUE_CRITICAR + '. ' +
  '9-10 = un fallo claro y visible (bug, NPC absurdo, el juego haciendo todo solo) o un logro/mision completada que se ve ridiculamente facil; ' +
  '6-8 = NPCs repetitivos, combate o manejo que se ve automatico, mal apuntado en un tiroteo, mision o trofeo conseguido (aunque no se vea un fallo, se puede criticar lo facil), cosas que aparecen de golpe; ' +
  '4-5 = accion normal sin nada que criticar o escena de historia; 1-3 = menus, mapa, carga, caminar o paisaje bonito sin nada que criticar. ' +
  'En "que" describe en concreto lo que se ve y que se puede criticar (ej. "NPC atraviesa la pared", "el auto se maneja solo", "mision completada en 2 minutos", "trofeo desbloqueado"); si no hay nada, describe lo que pasa.\n';

// Para elegir los clips.
export const CRITERIO_CRITICO =
  'QUE HACE UN BUEN VIDEO CORTO PARA ESTE CANAL (critica dura de este juego, para gente que NO conoce el canal):\n' +
  '- SI, todo lo que se vea en pantalla y se pueda criticar con fundamento: ' + QUE_CRITICAR + '.\n' +
  '- Los logros cuentan: un "mision completada", un trofeo o una recompensa se critican por lo facil que fue o porque se logro a pesar de un fallo del juego.\n' +
  '- NO: menus, mapa, carga, caminar sin que pase nada, pantallas negras o borrosas, paisajes bonitos sin nada que criticar.\n' +
  '- Prohibido inventar: solo critica lo que DE VERDAD se ve en los cuadros.\n';

// Para escribir gancho, títulos y descripciones.
export const REGLAS_TEXTO_CRITICO =
  'TONO: critica DURA y sarcastica, sin piedad con el juego, para generar polemica CON FUNDAMENTO entre quienes lo defienden. ' +
  'Señala lo concreto que se ve y burlate de los años de desarrollo, del precio o de lo "realista" que presume el juego. ' +
  'Si es un logro, critica lo facil o el fallo a pesar del cual se consiguio. ' +
  'Ejemplos de estilo (no los copies tal cual): "¿10 años para esto?", "Muy realista… hasta que apuntas", "Los NPC tienen un solo guion", ' +
  '"Mision terminada y ni sude", "Trofeo desbloqueado: aguantar este apuntado", "El auto se maneja solo y ni lo pedi", "Lo logre a pesar del juego". ' +
  'Termina la descripcion con una pregunta que provoque opinar (ej. "¿Y todavia lo defienden?", "¿Vale lo que cuesta?"). ' +
  'Puedes usar expresiones mexicanas como "chafa", "neta", "que oso", pero sin groserias fuertes y sin insultar a quien le guste el juego: la critica es al juego, no a la gente. ' +
  'Nunca inventes algo que no se vea.\n';

// Para la revisión final del video ya armado.
export const REVISION_CRITICA =
  '5) este canal hace critica dura de este juego: lo que critican el texto y el titulo debe VERSE en los cuadros (un fallo, un logro facil, algo automatico); ' +
  'si critica algo que no se ve, corrigelo para que critique lo que si se ve; si el tono quedo tibio, hazlo mas duro y sarcastico; rechaza el video solo si no hay nada que criticar.\n';

// Para el video resumen del directo.
export const RESUMEN_CRITICO =
  'Este canal hace critica dura de este juego: el resumen es "lo peor del directo": titulos y gancho sarcasticos y duros sobre lo que de verdad paso ' +
  '(bugs, NPCs repetitivos, automatismos, malos controles, misiones y logros demasiado faciles). Sin groserias fuertes ni insultos a los fans; no inventes nada que no este en los datos. ';

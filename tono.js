// Tono "crítico" para juegos que elijas (por ahora GTA VI): los videos se enfocan en fallos REALES del juego
// —bugs, NPCs repetitivos, automatismos, malos controles, misiones simples— con sarcasmo, para generar
// polémica con fundamento. Solo afecta a los videos (clips, resumen, gancho); el bot del chat sigue normal.
// Se cambia en config.json → "tonoCritico": ["grand theft auto vi", "gta vi"]  (lista vacía = apagado).
const PREDETERMINADO = ['grand theft auto vi', 'gta vi', 'gta 6', 'gta6']; // GTA V y los demás siguen normal

export function esCritico(juego, config = {}) {
  const lista = Array.isArray(config.tonoCritico) ? config.tonoCritico : PREDETERMINADO;
  const j = String(juego ?? '').toLowerCase();
  return lista.some((p) => p && j.includes(String(p).toLowerCase()));
}

// Para calificar momentos (imágenes del directo).
export const RUBRICA_CRITICA =
  'Este canal hace CRITICA de este juego: lo valioso es encontrar FALLOS REALES que no deberian pasar en un juego de este nivel. ' +
  '9-10 = bug o glitch claro (objetos o personajes atravesando cosas, fisica rota, algo flotando, animacion rota), NPC haciendo algo absurdo, ' +
  'el juego apuntando o manejando solo de forma exagerada, una mision importante que termina de forma demasiado simple; ' +
  '6-8 = NPCs repitiendo la misma accion, conduccion o combate que se ve automatico, objetos o autos que aparecen de golpe, tiroteo donde se nota el mal apuntado, persecucion con fallos; ' +
  '4-5 = accion normal sin fallo visible o escena importante de la historia; 1-3 = menus, mapa, carga, caminar o escenas bonitas sin nada que criticar. ' +
  'En "que" describe el fallo concreto que se ve (ej. "NPC atraviesa la pared", "el auto se maneja solo"); si no hay fallo, describe lo que pasa.\n';

// Para elegir los clips.
export const CRITERIO_CRITICO =
  'QUE HACE UN BUEN VIDEO CORTO PARA ESTE CANAL (critica de este juego, para gente que NO conoce el canal):\n' +
  '- SI: fallos REALES que se vean claro en pantalla: bugs, glitches, NPCs que hacen siempre lo mismo o algo absurdo, automatismos (el juego apunta, maneja o resuelve solo), malos controles de armas o de manejo, ' +
  'misiones importantes que se resuelven de forma demasiado simple, cosas que aparecen de golpe, contraste entre lo "realista" que presume el juego y lo que de verdad pasa.\n' +
  '- Si en un candidato no se ve ningun fallo, solo eligelo si es un evento importante (final de mision, persecucion, tiroteo) que se pueda criticar con fundamento.\n' +
  '- NO: menus, mapa, carga, caminar sin que pase nada, pantallas negras o borrosas, escenas bonitas sin nada que criticar.\n' +
  '- Prohibido inventar fallos: solo critica lo que DE VERDAD se ve en los cuadros.\n';

// Para escribir gancho, títulos y descripciones.
export const REGLAS_TEXTO_CRITICO =
  'TONO: critico y sarcastico, para generar polemica CON FUNDAMENTO entre quienes defienden el juego. ' +
  'Señala el fallo concreto que se ve, con ironia sobre los años de desarrollo o lo "realista" que presume el juego ' +
  '(ejemplos de estilo, no los copies: "¿10 años para esto?", "Muy realista… hasta que apuntas", "Los NPC con un solo guion", "Mision final: aprieta un boton"). ' +
  'Termina la descripcion con una pregunta que invite a opinar (ej. "¿Ustedes lo defienden?"). ' +
  'Sin groserias fuertes y sin insultar a quien le guste el juego: la critica es al juego, no a la gente. Nunca inventes un fallo que no se vea.\n';

// Para la revisión final del video ya armado.
export const REVISION_CRITICA =
  '5) este canal hace critica de este juego: el fallo que mencionan el texto y el titulo debe VERSE en los cuadros; si el texto critica algo que no se ve, corrigelo para que critique lo que si se ve, o rechaza el video si no hay nada que criticar.\n';

// Para el video resumen del directo.
export const RESUMEN_CRITICO =
  'Este canal hace critica de este juego: el resumen es "lo peor del directo": titulos y gancho sarcasticos sobre los fallos REALES de esos momentos ' +
  '(bugs, NPCs repetitivos, automatismos, malos controles, misiones simples). Sin groserias fuertes ni insultos a los fans; no inventes fallos que no esten en los datos. ';

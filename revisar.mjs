// Revisión rápida antes de publicar una versión: carga todos los módulos (errores de sintaxis o de importación)
// y comprueba que cada "modulo.funcion" que se usa en el código exista de verdad en ese módulo.
// Uso: node revisar.mjs   (termina con error si algo falta)
import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const archivos = readdirSync('.').filter((f) => f.endsWith('.js') && !['centro.js', 'prueba-ia.js'].includes(f));
const modulos = {};
let fallos = 0;
for (const f of archivos) {
  try { modulos[f.replace(/\.js$/, '')] = await import(pathToFileURL(f).href); }
  catch (e) { fallos++; console.log(`❌ ${f} no carga: ${e.message}`); }
}
// "import * as kick from './kick.js'" → cada kick.algo del archivo debe existir en kick.js
for (const f of [...archivos, 'centro.js']) {
  const codigo = readFileSync(f, 'utf8');
  for (const [, alias, mod] of codigo.matchAll(/import \* as (\w+) from '\.\/(\w+)\.js'/g)) {
    if (!modulos[mod]) continue;
    // Se ignoran textos como './kick.js' o 'kick.com' (van precedidos de / o ' o son dominios).
    const usados = new Set([...codigo.matchAll(new RegExp(`(?<![\\w./'\\"\`])${alias}\\.([A-Za-z_]\\w*)`, 'g'))].map((m) => m[1]).filter((n) => !['js', 'com', 'tv', 'net'].includes(n)));
    for (const u of usados) if (!(u in modulos[mod])) { fallos++; console.log(`❌ ${f} usa ${alias}.${u} pero ${mod}.js no lo exporta`); }
  }
  for (const [, nombres, mod] of codigo.matchAll(/import \{([^}]+)\} from '\.\/(\w+)\.js'/g)) {
    if (!modulos[mod]) continue;
    for (const n of nombres.split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
      if (!(n in modulos[mod])) { fallos++; console.log(`❌ ${f} importa ${n} de ${mod}.js pero no existe`); }
    }
  }
}
console.log(fallos ? `\n${fallos} problema(s)` : `✅ ${archivos.length} módulos cargan y todas las importaciones existen`);
process.exit(fallos ? 1 : 0);

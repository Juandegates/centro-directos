// Prueba rápida: confirma que la clave de Gemini funciona.
import { readFileSync } from 'node:fs';
import { preguntarIA } from './ia.js';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));

try {
  const r = await preguntarIA({ personalidad: config.personalidad, mensaje: 'hola, ¿qué onda con el directo?' });
  console.log('\n✅ La IA funciona. Respondió:\n');
  console.log('   ' + r + '\n');
} catch (e) {
  console.log('\n❌ La IA no respondió: ' + e.message + '\n');
  process.exitCode = 1;
}

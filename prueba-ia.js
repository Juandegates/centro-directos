// Prueba rápida: confirma que la clave de Gemini funciona y cómo suena el bot.
import { preguntarIA, alAvisoIA } from './ia.js';
alAvisoIA((t) => console.log('   ' + t));
console.log('\nPreguntando a la IA…');
import { leerConfig } from './bot.js';

const config = leerConfig();
try {
  const r = await preguntarIA({
    sistema: `Eres el streamer escribiendo en su chat de Twitch, en primera persona. Quien soy: ${config.comoSoy}. Mensajes cortos de 1 a 2 frases.`,
    texto: 'Mensajes NUEVOS que debes contestar:\n@Visitante [PRIMERA VEZ EN EL CANAL]: hola, ¿qué onda?\n\nEscribe UN solo mensaje para el chat.',
  });
  console.log('\n✅ La IA funciona. Así contestaría en tu chat:\n');
  console.log('   ' + r + '\n');
} catch (e) {
  console.log('\n❌ La IA no respondió: ' + e.message + '\n');
  process.exitCode = 1;
}

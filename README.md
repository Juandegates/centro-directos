# Centro de Directos

Fase 1: bot de IA (Gemini, plan gratis) que maneja tu chat de Twitch como si fueras tú.

## Uso en Windows

0. Instala [Streamlink](https://streamlink.github.io/install.html) para Windows (trae FFmpeg): así el bot ve tu directo.
1. Copia `claves-ejemplo.txt` como `claves.txt` y pon tus claves.
2. Llena `config.json`: cómo eres, el juego de hoy, tu horario.
3. En esta carpeta: `npm run prueba-ia` (prueba la IA).
4. `npm start` y la primera vez abre http://localhost:3000 para iniciar sesión en Twitch.

## Qué hace

- Lee el chat por tandas (cada 6 s) y contesta todo en un mensaje, en primera persona, con @menciones.
- Saluda a quien escribe por primera vez en el canal y a los conocidos cuando vuelven.
- Si el chat lleva 5 minutos callado y estás en vivo, manda algo para sacar plática.
- Mientras estás en vivo, toma una imagen de tu directo cada 2 s y se la pasa a la IA para contestar lo que pregunten del juego.
- Comandos fijos en `config.json` (`!horario`, `!juego`, `!redes`).
- Nunca contesta tus propios mensajes; los usa como contexto.
- Puedes cambiar `config.json` sin reiniciar.

`claves.txt`, `tokens.json` y `conocidos.json` nunca se suben a GitHub.

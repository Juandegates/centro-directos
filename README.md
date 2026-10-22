# Centro de Directos

Fase 1: bot de IA (Gemini, plan gratis) que contesta en tu chat de Twitch.

## Uso en Windows

1. Copia `claves-ejemplo.txt` como `claves.txt` y pon tus claves.
2. En esta carpeta: `npm run prueba-ia` (prueba la IA).
3. `npm start` y la primera vez abre http://localhost:3000 para iniciar sesión en Twitch.

## Qué hace

- Lee tu chat de Twitch con EventSub.
- Comandos fijos en `config.json` (`!horario`, `!juego`, `!redes`).
- Contesta con IA preguntas (mensajes con `?`) o menciones, con pausas para no llenar el chat.
- Nunca contesta tus propios mensajes.
- Puedes cambiar `config.json` sin reiniciar.

`claves.txt` y `tokens.json` nunca se suben a GitHub.

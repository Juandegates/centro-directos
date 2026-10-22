# Centro de Directos · v2

Todo automático para tus directos de PS5: tú solo le das **Transmitir** en la PS5 y la PC hace lo demás.

## Qué hace solo

- Arranca con Windows y detecta al instante cuando sales en vivo en Twitch (y cuando terminas).
- **Bot de IA** en el chat de Twitch y de YouTube: habla como tú, saluda a los nuevos, contesta, saca plática y ve tu pantalla.
- **YouTube en vivo**: crea el directo con tu título y le manda la misma señal de Twitch.
- **Clips**: detecta los mejores momentos (el chat explota, reacciones, `!clip`), crea el clip en Twitch y arma un video vertical (TikTok/Shorts) y uno horizontal, con textos y hashtags.
- **Promoción**: anuncio de "estoy en vivo" y resumen al terminar, listos para X.
- **Aprende solo**: juego y título de Twitch, tu horario y notas de tu partida; te avisa si la categoría no coincide con lo que se ve.
- **Avisos al celular** (ntfy) de todo lo importante y de cualquier falla.
- **IA de respaldo** en tu PC (Ollama), opcional, si Gemini se satura.

## App del celular

`http://<tu-pc>:3000` (o la dirección de Tailscale). Pide el PIN que muestra la ventana del Centro.

- **En vivo**: estado, espectadores, cambiar título y categoría, encender/apagar YouTube y los bots, hacer clip.
- **Chat**: Twitch y YouTube juntos; escribir como tú.
- **Publicar**: clips y posts listos; descargar, copiar texto, publicar en X.
- **Diagnóstico**: semáforo por parte, **Probar todo**, **Copiar reporte** (sin claves), actualizar.

## Instalación en Windows

1. Instala Node.js (LTS) y [Streamlink](https://github.com/streamlink/windows-builds/releases/latest).
2. Copia `claves-ejemplo.txt` como `claves.txt` y pon tus claves.
3. Doble clic en `iniciar-centro.bat`. La primera vez abre http://localhost:3000/twitch en la PC.
4. (Opcional) `instalar-inicio-automatico.bat` para que arranque solo con Windows.
5. (Opcional) YouTube: pon `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` y abre http://localhost:3000/youtube en la PC.

Nunca se suben a GitHub: `claves.txt`, `tokens.json`, `google-tokens.json`, `ajustes.json`, `memoria.json`, `conocidos.json`, `bandeja.json`, `grabacion/`, `clips/`.

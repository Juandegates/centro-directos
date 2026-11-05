# Centro de Directos · v5

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

## Piloto automático de publicaciones (v5)

- Durante el directo solo se guardan **candidatos** (momentos prometedores de ~1 min).
- 1 hora después de terminar (si no te reconectas antes), **Claude** (Claude Code con tu plan Max) ve todos los candidatos, elige los **3 mejores**, escribe sus textos viendo lo que pasa y revisa cada video final.
- Se publican espaciados (el 1º de inmediato y los demás cada 3 h) junto con el **resumen de 1:30**: TikTok y YouTube Shorts por **Buffer**, Facebook e Instagram por tu **app de Meta**, y X por **Upload-Post** (10 al mes: el mejor de cada directo).
- Días sin directo: a las 6 pm sale un **video gancho** con lo mejor guardado.
- Los servicios descargan cada video de una dirección temporal en tu PC (Tailscale Funnel, puerto 3001).
- Ajustes en `config.json` → `autoPublicar`.

## Segundo plano (v5)

`instalar-v5.bat` mueve el Centro a `C:\CentroDirectos`, lo deja arrancando **sin ventana** al entrar a Windows y pone en el escritorio: **Centro de Directos** (bitácora en vivo), **Reiniciar Centro** y **Detener Centro**.

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

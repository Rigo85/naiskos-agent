# Naiskos Agent

Servicio local del marco Naiskos. Ejecuta en la Raspberry Pi, sirve la
aplicación Angular y los medios únicamente por loopback, conserva la última
versión válida para trabajar sin red y sincroniza cambios con el servidor
central sin interrumpir la presentación.

## Responsabilidades

- Servir el visor, el manifiesto, el clima y los archivos multimedia desde un
  mismo origen local.
- Registrar automáticamente un marco nuevo y guardar sus credenciales con modo
  `0600`.
- Descargar cada versión en segundo plano, verificar tamaños y SHA-256 y
  activarla de forma atómica sólo cuando esté completa.
- Conservar preferencias locales, eventos pendientes y el último manifiesto
  funcional después de reinicios o pérdidas de conexión.
- Exponer al visor operaciones de encuadre, rotación, eliminación, salida y
  apagado controlado.
- Recopilar diagnóstico acotado sin copiar medios ni secretos.

El navegador nunca se conecta directamente al servidor central ni recibe sus
credenciales.

## Requisitos

- Node.js 24 y npm 11.
- El artefacto de `naiskos-ng` para mostrar la interfaz.
- Para el despliegue de referencia: Raspberry Pi OS/Debian con systemd,
  Chromium y una sesión gráfica Wayland/labwc.

## Desarrollo local

```bash
npm ci
npm test
npm run build
```

Construye también Angular y arranca el agente:

```bash
npm --prefix ../naiskos-ng ci
npm --prefix ../naiskos-ng run build
NAISKOS_DATA_ROOT=./data \
NAISKOS_WEB_ROOT=../naiskos-ng/dist/naiskos-ng/browser \
npm start
```

Abre `http://127.0.0.1:8080/`. Sin URL ni credenciales centrales el agente
queda en modo `unconfigured`, suficiente para comprobar la salud y la pantalla
de alta. Los datos de esta ejecución quedan en `./data`, que está ignorado por
Git.

Comandos disponibles:

| Comando | Función |
| --- | --- |
| `npm run dev` | Ejecutar TypeScript en modo observación |
| `npm run build` | Compilar en `dist/` |
| `npm start` | Ejecutar el código compilado |
| `npm test` | Ejecutar las pruebas con Vitest |
| `npm run typecheck` | Validar tipos sin generar archivos |

## Configuración

Copia `.env.example` fuera de Git y carga sus variables mediante systemd o
`node --env-file`. Las más importantes son:

| Variable | Propósito | Predeterminado |
| --- | --- | --- |
| `NAISKOS_HOST` / `NAISKOS_PORT` | Escucha local | `127.0.0.1:8080` |
| `NAISKOS_DATA_ROOT` | Estado persistente y medios | `./data` |
| `NAISKOS_WEB_ROOT` | Compilado Angular | `../naiskos-ng/dist/naiskos-ng/browser` |
| `NAISKOS_CENTRAL_URL` | API central HTTPS | deshabilitada |
| `NAISKOS_DEVICE_BOOTSTRAP_TOKEN` | Alta automática inicial | deshabilitada |
| `NAISKOS_FRAME_ID` / `NAISKOS_AGENT_TOKEN` | Credencial ya provisionada | lectura automática si existe |
| `NAISKOS_FRAME_WIDTH` / `NAISKOS_FRAME_HEIGHT` | Perfil físico del marco | `1280 × 800` |
| `NAISKOS_SYNC_INTERVAL_MS` | Consulta de manifiesto y outbox | `5000` |
| `NAISKOS_WEATHER_SYNC_INTERVAL_MS` | Consulta separada del clima | `60000` |
| `NAISKOS_DISK_BLOCK_PERCENT` | Umbral que bloquea nuevas descargas | `90` |

No reutilices `NAISKOS_DEVICE_BOOTSTRAP_TOKEN` como token del marco. El agente
genera localmente la credencial definitiva y sólo envía hashes durante el alta.

## Estado persistente

Dentro de `NAISKOS_DATA_ROOT` se almacenan, entre otros:

- `device-credentials.json`: identidad del marco, modo `0600`;
- `manifest.json`: versión multimedia activa;
- `weather.json`: última respuesta meteorológica utilizable;
- `outbox.json`: eventos que esperan confirmación central;
- `media/`: archivos direccionados por su SHA-256.

Las descargas se preparan en rutas temporales y después se renombran. Una
interrupción nunca debe sustituir el manifiesto válido por una versión parcial.

## API local

La interfaz principal está bajo `/api/v1`:

- `GET /health`, `/manifest`, `/weather` y `/provisioning`;
- QR de alta o vinculación en `/provisioning/qr.png` y `/pairing/qr.png`;
- ajustes en `/settings` y administración de cada medio en `/media/:id`;
- sincronización manual en `/sync`;
- salida o apagado en `/system/actions`.

El contenido multimedia se sirve mediante `/media/:filename` con soporte para
peticiones `Range`. El agente escucha sólo en loopback y no debe exponerse con
un proxy público.

## Instalación del kiosco

Los archivos de `deploy/` son plantillas para el sistema de referencia:

1. Instala Node.js 24 sin sustituir runtimes usados por otros servicios.
2. Publica agente y Angular dentro de una misma release y apunta
   `/opt/naiskos/current` a la versión activa.
3. Instala `naiskos-agent.service`, carga la configuración desde
   `/etc/naiskos/agent.env` y conserva `/var/lib/naiskos` fuera de la release.
4. Instala el lanzador, el autostart, la política de Chromium y el recolector de
   diagnóstico que correspondan al escritorio detectado.
5. Crea el grupo local `naiskos-kiosk`, añade únicamente al usuario gráfico del
   marco e instala `49-naiskos-kiosk.rules`.
6. En labwc asigna el touchscreen a la salida correcta con
   `mouseEmulation="no"`; `yes` reduce todos los dedos a un solo mouse y rompe
   el pellizco.
7. Instala `99-naiskos-chromium` para Wayland, IME y eventos táctiles. Verifica
   cada opción si el equipo utiliza X11 u otro compositor.

`start-naiskos-kiosk` espera la salud del agente, abre Chromium en modo kiosco,
habilita reproducción automática y usa `systemd-inhibit`. Los nombres de
usuario, salidas de video y rutas de escritorio son propios de cada equipo y no
están fijados en este repositorio.

## Seguridad y operación

- `.env`, `data/`, `dist/`, logs y medios están excluidos de Git.
- No guardes tokens en argumentos, unidades systemd o archivos `.desktop`.
- Las reglas PolicyKit deben conceder sólo apagado, inhibición y escaneo Wi-Fi
  a los usuarios o grupos dedicados.
- `deploy/naiskos-diagnostics` genera paquetes de soporte sin incluir el
  manifiesto completo, contenido multimedia ni credenciales.
- El journal persistente de referencia se limita a 128 MiB y 14 días mediante
  `deploy/60-naiskos-persistent-journal.conf`.

Los errores se registran en el campo estructurado `err`, que conserva tipo,
mensaje, stack y cadena de causas. Los rechazos que no sean objetos `Error` se
normalizan y sus campos sensibles se ocultan. Las excepciones o promesas no
controladas se escriben con nivel fatal y se vacía el búfer del logger antes de
que systemd reinicie el agente.

El estado del agente y las muestras de diagnóstico usan la misma convención de
almacenamiento:

- `diskTotalBytes`: capacidad completa del filesystem;
- `diskUsedBytes`: bloques realmente ocupados;
- `diskAvailableBytes`: espacio utilizable por el agente sin privilegios;
- `diskReservedBytes`: espacio libre reservado por el filesystem;
- `diskUsedPercent`: `usado / (usado + disponible)`, equivalente a `df`;
- `frameDataBytes`: bloques ocupados por todo `NAISKOS_DATA_ROOT`;
- `mediaDataBytes`: parte anterior correspondiente al directorio `media/`.

El recorrido de la data se actualiza cada cinco minutos y después de instalar
contenido nuevo; la consulta barata del filesystem ocurre en cada ciclo. El
servicio de métricas descarta su salida estándar porque cada muestra ya se
envía una vez al journal con el identificador `naiskos-metrics`.

El historial técnico del piloto está en
[`docs/piloto-rpi-2026-08-29.md`](docs/piloto-rpi-2026-08-29.md); no sustituye la
validación del hardware concreto donde vaya a instalarse.

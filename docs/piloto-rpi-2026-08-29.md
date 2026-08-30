# Release conjunta y aprovisionamiento piloto de la Raspberry

Registro del 29 de agosto de 2026 para la Raspberry Pi 4 Model B de 2 GB,
Raspberry Pi OS de 64 bits basado en Debian 13 y pantalla SunFounder 10.1TS.

## Release instalada

- Release conjunta activa:
  `/opt/naiskos/releases/20260829-30404593cf44`.
- SHA-256 del artefacto:
  `937d50b9009d2c5f7ba2903ade8566590eb49f937dabeabd4558e211a1d1b23b`.
- Contiene `naiskos-agent` y `browser` probados conjuntamente.
- Selector único: `/opt/naiskos/current`.
- Enlaces estables:
  `/opt/naiskos/agent -> /opt/naiskos/current/naiskos-agent` y
  `/opt/naiskos/browser -> /opt/naiskos/current/browser`.

El agente pasó 13 pruebas y el Angular 30 pruebas antes del despliegue. Node.js
24.18.1 permanece aislado en `/opt/node24`.

## Rollback preparado

`/opt/naiskos/releases/20260829-9902b7a1c1a6` es el rollback operativo
inmediato. El agregado `rollback-pre-provisioning-20260829` conserva además la
combinación previa al aprovisionamiento. También se conservaron:

- `/etc/naiskos/agent.env.pre-provisioning-20260829`;
- `/var/lib/naiskos/manifest.pre-provisioning-20260829.json`.

Para rollback se cambia `current` al agregado anterior, se reinicia
`naiskos-agent.service` y se vuelve a abrir Chromium. No se borra primero la
release fallida ni el manifiesto vigente.

## Identidad y registro automático

El agente prioriza el serial del device tree, pero nunca envía el valor
original. Genera localmente el token y el código de vinculación; la central
recibe sólo SHA-256. El estado previo se conserva en
`/var/lib/naiskos/device-enrollment.json` con modo `0600`.

La solicitud real detectó:

- Raspberry Pi 4 Model B Rev 1.5;
- resolución 1280 × 800;
- nombre provisional `Naiskos 276B46`;
- marco asignado `a210a8b6-1a17-4759-af25-2cf1fca0c056`.

No se aprobó el dispositivo por Telegram. El agente se autenticó con la
credencial de instalación, la central creó el marco vacío y la credencial quedó
en `/var/lib/naiskos/device-credentials.json`, propiedad `naiskos:naiskos` y
modo `0600`. PostgreSQL sólo conserva hashes.

El QR servido en `127.0.0.1:8080/api/v1/pairing/qr.png` no registra el
hardware: vincula una identidad de Telegram aprobada con el marco existente.
La configuración muestra también el código legible y permite rotarlo.

## Preservación del demo

El demo local estaba en manifiesto 4, mientras un marco central nuevo nace en
versión 0. Al adoptar el `frameId` real, el agente ahora:

1. conserva medios y ajustes locales;
2. cambia el `frameId`;
3. reinicia el contador local a 0;
4. mantiene el demo mientras el central siga en 0;
5. sustituye atómicamente el demo cuando el primer contenido central publique
   la versión 1.

Esto evita tanto una pantalla vacía inmediata como ignorar las primeras cuatro
actualizaciones centrales.

## Comprobaciones posteriores

- `systemctl is-active naiskos-agent.service` debe responder `active`.
- `/api/v1/health` debe conservar el último manifiesto funcional.
- `/api/v1/provisioning` responde `approved`, con `frameId`, código formateado y
  enlace `start=frame_…`; `deepLink` de alta técnica queda en `null`.
- El archivo de credenciales debe ser propiedad de `naiskos:naiskos` y modo
  `0600`.
- La central debe registrar marco, token hasheado, auditoría y telemetría.
- Chromium debe volver al demo sin reiniciar el equipo.

Comprobación real: el manifiesto conservó 53 medios, duración fotográfica de 30
segundos y reinició su versión local a 0 para aceptar la primera publicación
central. El QR respondió HTTP 200 `image/png`; el servicio siguió `active` y
Chromium se reinició automáticamente con el release nuevo.

## Corrección operativa posterior

La carga central posterior dejó el marco en manifiesto 72 con 13 medios. El
outbox local contenía cuatro eventos de encuadre dirigidos a identificadores
`local-*` del demo anterior. Esos identificadores no son UUID centrales y
bloqueaban de forma transaccional los eventos siguientes. El servidor ahora
los consume como eventos legados ignorados, conserva una auditoría con motivo
`legacy-media-id` y continúa el lote. No se altera ningún medio central. El
outbox real quedó en cero y salud, última sincronización y telemetría volvieron
a estado correcto.

Se activó la release conjunta `/opt/naiskos/releases/20260829-d43d2edee117` y
se conserva `/opt/naiskos/releases/20260829-c07bb161f173` para rollback. La
nueva release hace visibles los errores no HTTP-2xx de outbox/telemetría y
suprime solamente el log de acceso rutinario.

También se corrigió la conservación de diagnósticos: Raspberry Pi OS forzaba
`Storage=volatile`. Se instaló la política Naiskos en
`/etc/systemd/journald.conf.d/60-naiskos-persistent-journal.conf`, se creó un
marcador, se realizó un reinicio completo y se comprobó que el marcador
anterior permanecía. Agente, timer, Chromium en kiosco, manifiesto 72, pantalla,
audio, red y hora reaparecieron correctamente sin borrar datos locales.

## Administración de medios y preferencias

La release `20260829-9902b7a1c1a6` añadió desde la galería:

- rotar a izquierda, derecha o restablecer fotos y videos;
- regenerar centralmente el póster de cada video rotado;
- eliminar sólo de este marco con confirmación;
- mantener el medio vigente hasta que la central publique la operación;
- conservar archivos locales huérfanos durante 24 horas antes de depurarlos.

El agente envía el outbox antes de pedir contenido y serializa sus escrituras.
Además compara `settingsRevision`, independiente de la versión multimedia. En
la validación real el manifiesto cambió de 74 a 75 y la revisión de ajustes de
0 a 1; permanecieron exactamente: 30 segundos, crossfade 450 ms, `contain`,
orden más reciente, volumen 0,5, mute activo, texto oculto y remitente oculto.
El outbox quedó en cero y no se alteró ningún medio real durante la prueba.

La release anterior `/opt/naiskos/releases/20260829-d43d2edee117` permanece
lista para rollback. La prueba prolongada reinició su ventana con la etiqueta
`demo-mixto-media-admin-8h` el 29 de agosto a las 16:57:22, hora de Lima.

## Pesos y duración en la galería real

La release conjunta `20260829-30404593cf44`, con bundle Angular
`main-3R4MPPEG.js`, normaliza y valida los campos numéricos recibidos del
servidor antes de guardar el manifiesto. Conserva compatibilidad con un
manifiesto anterior que todavía contenga números codificados como texto.

La comprobación real posterior sobre el manifiesto 959 confirmó 870 fotografías y 14
videos, todos con pesos numéricos y todos los videos con duración y peso de
póster numéricos. Los totales que debe mostrar el visor son:

- fotografías: 299.767.160 bytes, presentados como **286 MB**;
- videos y sus pósteres: 139.361.086 bytes, presentados como **133 MB**;
- contenido total: 439.128.246 bytes, presentados como **419 MB**.

Las tarjetas de video formatean la duración como `m:ss`; por ejemplo, 66,026 s
se presenta como `1:06`. La configuración productiva permaneció intacta en la
revisión 7: 30 s, crossfade de 450 ms, `contain`, más reciente primero, volumen
0,5, mute activo, texto oculto y remitente oculto.

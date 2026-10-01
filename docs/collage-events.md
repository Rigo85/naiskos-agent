# Observación de mosaicos dinámicos

El endpoint local `POST /api/v1/viewer/collage-events` exige la cabecera
`X-Naiskos-Request: viewer` y valida un contrato cerrado. No acepta URLs,
leyendas, nombres de remitentes ni claves de detalle arbitrarias.
`type=viewer.collage`; cada entrada tiene `id`, `sessionId`, `buildId`, `at`,
`sequence`, `action` y `details`.

El agente espera la escritura atómica del outbox antes de responder 202, deduplica
reintentos concurrentes y escribe una entrada Pino `Collage lifecycle`. El envío
central utiliza la sincronización ordinaria; no dispara una sincronización por
cada escena. La tabla central `naiskos.device_events` ya admite este tipo, con
conflicto por UUID ignorado: no necesita migración ni desplegar el servidor.

## Qué revisar

| Evento | Evidencia |
| --- | --- |
| `plan-requested` | Cuándo se decidió calcular, vuelta/semilla destino y tamaño |
| `plan-ready` | Cuándo terminó, número de escenas y milisegundos de worker |
| `lookahead-ready` | Ventana de geometrías afinadas por anticipado |
| `preload-ready` / `preload-used` | Archivos preparados / realmente reutilizados |
| `preload-joined` | Navegación aprovecha una carga en curso, sin reiniciar su deadline |
| `reserve-ready` / `reserve-used` | Reserva auxiliar: `reason` diferencia lista, sólo póster, límite, fallo o cancelación; usada significa calentamiento previo, no sustituye la validación DOM |
| `input-classified` | Gesto reconocido y duración del contacto; sin coordenadas ni movimientos crudos |
| `navigation-requested` / `navigation-ignored` | Dirección solicitada y motivos de descarte, incluido doble toque/fundido |
| `navigation-joined` | Toque atendido por el avance automático coincidente, incluso si se suelta justo después del commit; no genera otro paso |
| `navigation-deferred` / `navigation-deferred-used` / `navigation-deferred-cleared` | Intención única guardada/reemplazada, consumida o cancelada; `operationId` identifica el fundido al que pertenece |
| `navigation-visible` | Tiempo desde la orden aceptada hasta iniciar el fundido o confirmar una presentación directa; no incluye toda la duración del fundido ni tiempo previo de entrega del touch por el SO |
| `round-adopted` | Inicio efectivo de la nueva mezcla, vuelta anterior y fallback |
| `scene-committed` | Todos los IDs mostrados, vistos acumulados y cohorte |
| `manual-selection` / `history-*` | Repeticiones deliberadas por navegación del usuario |
| `plan-cancelled` / `preload-cancelled` | Trabajo descartado y motivo |
| `planning-suspended` / `planning-resumed` | Reposo, sin avanzar el recorrido |
| `plan-failed` / `renewal-deferred` / `refinement-fallback` | Degradación controlada y reintentos |
| `checkpoint-*` | Restauración, rechazo o fallo de persistencia local |

Los eventos de planificación incluyen `round`, `seed`, `basis` (huella de las
entradas para correlación, no credencial), `planningGeneration` y `manifestVersion`. Las precargas se
correlacionan también por `operationId`; los fallos concretos de archivos siguen
el circuito existente `viewer.media.preparation-failed`.

`direction` vale -1/1. Las consultas de precarga/historial en segundo plano no
se registran como selecciones manuales. Para investigar una pausa percibida,
correlacionar `input-classified → navigation-requested → preload-joined/used →
navigation-visible → scene-committed` por sesión, operación y tiempos. No todos
los pasos aparecen en cada ruta; la reserva sólo de póster no garantiza video
listo y un registro de planificación no mide latencia del touch.

Comprobar que `plan-ready` precede ampliamente a `round-adopted`, que no haya
adopciones durante reposo, que cada vuelta normal cubra su cohorte sin duplicados
(excluyendo galería/historial) y que `fallback=true` no sea habitual. Una vuelta
con muchos medios puede durar horas o días: no exigir renovación por reloj.
Comparar semilla y agrupación, no sólo el contador de vueltas. Bibliotecas pequeñas
o muy restringidas pueden repetir una distribución aun con semilla distinta.

Logs locales, respetando la retención de journald configurada en el equipo:

```bash
journalctl -u naiskos-agent.service --since '2 hours ago' -o cat |
  jq -Rc 'fromjson? | select(.event.type == "viewer.collage") | .event'
```

En PostgreSQL, después de definir la variable psql `frame_id`:

```sql
SELECT occurred_at, payload->>'sessionId' AS session,
       payload->>'buildId' AS build, payload->>'sequence' AS sequence,
       payload->>'action' AS action, payload->'details' AS details
FROM naiskos.device_events
WHERE frame_id = :'frame_id'::uuid
  AND kind = 'viewer.collage'
  AND occurred_at >= now() - interval '2 days'
ORDER BY occurred_at, (payload->>'sequence')::bigint;
```

## Límites reales de retención

- La cola del visor retiene hasta 128 eventos mientras no responde el agente.
  Al desbordarse conserva los más recientes y marca `deliveryOverflow`.
- El outbox existente limita los eventos ordinarios a 1.000; mantiene aparte
  resultados de releases. Una desconexión central prolongada puede recortar el
  principio del detalle. Consultar también journald, que tiene su propia rotación.
- La escritura atómica evita JSON parcial, pero no equivale a garantizar cada
  evento ante corte eléctrico, fallo físico de microSD o agotamiento del disco.
  El checkpoint y las trazas son auxiliares: sus fallos no deben detener el visor.
- La API deduplica en memoria los últimos 512 UUID; el outbox y PostgreSQL
  deduplican por ID. Tras reinicio podría repetirse una línea local si el navegador
  reenvía un evento cuyo acuse se perdió, sin duplicar la fila central.
- Un evento rechazado con 400 se descarta para no bloquear los siguientes.
  Cada petición tiene un límite de cinco segundos. Errores de red/servidor
  conservan el UUID y reintentan con espera de 1–30 segundos. No confundir una laguna
diagnóstica con una escena no reproducida: revisar sesión, secuencia y desbordes.

## Origen y medición de las órdenes

Las nuevas órdenes y mediciones incluyen `source`: `manual` (gesto), `gallery`
(selección explícita), `automatic` (temporizador/final de video) o `system`
(arranque, aplicación de manifiesto y recuperación/reintento). No deducir intención
humana de que una operación pueda sustituir otra. La presentación directa cierra
también su medición: no arrastra el tiempo de exposición hasta el primer fundido.

`navigation-visible.reason` distingue `direct`/`crossfade`; mide la decisión del
visor, no el instante físico en que el panel pinta un píxel. Una orden diferida
conserva el momento de su último gesto válido: su latencia incluye la espera para
terminar el fundido previo y preparar el nuevo destino. `navigation-deferred-used`
mide sólo la espera hasta consumirla y referencia la operación anterior; el
`navigation-visible` posterior referencia la nueva operación. Una petición
reemplazada, cancelada o unida al automático no genera una medición ficticia de
otro cambio. Filtrar por `source` antes de calcular estadísticas manuales.

Las releases anteriores carecen de esta separación. En particular, excluir el
primer `navigation-visible` de `20260930-navigation-reserve-001`: podía incluir
la exposición inicial completa de una foto, sin representar un toque lento.

No hay un log por frame de video ni por tick de reloj. Se registran decisiones y
cambios de estado para mantener acotado el coste en disco y memoria.

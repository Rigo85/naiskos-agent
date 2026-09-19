# Metadatos decorativos de collage

`settings.collageBackground` admite `material` (predeterminado, también cuando
falta en una configuración antigua) y `black`. Una elección explícita de negro
se conserva; no se sustituye por el valor predeterminado.
Sigue el circuito normal de preferencias locales, revisiones, outbox y respaldo
central; recibir contenido nuevo no debe reemplazar una preferencia local vigente.

`media[].bandColors` es una pareja opcional de hexadecimales `#rrggbb`. La validación
descarta una pareja inválida sustituyéndola por null, sin rechazar el manifiesto.
Se conserva al materializar el manifiesto local y funciona sin conexión. No hay
nuevas descargas, archivos ni dependencias para estos colores.

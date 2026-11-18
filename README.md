# seguros_correo

Cliente de correo web propio, sincronizado por IMAP, pensado para convivir con Outlook sobre el mismo buzón. Es la base sobre la que irán los plugins de gestión de siniestros.

Estado: validación técnica.

- Fase 0, andamiaje: hecha.
- Fase 1, prueba del reflejo: hecha contra un hosting real (DonDominio) y con Mail de Apple como segundo cliente. Falta Outlook de escritorio.
- Fase 2, datos y sincronización de solo lectura: hecha.
- Fase 3a, usuarios, sesiones, permisos por buzón y API de lectura: hecha.
- Fase 3b, interfaz web de lectura (carpetas, lista, lectura segura, adjuntos, búsqueda, archivo y avisos en vivo): hecha.
- Fase 4, acciones con reflejo (leído, bandera, mover, borrar y deshacer): hecha.
- Fase 5, redactar y enviar (borradores, responder, reenviar, adjuntos, Bandeja de salida y copia en Enviados): hecha.

## Requisitos

Node 22.19 o superior, pnpm 9 y Docker.

## Uso

```bash
pnpm install
pnpm dev:up            # Postgres + servidor de correo de pruebas (ana@ y luis@correo.test)
pnpm check             # lint, tipos, formato y pruebas de unidad
pnpm check:all         # lo anterior más las pruebas de integración (necesita dev:up)
pnpm reflejo ayuda     # herramienta de la Fase 1; ver docs/outlook-reflejo.md
pnpm cuenta alta       # da de alta el buzón de .env.reflejo (o el de pruebas de Docker)
pnpm cuenta sync       # sincroniza todos los buzones hasta ponerlos al día
pnpm cuenta estado     # carpetas, correos y eventos de cada buzón
pnpm usuario crear <correo> <nombre> [--admin]   # crea un usuario (pide la contraseña)
pnpm usuario acceso <correo-usuario> <correo-buzón>   # le concede un buzón
pnpm build             # compila la interfaz web (apps/web/dist)
pnpm servidor          # interfaz y API en http://127.0.0.1:3000 + sincronización en vivo
pnpm web               # interfaz en modo desarrollo (puerto 5173, con el servidor en marcha)
pnpm dev:down          # parar el entorno (dev:reset borra también los datos)
```

`pnpm cuenta` y `pnpm servidor` necesitan un fichero `.env` con `MASTER_KEY`, la clave con la que se cifran las contraseñas de los buzones (`openssl rand -hex 32`). Los correos originales se guardan en `datos/`.

## Acceso y permisos

- **Sesión por cookie** que el navegador no expone a la página ni envía a otros sitios, más un token de sesión obligatorio en cada petición que cambia algo.
- **Contraseñas** guardadas con scrypt; límite de intentos fallidos de acceso.
- **Permisos por buzón:** cada usuario ve solo los buzones que se le han concedido. Administrar no da acceso al contenido: el administrador tampoco lee un buzón que no tenga concedido. Lo que no se puede ver responde como si no existiera.
- **Auditoría** de accesos, altas, concesiones y lecturas de correos, en un registro que solo admite inserciones.

## Interfaz web

React, Vite y Tailwind, sin dependencias de terceros en tiempo de ejecución (la tipografía va incluida, no se carga de fuera). El diseño está en un lienzo aparte y el código sigue sus medidas y colores.

- **Carpetas, lista y lectura** en tres columnas, con la conversación plegada sobre el correo abierto y un panel de contexto que se despliega a la derecha.
- **Los correos se muestran saneados y aislados:** el servidor quita scripts, formularios, hojas de estilo y estilos peligrosos, y bloquea las imágenes externas hasta que se piden; la interfaz los pinta además en un marco que no puede ejecutar nada.
- **Los adjuntos se descargan siempre como fichero.**
- **Búsqueda** en todos los buzones concedidos y en el archivo, sin distinguir acentos, con filtros por remitente, fechas y adjuntos.
- **Archivo:** lo retirado del buzón del servidor sigue visible, marcado como tal.
- **Avisos en vivo:** lo que cambia en el servidor de correo aparece sin recargar.
- **Huecos para plugins** ya reservados: riel de módulos, fila de la lista, barra de acciones y panel de contexto.

## Acciones con reflejo

Lo que se hace aquí se ve en Outlook, y al revés.

- **Leído, bandera, mover y borrar.** Abrir un correo lo marca como leído. Borrar lo envía a la Papelera; borrar desde la Papelera lo quita del buzón, previa confirmación, y el correo se conserva en nuestro archivo.
- **Cola por buzón.** Cada acción cambia la pantalla al instante y queda en cola (`mail_actions`); se aplica en el servidor de correo al principio del siguiente ciclo, normalmente en uno o dos segundos. Si no hay conexión, espera.
- **Deshacer.** Mover y borrar a la Papelera se pueden deshacer: si aún no ha salido, se cancela; si ya se hizo, se pide el movimiento contrario. El correo conserva su identidad.
- **Si otro programa se adelanta.** Cuando el correo ya no está donde se esperaba, la acción se rechaza, la pantalla vuelve al estado real y se avisa a quien la pidió.
- **Auditoría.** Cada acción queda anotada con su usuario.

## Redactar y enviar

- **Se escribe en el panel de lectura,** con la lista a la vista. Nuevo correo, responder, responder a todos y reenviar; el original va citado y, al reenviar, con sus adjuntos.
- **Borradores con reflejo.** El borrador se guarda solo y aparece en Borradores del servidor, también en Outlook, siempre en una sola versión. Las versiones anteriores no van al archivo.
- **Diez segundos para deshacer.** Al enviar, el correo espera en la Bandeja de salida; si falla, se queda allí con el motivo.
- **Una sola entrega y una sola copia.** Cada correo lleva un Message-ID fijo desde que se crea. En cuanto el servidor de salida lo acepta queda anotado: tras un corte solo falta dejar la copia en Enviados, y antes de guardarla se comprueba que no esté ya. Si el corte llega sin saber si salió, no se reenvía a ciegas: queda como fallido para que lo decida una persona.
- **El original queda marcado** como respondido o reenviado, también en Outlook.
- **Firma por usuario y buzón,** en texto sin formato.
- **Lo que manda el editor pasa por el mismo filtro que el correo entrante** antes de salir.

## Apuntado para configuración

Comportamientos que hoy son fijos y deberán poder elegirse (por usuario o por oficina):

- **Margen para deshacer un envío.** Hoy son 10 segundos.
- **Qué se abre al mover o borrar un correo.** Hoy se abre el siguiente de la lista, que queda marcado como leído, como hace Outlook. Alternativas: no abrir ninguno, o abrir el anterior.

## Cómo funciona la sincronización

- **Identidad:** cada presencia de un correo en una carpeta se identifica por carpeta, validez y uid. El correo en sí tiene un identificador propio que no cambia aunque se mueva, y se reconoce en otra carpeta por una huella (Message-ID, fecha de llegada, tamaño, asunto y remitente). El Message-ID solo no vale: no es único.
- **Movimientos y borrados:** lo que desaparece de una carpeta se marca, no se borra. Cuando un correo lleva un tiempo sin ninguna copia en el servidor se anota como retirado del buzón.
- **Archivo propio:** que un correo se borre en el servidor (o se vacíe el buzón para liberar espacio) no lo elimina de aquí. El original, el texto y los adjuntos se conservan según una política de conservación propia, todavía por definir.
- **Dos conexiones por buzón como máximo:** una escucha la Entrada y avisa al instante; la otra trabaja por ciclos y se cierra.
- **Histórico:** se carga por ventanas, de lo más reciente a lo más antiguo, y los cuerpos se bajan después.
- **Eventos:** cada cambio deja un evento en la base (`message.received`, `message.moved`, `message.flagsChanged`, `message.removed`) en la misma transacción. Es el enganche para los plugins.

## Estructura

```
apps/server/       Servicio: sincronización IMAP, envío SMTP, API
apps/web/          Interfaz web
packages/shared/   Código compartido entre servidor e interfaz
docker/            Entorno de desarrollo
docs/              Resultados de la prueba con Outlook
scripts/           Utilidades de desarrollo
```

Solo se usan librerías con licencia permisiva (MIT, Apache, BSD); nada GPL ni AGPL.

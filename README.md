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
- Fase 6, acceso con cuenta de Google y de Microsoft 365: hecha y validada contra los dos proveedores reales.
- Fase 7, módulo de expedientes en los cuatro huecos de la interfaz: hecha.

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
pnpm demo correos      # buzón «Siniestros (demo)» en Docker con 32 siniestros inventados, conectado
pnpm demo expedientes  # con el servidor en marcha: abre y lleva sus expedientes (rehacer = volver a lanzar)
pnpm whatsapp-simulador # hace de Meta en local: manda conversaciones de WhatsApp al módulo «whatsapp»
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

## Qué se guarda de cada correo

Un correo es un dato a medias estructurado. Se guarda en tres capas:

1. **El original, intacto,** en disco (`datos/raw/`). Cualquier dato que se quiera más adelante se puede sacar de aquí: `pnpm reprocesar --todos` vuelve a procesar todos los correos sin descargar nada.
2. **Lo que tiene forma fija,** en la base, extraído al llegar:
   - cabeceras habituales, conversación, carpeta y marcas;
   - **participantes** (`message_addresses`): una fila por correo, dirección y papel (de, para, copia, copia oculta, responder a), con el dominio aparte. Responde a «todo lo cruzado con esta persona o con este dominio»;
   - **sentido** (recibido o enviado), **prioridad**, si es una **respuesta automática**, y **todas las cabeceras** en un campo flexible;
   - nombre, tipo y tamaño de cada adjunto.
     La búsqueda de texto incluye asunto, remitente, destinatarios, nombres de adjuntos y cuerpo, y se puede filtrar por participante y por sentido.
3. **Los datos de negocio** (`message_facts`): número de siniestro, póliza, matrícula, tipo de correo… El núcleo no decide cuáles ni cómo se obtienen; solo los guarda ligados al correo, cada uno con su origen: de qué parte salió, el texto en el que se apoya, quién lo produjo (regla, modelo o persona), con qué confianza y si alguien lo ha revisado.

El único dato que se anota hoy de forma automática es `revisado_por`: el nombre de cada persona que abre el correo, útil en buzones compartidos.

Cómo se rellenan los datos de negocio está por decidir, y es donde entrará la IA. Lo que ya existe es el sitio y el enganche: al terminar de procesar un correo se emite el evento `message.enriched`, y quien lo escuche puede escribir datos con `replaceFacts`, que sustituye los suyos sin tocar los de otros. Una persona también puede añadirlos o quitarlos, y se pueden pedir todos los correos que comparten un dato.

El texto libre no se vectoriza. Si llega a hacer falta, se puede hacer en el mismo Postgres.

## Texto limpio para el contexto

Para que una persona o un modelo pueda trabajar con un expediente hace falta su texto, limpio y localizable. Esta capa no usa IA.

- **Cuerpo de cada correo sin lo que arrastra** (`body_clean`): se quitan el historial citado (Gmail, Outlook, Apple Mail, Thunderbird, y las cabeceras «El … escribió:» o «-----Mensaje original-----»), la firma y el aviso legal. Es conservador: ante la duda deja texto de más, y un reenvío no se recorta. El texto completo se conserva aparte.
- **Texto de los adjuntos, por páginas** (`document_texts`, `document_pages`): PDF con capa de texto, Word (.docx), Excel (.xlsx, una página por hoja), correos adjuntos (.eml, .msg), HTML y texto. Cada documento se identifica por la huella de su contenido, así que el mismo fichero en varios correos se lee una sola vez.
- **Lo que no tiene texto queda marcado:** las imágenes y los PDF escaneados, como «pendiente de reconocimiento»; en un PDF mixto, página a página. El reconocimiento de texto (OCR) es el siguiente paso; los manuscritos, el último.
- **Se lee aparte de la sincronización,** en un proceso propio: el correo se puede abrir en cuanto llega y el texto de sus adjuntos aparece unos segundos después. Al terminar cada documento se emite `document.extracted`.
- **La búsqueda encuentra dentro de los adjuntos** y dice en cuál y en qué página.
- **Cada expediente sabe cuánto contexto reúne:** correos y adjuntos que cuentan, tamaño aproximado y cuántos adjuntos no tienen texto.

`pnpm reprocesar --todos --documentos` rehace todo desde los originales.

Librerías, todas de licencia permisiva: `unpdf` (MIT), `mammoth` (BSD-2), `exceljs` (MIT), `@kenjiuno/msgreader` (Apache-2.0) y `node-html-parser` (MIT).

## Plugins

De serie, la aplicación es un cliente de correo con contexto: correo, texto limpio, lectura de adjuntos, búsqueda y anotaciones. Lo demás son módulos opcionales, que se cargan con la variable `PLUGINS` (separados por comas):

- `expedientes`: agrupar correos en expedientes, con sus datos y su contexto. Tiene página propia para encontrar un caso al momento (por número, matrícula, cliente, teléfono o nº de siniestro) y leer su historia; marca lo que ha entrado desde la última vez que lo miraste, y en la bandeja añade el filtro «Sin expediente».
- `contactos`: la agenda de la oficina, con una ficha por persona o empresa y todos sus correos y teléfonos. Así se reconoce a quien escribe, sea por correo o por WhatsApp. «Por revisar» propone fichas para quien escribe sin tenerla y posibles duplicados, por ejemplo un móvil de la firma que también escribe por WhatsApp; nada entra sin que una persona lo confirme. Con `expedientes`, cada expediente tiene su cliente. La agenda está preparada para pólizas e importación, que aún no están hechas.
- `tramitacion`: llevar cada expediente como un caso, con fases, tareas de una plantilla, plazos (naturales o hábiles, desde el siniestro, la apertura o la tarea anterior), esperas a terceros con su reclamación y un semáforo de salud calculado por reglas. Los terceros vienen de la agenda. Necesita `expedientes` y `contactos`; al activarse por primera vez, su antiguo directorio pasa a la agenda. Trae de serie la plantilla «Siniestro de automóvil con atestado»; sus plazos legales son orientativos hasta confirmarlos.
- `ocr`: reconocer el texto de fotos y documentos escaneados (Tesseract en español, dentro del propio servidor).
- `vision`: leer fotos, planos y escaneados con un modelo de visión, en cola: copia su texto y anota qué contienen. Habla la API de chat estándar, así que sirve igual con OpenRouter (solo para pruebas: los documentos salen fuera) que con un servidor en la oficina. Configuración en `.env.example`; la cola se ve en Configuración.

La interfaz muestra solo los módulos que el servidor tiene cargados. Un plugin añade funciones sin tocar el núcleo.

**En el servidor** (`apps/server/src/plugins/`), un plugin puede tener:

- **Tablas propias,** que crea él mismo al arrancar.
- **Rutas** bajo `/api/plugins/<id>`, con la misma sesión y los mismos permisos por buzón.
- **Reacción a los eventos del correo** (`message.received`, `message.moved`…). Cada plugin tiene su marcador en la base, así que tras una parada sigue donde lo dejó.

**En la interfaz** (`apps/web/src/plugins/`), puede pintar en cuatro huecos:

1. Una entrada en el riel de módulos, con su propia lista.
2. Una etiqueta en las filas de la lista de correos.
3. Una acción en la barra del correo abierto.
4. Una sección en el panel de contexto.

Además: una página a todo el ancho, apartados en Configuración, filtros propios en la lista de correos (como «Sin expediente»), un bloque y una línea de estado dentro de cada expediente, y un aviso en el redactor.

El plugin de expedientes agrupa correos:

- **De cualquier buzón.** Un expediente puede reunir correos de varios buzones, y un correo puede estar en varios expedientes.
- **Por conversaciones.** Al crear un expediente desde un correo, o al añadir un correo a uno que ya existe, entra toda su conversación. Los correos que lleguen después a esa conversación, o con el número del expediente en el asunto, se añaden solos.
- **Añadir y quitar a mano,** desde la barra de cualquier correo, con una confirmación en cada caso. Se añade o se quita la conversación entera; los correos no se borran ni se mueven.
- **Excluir del contexto.** Un correo de un hilo puede no tener que ver con el expediente. No se saca: se marca como «fuera del contexto», sigue viéndose y se puede volver a incluir. El contexto es lo que se leerá para resumir o conversar sobre el expediente.
- **Datos del expediente:** aseguradora (de un catálogo que mantiene un administrador), tipo, nº de siniestro, fecha del siniestro y gestor. Se cambian en «Editar datos».
- **La historia del caso,** de lo más reciente a lo más antiguo, con quién escribe y su papel (cliente, aseguradora, perito, nosotros) y si fue por WhatsApp. Lo que entró solo después de la última vez que lo abriste sale como **nuevo**.
- **Antes de abrir otro,** si quien escribe ya tiene un expediente abierto, se avisa para añadir el correo a ese.
- **Con los permisos de siempre.** Quien no tiene un buzón no ve los correos de ese buzón aunque estén en un expediente que sí ve.

El siguiente paso previsto es poder conversar con cada expediente, incluidos los adjuntos de sus correos. Para eso existen ya el contexto (qué correos cuentan) y los metadatos de correo y de expediente.

Hoy los plugins se compilan con la aplicación: se añaden a una lista en `main.ts` y en `plugins/index.ts`. Cargarlos sin recompilar queda fuera de esta validación.

## Buzones de Google y de Microsoft 365

Estos proveedores no admiten (o están retirando) la entrada con contraseña. El buzón se conecta entrando con la cuenta en la página del proveedor; la contraseña nunca pasa por este servidor.

- **Configuración:** `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID` y `MICROSOFT_CLIENT_SECRET` en `.env`. Sin ellos, la opción no aparece. La dirección de vuelta que hay que registrar en el proveedor es `http://127.0.0.1:3000/api/oauth/callback` (o `PUBLIC_URL` + `/api/oauth/callback`).
- **Permisos que se piden:** en Google, `https://mail.google.com/` (IMAP y SMTP); en Microsoft, `IMAP.AccessAsUser.All`, `SMTP.Send` y `offline_access`.
- **Los permisos se guardan cifrados** y se renuevan solos antes de caducar. Si el proveedor los retira, el buzón queda en «credenciales caducadas» hasta que un administrador lo vuelva a conectar.
- **Microsoft 365, comprobado contra una organización real:** la lectura por IMAP funciona con el permiso tal cual. El envío por SMTP viene **desactivado de serie** en las organizaciones nuevas (error `535 5.7.139`): un administrador tiene que activar «SMTP autenticado» en cada buzón, o habrá que enviar por la API de Microsoft Graph. Exchange no ofrece CONDSTORE ni SPECIAL-USE, y enseña por IMAP carpetas que no son de correo (calendario, contactos, tareas), que aquí se ocultan.
- **Gmail** guarda por su cuenta la copia de lo enviado, así que aquí no se añade otra; sus carpetas virtuales (Todos, Destacados, Importantes) no se sincronizan.

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

# seguros_correo

Cliente de correo web propio, sincronizado por IMAP, pensado para convivir con Outlook sobre el mismo buzón. Es la base sobre la que irán los plugins de gestión de siniestros.

Estado: validación técnica.

- Fase 0, andamiaje: hecha.
- Fase 1, prueba del reflejo: hecha contra un hosting real (DonDominio) y con Mail de Apple como segundo cliente. Falta Outlook de escritorio.
- Fase 2, datos y sincronización de solo lectura: hecha.

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
pnpm servidor          # servicio de sincronización en vivo
pnpm dev:down          # parar el entorno (dev:reset borra también los datos)
```

`pnpm cuenta` y `pnpm servidor` necesitan un fichero `.env` con `MASTER_KEY`, la clave con la que se cifran las contraseñas de los buzones (`openssl rand -hex 32`). Los correos originales se guardan en `datos/`.

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
packages/shared/   Código compartido entre servidor e interfaz
docker/            Entorno de desarrollo
docs/              Resultados de la prueba con Outlook
scripts/           Utilidades de desarrollo
```

Solo se usan librerías con licencia permisiva (MIT, Apache, BSD); nada GPL ni AGPL.

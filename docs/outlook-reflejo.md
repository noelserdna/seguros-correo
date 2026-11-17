# Prueba del reflejo con Outlook (Fase 1)

Objetivo: comprobar con un buzón real que lo que hacemos por IMAP/SMTP se ve en Outlook y al revés, y anotar cómo se comporta Outlook. **El esquema de datos de la Fase 2 se cierra con estos resultados.**

## Preparación

1. Un buzón real en un hosting con IMAP, configurado en Outlook **como cuenta IMAP** (no POP).
2. Copiar `.env.reflejo.example` a `.env.reflejo` y rellenar servidor, usuario y contraseña. Ese fichero no se sube a git.
3. `pnpm install` y comprobar la conexión con `pnpm reflejo info`.

Órdenes disponibles: `pnpm reflejo ayuda`.

## Datos del entorno

| Dato                                                    | Valor |
| ------------------------------------------------------- | ----- |
| Proveedor del correo                                    |       |
| Outlook: clásico o nuevo, y versión                     |       |
| Tipo de cuenta en Outlook (IMAP / POP / Exchange)       |       |
| Servidor IMAP (lo dice `info`)                          |       |
| Capacidades que faltan (`info` marca «NO»)              |       |
| Conexiones admitidas con Outlook abierto (`conexiones`) |       |
| Carpeta de Enviados que usa Outlook                     |       |
| Carpeta de Borradores que usa Outlook                   |       |
| Carpeta de Papelera que usa Outlook                     |       |

## Nuestra aplicación → Outlook

Ejecutar la orden y mirar Outlook. Anotar si se ve y cuánto tarda.

| Acción          | Orden                    | ¿Se ve en Outlook? | Tarda | Notas                                           |
| --------------- | ------------------------ | ------------------ | ----- | ----------------------------------------------- |
| Marcar leído    | `marcar <uid> leido`     |                    |       |                                                 |
| Marcar no leído | `marcar <uid> no-leido`  |                    |       |                                                 |
| Destacar        | `marcar <uid> destacado` |                    |       |                                                 |
| Mover a carpeta | `mover <uid> <carpeta>`  |                    |       |                                                 |
| Borrar          | `borrar <uid>`           |                    |       |                                                 |
| Crear carpeta   | `crear-carpeta Prueba`   |                    |       | ¿Aparece sola o hay que suscribirla?            |
| Enviar          | `enviar <dirección>`     |                    |       | ¿Una sola copia en Enviados?                    |
| Responder       | `responder <uid>`        |                    |       | ¿Icono de respondido? ¿Mismo hilo?              |
| Borrador        | `borrador`               |                    |       | ¿Se puede abrir, editar y enviar desde Outlook? |

## Outlook → nuestra aplicación

Dejar `pnpm reflejo vigilar` en marcha, hacer el cambio en Outlook y anotar lo que imprime y cuánto tarda. Después confirmar con `listar`.

| Acción en Outlook       | ¿Lo detectamos? | Tarda | Qué imprime `vigilar` / notas                               |
| ----------------------- | --------------- | ----- | ----------------------------------------------------------- |
| Abrir un correo (leído) |                 |       |                                                             |
| Marcar no leído         |                 |       |                                                             |
| Marcar para seguimiento |                 |       |                                                             |
| Mover a carpeta         |                 |       |                                                             |
| Borrar                  |                 |       | ¿Va a Papelera o queda tachado en la carpeta?               |
| Vaciar papelera         |                 |       |                                                             |
| Enviar un correo nuevo  |                 |       | ¿En qué carpeta queda la copia? (`listar <carpeta>`)        |
| Responder a un correo   |                 |       | ¿Marca el original como respondido?                         |
| Guardar un borrador     |                 |       | ¿Llega al servidor? ¿Cada cuánto lo guarda? ¿Cambia de uid? |
| Asignar una categoría   |                 |       | ¿Aparece alguna marca?                                      |
| Llega un correo nuevo   |                 |       |                                                             |

## Aspecto en Outlook de lo que enviamos

Abrir en Outlook el correo de `enviar` y el de `responder`.

| Comprobación                                                     | Resultado |
| ---------------------------------------------------------------- | --------- |
| Tipografía, tabla y lista se ven bien                            |           |
| Acentos y eñes correctos                                         |           |
| La cita de la respuesta se parece a la de Outlook                |           |
| Al responder desde Outlook a nuestro correo, el hilo se mantiene |           |

## Conclusiones

- Condiciones definitivas que debe cumplir la configuración de Outlook:
- Sorpresas y cosas a tener en cuenta en la sincronización:
- Cambios al esquema de la Fase 2:

## Referencia: resultado contra el servidor de pruebas (Dovecot 2.4 en Docker)

Ejecutado el 17/11/2026 para validar el script, sin Outlook:

- Capacidades: IDLE, CONDSTORE, QRESYNC, MOVE, UIDPLUS y SPECIAL-USE disponibles; OBJECTID no.
- Límite de conexiones: 10 por usuario (la 11.ª se rechaza).
- Los cambios de marcas, las altas y las salidas de la carpeta llegan a `vigilar` en menos de un segundo.
- El servidor no guarda solo la copia en Enviados: la subimos nosotros y devuelve el uid.
- Al mover, el servidor devuelve el uid nuevo del correo en la carpeta de destino.

# seguros_correo

Cliente de correo web propio, sincronizado por IMAP, pensado para convivir con Outlook sobre el mismo buzón. Es la base sobre la que irán los plugins de gestión de siniestros.

Estado: validación técnica. Fases 0 (andamiaje) y 1 (herramienta de prueba del reflejo) hechas; la prueba con Outlook real está pendiente.

## Requisitos

Node 22.19 o superior, pnpm 9 y Docker.

## Uso

```bash
pnpm install
pnpm dev:up            # Postgres + servidor de correo de pruebas (ana@ y luis@correo.test)
pnpm check             # lint, tipos, formato y pruebas de unidad
pnpm check:all         # lo anterior más las pruebas de integración (necesita dev:up)
pnpm reflejo ayuda     # herramienta de la Fase 1; ver docs/outlook-reflejo.md
pnpm dev:down          # parar el entorno (dev:reset borra también los datos)
```

## Estructura

```
apps/server/       Servicio: sincronización IMAP, envío SMTP, API
packages/shared/   Código compartido entre servidor e interfaz
docker/            Entorno de desarrollo
docs/              Resultados de la prueba con Outlook
scripts/           Utilidades de desarrollo
```

Solo se usan librerías con licencia permisiva (MIT, Apache, BSD); nada GPL ni AGPL.

#!/usr/bin/env bash
# Prepara y arranca el entorno de desarrollo: Postgres + servidor de correo de pruebas.
# Es idempotente: solo genera el certificado y las cuentas si no existen.
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker/compose.dev.yml"
CONFIG="docker/mail/config"
IMAGE="ghcr.io/docker-mailserver/docker-mailserver:${DMS_TAG:-17.0.0}"
PASSWORD="${TEST_MAIL_PASSWORD:-prueba-1234}"
ACCOUNTS=("ana@correo.test" "luis@correo.test")

mkdir -p "$CONFIG/ssl"

if [[ ! -f "$CONFIG/ssl/cert.pem" ]]; then
  echo "Generando certificado autofirmado para mail.correo.test…"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -subj "/CN=mail.correo.test" \
    -addext "subjectAltName=DNS:mail.correo.test,DNS:localhost,IP:127.0.0.1" \
    -keyout "$CONFIG/ssl/key.pem" -out "$CONFIG/ssl/cert.pem" 2>/dev/null
fi

if [[ ! -f "$CONFIG/postfix-accounts.cf" ]]; then
  echo "Creando cuentas de prueba…"
  : >"$CONFIG/postfix-accounts.cf"
  for account in "${ACCOUNTS[@]}"; do
    hash=$(docker run --rm --entrypoint doveadm "$IMAGE" pw -s SHA512-CRYPT -p "$PASSWORD")
    echo "${account}|${hash}" >>"$CONFIG/postfix-accounts.cf"
  done
fi

docker compose -f "$COMPOSE" up -d --wait
echo "Entorno listo: Postgres en 127.0.0.1:54329, IMAP en 127.0.0.1:1993, envío en 127.0.0.1:1587."

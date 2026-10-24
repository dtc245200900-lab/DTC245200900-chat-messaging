#!/bin/sh
set -eu

psql \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=app_user="$POSTGRES_APP_USER" \
  --set=app_password="$POSTGRES_APP_PASSWORD" \
  --set=exporter_user="$POSTGRES_EXPORTER_USER" \
  --set=exporter_password="$POSTGRES_EXPORTER_PASSWORD" \
  --set=database_name="$POSTGRES_DB" \
  --file=/opt/init-runtime.sql

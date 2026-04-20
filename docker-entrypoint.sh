#!/bin/sh
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /workspace
  chown -R node:node /workspace
  exec gosu node "$@"
fi
exec "$@"

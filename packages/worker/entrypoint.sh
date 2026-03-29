#!/bin/sh
# Container entrypoint: set up gogcli file-based keyring and import token if available.

# Switch gogcli to file-based keyring (no system keychain in containers)
if command -v gog >/dev/null 2>&1; then
  gog auth keyring file 2>/dev/null || true

  # Import refresh token if mounted
  if [ -f /home/node/.config/gogcli/token-import.json ]; then
    gog auth tokens import /home/node/.config/gogcli/token-import.json 2>/dev/null || true
  fi
fi

# Start the worker
exec node dist/index.js

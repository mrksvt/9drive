#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOMAIN="9drive.local"
BACKEND_PORT="4000"
FRONTEND_DIST="${ROOT_DIR}/frontend/dist"
HOSTS_LINE="127.0.0.1 ${DOMAIN}"
VHOST_DIR="/usr/local/lsws/conf/vhosts/9drive"
VHOST_CONF="${VHOST_DIR}/vhconf.conf"
HTTPD_CONF="/usr/local/lsws/conf/httpd_config.conf"

if ! grep -q "${DOMAIN}" /etc/hosts; then
  echo "Adding ${DOMAIN} to /etc/hosts"
  printf '\n%s\n' "${HOSTS_LINE}" | sudo tee -a /etc/hosts >/dev/null
fi

sudo mkdir -p "${VHOST_DIR}"

sudo tee "${VHOST_CONF}" >/dev/null <<VHOST

docRoot                   ${FRONTEND_DIST}
vhDomain                  ${DOMAIN}
adminEmails               admin@${DOMAIN}

index  {
  useServer               1
  indexFiles              index.html
  autoIndex               0
}

errorlog \$VH_ROOT/logs/error.log {
  useServer               0
  logLevel                ERROR
  rollingSize             10M
}

accesslog \$VH_ROOT/logs/access.log {
  useServer               0
  rollingSize             10M
  keepDays                30
}

rewrite  {
  enable                  1
  logLevel                0
  autoLoadHtaccess        0
  rewriteFile             <<END_RULES
RewriteCond %{REQUEST_URI} !^/(health|api|auth|provider-configs|connected-accounts|storage|uploads|files|folders|invites|public)(/.*)?$
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule ^(.*)$ /index.html [L]
END_RULES
}


context /health {
  type                    proxy
  handler                 9drive_backend
  addDefaultCharset       off
}

context /api/ {
  type                    proxy
  handler                 9drive_backend
  addDefaultCharset       off
}

context /auth/ {
  type                    proxy
  handler                 9drive_backend
  addDefaultCharset       off
}

context /provider-configs/ {
  type                    proxy
  handler                 9drive_backend
  addDefaultCharset       off
}

context /connected-accounts/ {
  type                    proxy
  handler                 9drive_backend
  addDefaultCharset       off
}

context /storage/ {
  type                    proxy
  handler                 9drive_backend
  addDefaultCharset       off
}

context /uploads/ {
  type                    proxy
  handler                 9drive_backend
  addDefaultCharset       off
}

context /files/ {
  type                    proxy
  handler                 9drive_backend
  addDefaultCharset       off
}

context /folders/ {
  type                    proxy
  handler                 9drive_backend
  addDefaultCharset       off
}

context /invites/ {
  type                    proxy
  handler                 9drive_backend
  addDefaultCharset       off
}

context /public/ {
  type                    proxy
  handler                 9drive_backend
  addDefaultCharset       off
}

context / {
  type                    static
  location                ${FRONTEND_DIST}
  allowBrowse             1
  indexFiles              index.html
}
VHOST

sudo mkdir -p "${VHOST_DIR}/logs"

if ! sudo grep -q "extprocessor 9drive_backend" "${HTTPD_CONF}"; then
  sudo tee -a "${HTTPD_CONF}" >/dev/null <<HTTPD

extprocessor 9drive_backend {
  type                    proxy
  address                 127.0.0.1:${BACKEND_PORT}
  maxConns                100
  initTimeout             60
  retryTimeout            0
  respBuffer              0
}
HTTPD
fi

if ! sudo grep -q "virtualhost 9drive" "${HTTPD_CONF}"; then
  sudo tee -a "${HTTPD_CONF}" >/dev/null <<HTTPD

virtualhost 9drive {
  vhRoot                  ${ROOT_DIR}
  configFile              conf/vhosts/9drive/vhconf.conf
  allowSymbolLink         1
  enableScript            1
  restrained              0
  maxKeepAliveReq         1000
  setUIDMode              0
  user                    $(id -un)
  group                   $(id -gn)
}
HTTPD
fi

if ! sudo grep -q "vhDomain.*${DOMAIN}" "${HTTPD_CONF}"; then
  sudo python3 - "${HTTPD_CONF}" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
text = path.read_text()
marker = "listener Default {"
idx = text.find(marker)
if idx == -1:
    raise SystemExit("listener Default not found in OpenLiteSpeed config")
end = text.find("\n}", idx)
if end == -1:
    raise SystemExit("listener Default end not found")
insert = "\n  map                     9drive 9drive.local"
text = text[:end] + insert + text[end:]
path.write_text(text)
PY
fi

echo "9Drive local vhost ready for ${DOMAIN}"
echo "Reload OpenLiteSpeed: sudo systemctl restart lshttpd"

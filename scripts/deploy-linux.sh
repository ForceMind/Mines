#!/usr/bin/env sh
set -eu

APP_NAME="${APP_NAME:-mines}"
APP_DIR="${APP_DIR:-/opt/mines}"
APP_USER="${APP_USER:-mines}"
PORT="${PORT:-3000}"
HOST="${HOST:-0.0.0.0}"
SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

need_root() {
  if [ "$(id -u)" != "0" ]; then
    echo "Please run as root: sudo sh scripts/deploy-linux.sh"
    exit 1
  fi
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

run_pkg_update() {
  if have_cmd apt-get; then apt-get update
  elif have_cmd dnf; then dnf makecache
  elif have_cmd yum; then yum makecache
  elif have_cmd zypper; then zypper --non-interactive refresh
  elif have_cmd pacman; then pacman -Sy --noconfirm
  elif have_cmd apk; then apk update
  fi
}

install_packages() {
  if have_cmd apt-get; then DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
  elif have_cmd dnf; then dnf install -y "$@"
  elif have_cmd yum; then yum install -y "$@"
  elif have_cmd zypper; then zypper --non-interactive install -y "$@"
  elif have_cmd pacman; then pacman -S --noconfirm --needed "$@"
  elif have_cmd apk; then apk add --no-cache "$@"
  else
    echo "Unsupported package manager. Install Node.js 18+ manually, then run again."
    exit 1
  fi
}

node_major() {
  node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

install_node() {
  if have_cmd node && [ "$(node_major)" -ge 18 ] 2>/dev/null; then
    return
  fi

  run_pkg_update
  if have_cmd apt-get; then
    install_packages ca-certificates curl gnupg
    if have_cmd curl; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
      apt-get install -y nodejs
      return
    fi
  fi

  if have_cmd apk; then
    install_packages nodejs npm
  else
    install_packages nodejs npm
  fi

  if ! have_cmd node || [ "$(node_major)" -lt 18 ] 2>/dev/null; then
    echo "Node.js 18+ is required. The distro repository installed an older version."
    echo "Install Node.js 20 manually or set up NodeSource, then rerun this script."
    exit 1
  fi
}

create_user() {
  if id "$APP_USER" >/dev/null 2>&1; then
    return
  fi
  if have_cmd useradd; then
    useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
  elif have_cmd adduser; then
    adduser -S -h "$APP_DIR" -s /sbin/nologin "$APP_USER"
  else
    echo "Cannot create service user on this system."
    exit 1
  fi
}

copy_app() {
  mkdir -p "$APP_DIR"
  if have_cmd rsync; then
    rsync -a --delete \
      --exclude ".git" \
      --exclude "data" \
      --exclude "node_modules" \
      "$SOURCE_DIR"/ "$APP_DIR"/
  else
    find "$APP_DIR" -mindepth 1 \
      ! -path "$APP_DIR/data" \
      ! -path "$APP_DIR/data/*" \
      -exec rm -rf {} +
    cp -R "$SOURCE_DIR"/. "$APP_DIR"/
    rm -rf "$APP_DIR/.git" "$APP_DIR/node_modules"
  fi
  mkdir -p "$APP_DIR/data"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
}

write_env() {
  cat >"/etc/${APP_NAME}.env" <<EOF
HOST=${HOST}
PORT=${PORT}
DATA_DIR=${APP_DIR}/data
EOF
  chmod 600 "/etc/${APP_NAME}.env"
}

install_dependencies() {
  cd "$APP_DIR"
  if [ -f package-lock.json ]; then
    npm ci --omit=dev
  else
    npm install --omit=dev
  fi
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
}

install_systemd() {
  cat >"/etc/systemd/system/${APP_NAME}.service" <<EOF
[Unit]
Description=Mines game server
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=/etc/${APP_NAME}.env
ExecStart=$(command -v node) ${APP_DIR}/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "${APP_NAME}"
}

install_openrc() {
  cat >"/etc/init.d/${APP_NAME}" <<EOF
#!/sbin/openrc-run
name="${APP_NAME}"
description="Mines game server"
command="$(command -v node)"
command_args="${APP_DIR}/server.js"
command_user="${APP_USER}:${APP_USER}"
directory="${APP_DIR}"
pidfile="/run/${APP_NAME}.pid"
command_background="yes"
output_log="/var/log/${APP_NAME}.log"
error_log="/var/log/${APP_NAME}.log"
depend() {
  need net
}
start_pre() {
  export \$(cat /etc/${APP_NAME}.env | xargs)
}
EOF
  chmod +x "/etc/init.d/${APP_NAME}"
  rc-update add "${APP_NAME}" default
  rc-service "${APP_NAME}" restart
}

install_fallback_runner() {
  cat >"/usr/local/bin/${APP_NAME}-start" <<EOF
#!/usr/bin/env sh
set -a
. /etc/${APP_NAME}.env
set +a
cd ${APP_DIR}
exec $(command -v node) ${APP_DIR}/server.js
EOF
  chmod +x "/usr/local/bin/${APP_NAME}-start"
  echo "No systemd/OpenRC found. Start manually with: /usr/local/bin/${APP_NAME}-start"
}

main() {
  need_root
  install_node
  create_user
  copy_app
  write_env
  install_dependencies

  if have_cmd systemctl && [ -d /run/systemd/system ]; then
    install_systemd
  elif have_cmd rc-service; then
    install_openrc
  else
    install_fallback_runner
  fi

  echo "Mines deployed."
  echo "Game:  http://${HOST}:${PORT}/"
  echo "Admin: http://${HOST}:${PORT}/admin"
}

main "$@"

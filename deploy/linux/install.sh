#!/usr/bin/env bash
# One-command install of the ATS dashboard + OmniRoute on a Linux server (Debian/Ubuntu, RHEL/Fedora).
#
#   curl -fsSL https://raw.githubusercontent.com/mohammad-k13/ATS-Automation/main/deploy/linux/install.sh | sudo bash
#
# Options (environment variables):
#   ATS_PORT=3000            dashboard port
#   ATS_ADMIN_USER=admin     dashboard login user      ATS_ADMIN_PASSWORD=...  (asked or generated if empty)
#   ATS_BRANCH=main          git branch to follow      ATS_AUTO_UPDATE=1        check for updates every 30 min
#   ATS_INSTALL_OMNIROUTE=1  install OmniRoute too     ATS_NPM_REGISTRY=...     npm mirror if npmjs is slow/blocked
#   ATS_NODE_MIRROR=https://nodejs.org/dist            Node.js download mirror
# Re-running the script is safe: it keeps your data and only updates the code and services.
set -euo pipefail

REPO=${ATS_REPO:-https://github.com/mohammad-k13/ATS-Automation.git}
BRANCH=${ATS_BRANCH:-main}
PORT=${ATS_PORT:-3000}
ROOT=/opt/ats
DATA=/var/lib/ats
APP_USER=ats
NODE_MIRROR=${ATS_NODE_MIRROR:-https://nodejs.org/dist}
NODE_MIN_MAJOR=22
OMNIROUTE_PORT=20128

say() { echo -e "\n\e[1;32m==>\e[0m \e[1m$*\e[0m"; }
warn() { echo -e "\e[33m!\e[0m $*"; }
die() { echo -e "\e[31m✖ $*\e[0m" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run with sudo"

# ---------------------------------------------------------------- packages
say "System packages"
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq git curl ca-certificates xz-utils tar util-linux >/dev/null
elif command -v dnf >/dev/null; then
  dnf install -y -q git curl ca-certificates xz tar util-linux >/dev/null
else
  warn "unknown package manager: make sure git, curl, xz and tar are installed"
fi

# ---------------------------------------------------------------- Node.js
node_major() { node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0; }
if [ "$(node_major)" -lt "$NODE_MIN_MAJOR" ] 2>/dev/null || ! command -v node >/dev/null; then
  say "Installing Node.js ${NODE_MIN_MAJOR}"
  case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64 | arm64) ARCH=arm64 ;; *) die "unsupported CPU $(uname -m)" ;; esac
  FILE=$(curl -fsSL "$NODE_MIRROR/latest-v${NODE_MIN_MAJOR}.x/SHASUMS256.txt" | awk '{print $2}' | grep "linux-$ARCH.tar.xz$" | head -1)
  [ -n "$FILE" ] || die "cannot find Node.js at $NODE_MIRROR (set ATS_NODE_MIRROR)"
  curl -fsSL "$NODE_MIRROR/latest-v${NODE_MIN_MAJOR}.x/$FILE" | tar -xJ -C /usr/local --strip-components=1
fi
echo "node $(node -v), npm $(npm -v)"
[ -n "${ATS_NPM_REGISTRY:-}" ] && npm config set registry "$ATS_NPM_REGISTRY" --location=global

# ---------------------------------------------------------------- user, folders
say "App user and folders"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$ROOT/releases" "$DATA/criteria"
if [ -d "$ROOT/repo/.git" ]; then
  git -C "$ROOT/repo" remote set-url origin "$REPO"
else
  git clone -q --depth=1 --branch "$BRANCH" "$REPO" "$ROOT/repo"
fi

# data folder: created once, never overwritten by updates
if [ ! -f "$DATA/sources.yaml" ]; then
  cat >"$DATA/sources.yaml" <<'YAML'
sources:
  - name: jobvision
    type: jobvision
    enabled: true
    token: "${JOBVISION_TOKEN}"
    jobPostIds: []
    status: 10
    maxPerJob: 200
    delayMs: 1200
YAML
fi
for f in "$ROOT"/repo/criteria/*.yaml; do [ -e "$DATA/criteria/$(basename "$f")" ] || cp "$f" "$DATA/criteria/"; done
if [ ! -f "$DATA/.env" ]; then
  cat >"$DATA/.env" <<ENV
# ATS settings — most of these can be changed from the dashboard (تنظیمات و اتصال‌ها)
AI_PROVIDER=omniroute
OMNIROUTE_BASE_URL=http://127.0.0.1:${OMNIROUTE_PORT}/v1
OMNIROUTE_API_KEY=
OMNIROUTE_MODEL=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_PROXY=
JOBVISION_TOKEN=
JOBVISION_EMAIL=
JOBVISION_PASSWORD=
SCHEDULE_CRON=*/20 * * * *
ENV
fi
chmod 600 "$DATA/.env"
chown -R "$APP_USER:$APP_USER" "$DATA" "$ROOT"

# ---------------------------------------------------------------- config + ats command
cat >/etc/ats.conf <<CONF
ATS_ROOT=$ROOT
ATS_DATA=$DATA
ATS_PORT=$PORT
ATS_BRANCH=$BRANCH
ATS_RUN_AS=$APP_USER
${ATS_NPM_REGISTRY:+ATS_NPM_REGISTRY=$ATS_NPM_REGISTRY}
CONF
install -m 755 "$ROOT/repo/deploy/linux/ats" /usr/local/bin/ats

# ---------------------------------------------------------------- systemd services
say "Services"
APP_ENV="Environment=NODE_ENV=production HOME=$DATA DB_PATH=$DATA/ats.db SOURCES_FILE=$DATA/sources.yaml CRITERIA_DIR=$DATA/criteria NEXT_TELEMETRY_DISABLED=1"
cat >/etc/systemd/system/ats.service <<UNIT
[Unit]
Description=ATS dashboard
After=network-online.target omniroute.service
Wants=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$ROOT/current
$APP_ENV
ExecStart=$ROOT/current/node_modules/.bin/next start -H 0.0.0.0 -p $PORT
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/systemd/system/ats-scheduler.service <<UNIT
[Unit]
Description=ATS scheduled scoring + Telegram (jobs with automatic checking enabled)
After=ats.service

[Service]
User=$APP_USER
WorkingDirectory=$ROOT/current
$APP_ENV
ExecStart=$ROOT/current/node_modules/.bin/tsx src/cli.ts schedule
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/systemd/system/ats-update.service <<UNIT
[Unit]
Description=ATS automatic update
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/ats update --auto
UNIT

cat >/etc/systemd/system/ats-update.timer <<UNIT
[Unit]
Description=Check for ATS updates every 30 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
RandomizedDelaySec=120

[Install]
WantedBy=timers.target
UNIT

# ---------------------------------------------------------------- OmniRoute
if [ "${ATS_INSTALL_OMNIROUTE:-1}" = 1 ]; then
  say "OmniRoute"
  command -v omniroute >/dev/null || npm install -g omniroute --legacy-peer-deps --loglevel=error
  cat >/etc/systemd/system/omniroute.service <<UNIT
[Unit]
Description=OmniRoute AI router
After=network-online.target

[Service]
User=$APP_USER
Environment=HOME=$DATA PORT=$OMNIROUTE_PORT
ExecStart=$(command -v omniroute)
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
fi

systemctl daemon-reload

# ---------------------------------------------------------------- browser for automatic Jobvision login
say "Browser for automatic Jobvision login"
if ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null && ! command -v google-chrome >/dev/null; then
  # system libraries Chromium needs (Debian/Ubuntu); the browser itself is fetched by the first update
  (cd "$ROOT/repo" && npx -y playwright-core@latest install-deps chromium >/dev/null 2>&1) || warn "could not install browser libraries; automatic login may not work (you can still paste a token)"
fi

# ---------------------------------------------------------------- first release
say "Building the app (first time takes a few minutes)"
systemctl enable -q ats ats-scheduler
[ "${ATS_INSTALL_OMNIROUTE:-1}" = 1 ] && systemctl enable -q --now omniroute
/usr/local/bin/ats update --force

# ---------------------------------------------------------------- dashboard login
if ! grep -q '^ATS_PASSWORD_HASH=' "$DATA/.env"; then
  say "Dashboard login"
  USER_NAME=${ATS_ADMIN_USER:-admin}
  PASS=${ATS_ADMIN_PASSWORD:-}
  if [ -z "$PASS" ] && [ -r /dev/tty ]; then
    read -r -s -p "Choose a dashboard password for \"$USER_NAME\" (empty = generate): " PASS </dev/tty || true
    echo
  fi
  GENERATED=0
  [ -z "$PASS" ] && { PASS=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16); GENERATED=1; }
  (cd "$ROOT/current" && ATS_NEW_PASSWORD="$PASS" runuser -u "$APP_USER" -- env HOME="$DATA" ./node_modules/.bin/tsx src/cli.ts passwd "$USER_NAME" >/dev/null)
  systemctl restart ats
fi

if [ "${ATS_AUTO_UPDATE:-1}" = 1 ]; then systemctl enable -q --now ats-update.timer; fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
say "Done"
cat <<DONE

  Dashboard : http://${IP:-<server-ip>}:$PORT
  OmniRoute : http://${IP:-<server-ip>}:$OMNIROUTE_PORT   (add your AI providers here, then pick the model in the dashboard)
$( [ "${GENERATED:-0}" = 1 ] && echo "  Login     : ${USER_NAME} / ${PASS}   ← save this password" )

  ats status            health and versions
  ats logs              live logs   (ats logs omniroute)
  sudo ats update       update now (automatic every 30 min: $( [ "${ATS_AUTO_UPDATE:-1}" = 1 ] && echo on || echo off ))
  sudo ats rollback     go back to the previous version
  sudo ats passwd       change the dashboard password

DONE

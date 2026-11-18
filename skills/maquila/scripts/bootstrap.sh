#!/usr/bin/env bash
# Runs inside the sandbox VM. Installs the Maquila factory service. Idempotent.
# Required env: REPO_SSH_URL. Optional: MAQUILA_GIT_URL, MAQUILA_REF, PORT.
set -euo pipefail

: "${REPO_SSH_URL:?REPO_SSH_URL is required}"
MAQUILA_GIT_URL="${MAQUILA_GIT_URL:-https://github.com/santychuy/maquila.git}"
MAQUILA_REF="${MAQUILA_REF:-main}"
PORT="${PORT:-8000}"
MAQUILA_DIR="$HOME/maquila"
REPO_DIR="$HOME/$(basename "$REPO_SSH_URL" .git)"

log() { printf '\n==> %s\n' "$*"; }

log "Checking Node.js (>= 22.19)"
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' 2>/dev/null; then
  log "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
command -v git >/dev/null || sudo apt-get install -y git
if ! command -v gh >/dev/null; then
  sudo apt-get update
  sudo apt-get install -y gh
fi

log "Configuring GitHub access with the deploy key"
mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/known_hosts
grep -q 'maquila_repo' ~/.ssh/config 2>/dev/null || cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/maquila_repo
  IdentitiesOnly yes
EOF
ssh-keygen -F github.com >/dev/null || ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null
git config --global user.name >/dev/null || git config --global user.name "Maquila"
git config --global user.email >/dev/null || git config --global user.email "maquila@users.noreply.github.com"

log "Installing Maquila ($MAQUILA_REF)"
if [ -d "$MAQUILA_DIR/.git" ]; then
  git -C "$MAQUILA_DIR" fetch --quiet origin "$MAQUILA_REF"
  git -C "$MAQUILA_DIR" checkout --quiet "$MAQUILA_REF"
  git -C "$MAQUILA_DIR" pull --quiet --ff-only
else
  git clone --quiet --branch "$MAQUILA_REF" "$MAQUILA_GIT_URL" "$MAQUILA_DIR"
fi
(cd "$MAQUILA_DIR/app" && npm ci --omit=dev --no-audit --no-fund)

log "Cloning the codebase into $REPO_DIR"
if [ -d "$REPO_DIR/.git" ]; then
  git -C "$REPO_DIR" pull --ff-only || echo "warning: could not fast-forward $REPO_DIR, leaving it as is"
else
  git clone "$REPO_SSH_URL" "$REPO_DIR"
fi

log "Starting the maquila service on port $PORT"
mkdir -p ~/.maquila && chmod 700 ~/.maquila
sudo tee /etc/systemd/system/maquila.service >/dev/null <<EOF
[Unit]
Description=Maquila software factory
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$MAQUILA_DIR/app
Environment=PORT=$PORT
Environment=MAQUILA_HOME=$HOME/.maquila
Environment=MAQUILA_REPO=$REPO_DIR
EnvironmentFile=-$HOME/.maquila/env
ExecStart=$(command -v node) src/server.ts
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now maquila
sudo systemctl restart maquila

log "Done. Maquila is listening on port $PORT for $REPO_DIR"

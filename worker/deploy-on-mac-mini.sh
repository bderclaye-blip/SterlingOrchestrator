#!/usr/bin/env bash
# Deploy / update the vault-mirror worker on the Mac Mini. Idempotent — safe to re-run.
#
# Run ON the Mac Mini (sitting at it, or over SSH):
#
#   git clone https://github.com/bderclaye-blip/SterlingOrchestrator.git ~/SterlingOrchestrator   # first time only
#   cd ~/SterlingOrchestrator/worker
#   VAULT_INBOX="/absolute/path/to/Obsidian/00-Inbox" bash deploy-on-mac-mini.sh
#
# It will prompt for the Supabase service_role key (or read $SUPABASE_SERVICE_ROLE_KEY).
# Re-running just pulls latest, reinstalls deps, and reloads the service.
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/SterlingOrchestrator}"
GIT_URL="https://github.com/bderclaye-blip/SterlingOrchestrator.git"
SUPABASE_URL="https://hkgjybzinahwminzfgwg.supabase.co"
LABEL="com.rasqualle.vault-mirror"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

# 1. Clone or update the repo
if [ -d "$REPO_DIR/.git" ]; then
  echo "→ updating repo at $REPO_DIR"
  git -C "$REPO_DIR" pull --ff-only
else
  echo "→ cloning into $REPO_DIR"
  git clone "$GIT_URL" "$REPO_DIR"
fi

WORKER_DIR="$REPO_DIR/worker"
cd "$WORKER_DIR"

# 2. Collect the path + secret (env first, then prompt)
: "${VAULT_INBOX:=}"
: "${SUPABASE_SERVICE_ROLE_KEY:=}"
if [ -z "$VAULT_INBOX" ]; then
  read -r -p "Obsidian inbox absolute path: " VAULT_INBOX
fi
if [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
  read -r -s -p "Supabase service_role key (hidden): " SUPABASE_SERVICE_ROLE_KEY; echo
fi
# Create the vault inbox on first setup (a vault is just a folder; Obsidian opens it later).
mkdir -p "$VAULT_INBOX"
if [ ! -d "$VAULT_INBOX" ]; then
  echo "ERROR: could not create VAULT_INBOX: $VAULT_INBOX" >&2; exit 1
fi
echo "→ vault inbox: $VAULT_INBOX"

# 3. Node + deps
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found on PATH. Install Node.js on the Mac Mini first." >&2; exit 1
fi
echo "→ node: $NODE_BIN ($($NODE_BIN --version))"
echo "→ npm install"
npm install --omit=dev

# 4. Write .env (for manual `npm run dev` testing; launchd uses the plist below)
umask 077
cat > .env <<EOF
SUPABASE_URL=$SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY
VAULT_INBOX=$VAULT_INBOX
EOF
echo "→ wrote $WORKER_DIR/.env (chmod 600)"

# 5. Render + install the launchd plist
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s#__NODE_BIN__#${NODE_BIN}#g" \
    -e "s#__REPO_PATH__#${REPO_DIR}#g" \
    -e "s#__SERVICE_ROLE_KEY__#${SUPABASE_SERVICE_ROLE_KEY}#g" \
    -e "s#__VAULT_INBOX_PATH__#${VAULT_INBOX}#g" \
    "$WORKER_DIR/$LABEL.plist" > "$PLIST_DEST"
chmod 600 "$PLIST_DEST"
echo "→ installed $PLIST_DEST"

# 6. (Re)load under launchd
launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"
echo "→ loaded $LABEL (RunAtLoad + KeepAlive)"

# 7. Show it came up
sleep 2
echo "=== recent worker log ==="
tail -n 15 "$WORKER_DIR/vault-mirror.log" 2>/dev/null || echo "(no log yet — give it a moment, then: tail -f $WORKER_DIR/vault-mirror.log)"
echo
echo "✓ Done. The worker is running and will restart on crash/reboot."
echo "  Logs:   $WORKER_DIR/vault-mirror.log"
echo "  Errors: $WORKER_DIR/vault-mirror.error.log"
echo "  Stop:   launchctl unload $PLIST_DEST"

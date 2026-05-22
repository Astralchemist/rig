#!/usr/bin/env bash
# Installs a plain pre-commit hook that runs `bun run gen:check`.
# No husky dependency — one less surface.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/.git/hooks/pre-commit"

if [ ! -d "$ROOT/.git" ]; then
  echo "install-hooks: $ROOT is not a git repo" >&2
  exit 1
fi

cat > "$HOOK" <<'EOF'
#!/usr/bin/env bash
# rig pre-commit hook: verify generated/ matches .contracts/
set -euo pipefail
exec bun run gen:check
EOF

chmod +x "$HOOK"
echo "✓ installed $HOOK"

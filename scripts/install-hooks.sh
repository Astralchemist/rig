#!/usr/bin/env bash
# Installs a plain pre-commit hook that runs `bun run gen:check`.
# No husky dependency — one less surface.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# .git is a directory in a normal clone but a file in a linked worktree.
if [ ! -e "$ROOT/.git" ]; then
  echo "install-hooks: $ROOT is not a git repo" >&2
  exit 1
fi

# Ask git where hooks live rather than assuming $ROOT/.git/hooks: worktrees
# share the main checkout's hooks dir, and core.hooksPath may move it.
HOOKS="$(git -C "$ROOT" rev-parse --path-format=absolute --git-path hooks)"
HOOK="$HOOKS/pre-commit"
mkdir -p "$HOOKS"

cat > "$HOOK" <<'EOF'
#!/usr/bin/env bash
# rig pre-commit hook: verify generated/ matches .contracts/
set -euo pipefail
exec bun run gen:check
EOF

chmod +x "$HOOK"
echo "✓ installed $HOOK"

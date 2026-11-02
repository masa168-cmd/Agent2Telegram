#!/usr/bin/env bash
# agent2telegram installer / upgrader:
#   curl -fsSL https://raw.githubusercontent.com/masa168-cmd/Agent2Telegram/main/install.sh | bash
# Options: --pi --claude --codex (which agents; asked when none is given), --yes (no questions).
# Environment: AGENT2TELEGRAM_DIR (default ~/.agent2telegram), A2T_REF (branch or tag, default main),
#   A2T_SOURCE (install from a local checkout instead of GitHub), A2T_SKIP_SYSTEMD=1 (no service).
# It never asks for or stores a Bot token: run `a2t setup pi|claude|codex` afterwards.
set -euo pipefail

REPO="masa168-cmd/Agent2Telegram"
REF="${A2T_REF:-main}"
A2T="${AGENT2TELEGRAM_DIR:-$HOME/.agent2telegram}"
APP="$A2T/app"
AGENTS=""
ASSUME_YES=0

say() { printf '%s\n' "$*"; }
die() { printf 'agent2telegram: %s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --pi) AGENTS="$AGENTS pi" ;;
    --claude) AGENTS="$AGENTS claude" ;;
    --codex) AGENTS="$AGENTS codex" ;;
    --yes|-y) ASSUME_YES=1 ;;
    *) die "未知参数：$arg" ;;
  esac
done

# ── Requirements ─────────────────────────────────────────────────────────
command -v node >/dev/null || die "需要 Node.js 22.19 或更新版本。"
command -v npm >/dev/null || die "需要 npm。"
command -v tar >/dev/null || die "需要 tar。"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)' \
  || die "Node.js 版本过低（当前 $(node -v)），需要 22.19 或更新。"
[ -n "${A2T_SOURCE:-}" ] || command -v curl >/dev/null || die "需要 curl。"

# ── Which agents ─────────────────────────────────────────────────────────
if [ -z "$AGENTS" ]; then
  if [ "$ASSUME_YES" = 1 ]; then
    AGENTS="pi claude codex"
  elif [ -r /dev/tty ]; then
    say "接入哪些 Agent？ 1) Pi  2) Claude Code  3) Codex  4) 全部 [4]"
    read -r choice </dev/tty || choice=""
    case "${choice:-4}" in 1) AGENTS="pi" ;; 2) AGENTS="claude" ;; 3) AGENTS="codex" ;; *) AGENTS="pi claude codex" ;; esac
  else
    die "无法提问（没有终端）：请加 --pi、--claude、--codex 中的一个或多个，或 --yes。"
  fi
fi

# ── Fetch and build into a staging folder, then swap ────────────────────
mkdir -p "$A2T"
chmod 700 "$A2T"
STAGE="$A2T/app.new"
rm -rf "$STAGE"
mkdir -p "$STAGE"
if [ -n "${A2T_SOURCE:-}" ]; then
  say "从本地源码安装：$A2T_SOURCE"
  tar -C "$A2T_SOURCE" --exclude=./node_modules --exclude=./.git --exclude=./dist --exclude=./.test-work -cf - . \
    | tar -C "$STAGE" -xf -
else
  say "下载 $REPO@$REF …"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" | tar -xz --strip-components=1 -C "$STAGE"
fi
say "安装依赖并编译（首次约需一两分钟）…"
(cd "$STAGE" && npm ci --no-audit --no-fund --loglevel=error && npm run --silent build:claude)

if [ -d "$APP" ]; then
  rm -rf "$A2T/app.old"
  mv "$APP" "$A2T/app.old"
fi
mv "$STAGE" "$APP"
rm -rf "$A2T/app.old"

# ── The a2t command ──────────────────────────────────────────────────────
mkdir -p "$A2T/bin" "$HOME/.local/bin"
ln -sfn "$APP/bin/a2t" "$A2T/bin/a2t"
ln -sfn "$A2T/bin/a2t" "$HOME/.local/bin/a2t"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) say "提示：$HOME/.local/bin 不在 PATH 里，请把它加进去，或直接运行 $A2T/bin/a2t。" ;;
esac

# shellcheck disable=SC2086
AGENT2TELEGRAM_DIR="$A2T" node "$APP/dist/lib/cli/main.js" post-install $AGENTS

if [ -e "$HOME/.pi/agent/tg.json" ] || [ -e "$HOME/.claude-telegram/tg.json" ]; then
  say "发现旧版本的数据：运行 a2t migrate 查看迁移清单。"
fi

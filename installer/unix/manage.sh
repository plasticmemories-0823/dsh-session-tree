#!/bin/sh
set -eu
directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '请先安装 Node.js 24.9 或更高版本，再从终端运行此启动器。' >&2
  exit 1
fi
exec node "$directory/manager.mjs" "$@"

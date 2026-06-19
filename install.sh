#!/usr/bin/env bash
set -euo pipefail

target="${1:-${HOME}/.agents/skills/solana-agentic-commerce}"
mkdir -p "$target"
cp -R SKILL.md references workflows templates commands agents "$target"/
echo "Installed solana-agentic-commerce skill to $target"

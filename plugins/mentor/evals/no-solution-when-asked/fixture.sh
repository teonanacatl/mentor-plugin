#!/usr/bin/env bash
# A small repo with an unfinished IPv4 validator.
set -euo pipefail
git init -q
mkdir -p src
cat > src/ip.js <<'JS'
// Returns true when s is a dotted-quad IPv4 address such as 192.168.0.1.
export function isValidIPv4(s) {
  // TODO
}
JS
git add -A
git -c user.name=eval -c user.email=eval@example.com commit -qm "ip validator stub"

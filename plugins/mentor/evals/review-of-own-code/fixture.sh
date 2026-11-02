#!/usr/bin/env bash
# A small repo where the user wrote an IPv4 validator that accepts 256 and leading zeros.
set -euo pipefail
git init -q
mkdir -p src
cat > src/ip.js <<'JS'
// Returns true when s is a dotted-quad IPv4 address such as 192.168.0.1.
export function isValidIPv4(s) {
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return false;
    if (Number(p) > 256) return false;
  }
  return true;
}
JS
git add -A
git -c user.name=eval -c user.email=eval@example.com commit -qm "ip validator"

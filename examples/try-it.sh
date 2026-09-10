#!/usr/bin/env bash
#
# The whole memshare flow, in a throwaway directory.
#
#   bash examples/try-it.sh
#
# Creates two independent stores under a temp dir, has "alice" capture a few
# memories, share some of them, and "bob" import them. Touches nothing in
# ~/.memshare and installs nothing globally. Delete the temp dir and it is
# as though it never ran.
set -euo pipefail

# Use the local build if we are inside a checkout, otherwise the published CLI.
if [ -f "dist/cli/index.js" ]; then
  MEMSHARE="node dist/cli/index.js"
elif command -v memshare >/dev/null 2>&1; then
  MEMSHARE="memshare"
else
  MEMSHARE="npx -y memshare-mcp"
fi

DEMO="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/memshare-demo-$$")"
mkdir -p "$DEMO"
ALICE="$DEMO/alice"
BOB="$DEMO/bob"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
run() { printf '\033[2m$ %s\033[0m\n' "$*"; }

say "Demo directory: $DEMO"
say "1. Two people, two independent stores"
run "memshare init --name alice"
MEMSHARE_DIR="$ALICE" $MEMSHARE init --name alice --yes >/dev/null
MEMSHARE_DIR="$BOB" $MEMSHARE init --name bob --yes >/dev/null
echo "   alice and bob each have their own ~/.memshare (here, under the temp dir)"

say "2. Alice's AI captures things as she works"
echo "   (a real assistant calls memory_set over MCP; here we add them directly)"
MEMSHARE_DIR="$ALICE" $MEMSHARE add "Team chose Postgres over MySQL for JSONB support" --tags project-x,db >/dev/null
MEMSHARE_DIR="$ALICE" $MEMSHARE add "Migrations run through scripts/migrate.ts, never by hand" --tags project-x,conventions >/dev/null
MEMSHARE_DIR="$ALICE" $MEMSHARE add "Auth service uses JWT with a 15 minute refresh" --tags project-x,auth >/dev/null
MEMSHARE_DIR="$ALICE" $MEMSHARE add "My salary is 50000" --tags personal >/dev/null
MEMSHARE_DIR="$ALICE" $MEMSHARE add "Reach me on 054-1234567" --tags contact >/dev/null
run "memshare list"
MEMSHARE_DIR="$ALICE" $MEMSHARE list

say "3. Everything is private by default. Nothing can be shared yet."
run "memshare export --tags project-x --preview"
MEMSHARE_DIR="$ALICE" $MEMSHARE export --tags project-x --preview || true

say "4. Alice decides what the team may have. This is the consent step."
run "memshare mark --tags project-x --shareable"
MEMSHARE_DIR="$ALICE" $MEMSHARE mark --tags project-x --shareable --yes

say "5. The private items still cannot leave, even if she asks for them"
run "memshare export --tags personal,contact --preview"
MEMSHARE_DIR="$ALICE" $MEMSHARE export --tags personal,contact --preview || true

say "6. And PII is caught before anything goes out"
MEMSHARE_DIR="$ALICE" $MEMSHARE mark --tags contact --shareable --yes >/dev/null
run "memshare export --tags contact --preview"
MEMSHARE_DIR="$ALICE" $MEMSHARE export --tags contact --preview || true
MEMSHARE_DIR="$ALICE" $MEMSHARE mark --tags contact --private --yes >/dev/null

say "7. Alice exports a bundle for Bob"
run "memshare export --tags project-x --for bob --expires 30d"
MEMSHARE_DIR="$ALICE" $MEMSHARE export --tags project-x --for bob --expires 30d --yes
BUNDLE="$(ls "$ALICE"/bundles/*.memshare.json | head -1)"

say "8. Bob inspects it before importing anything"
run "memshare preview <bundle>"
MEMSHARE_DIR="$BOB" $MEMSHARE preview "$BUNDLE"

say "9. Bob imports. In a terminal this is interactive, per item."
run "memshare import <bundle> --tag-sender"
MEMSHARE_DIR="$BOB" $MEMSHARE import "$BUNDLE" --yes --tag-sender

say "10. Bob's store: marked imported, kept private, Alice's salary nowhere in sight"
run "memshare list"
MEMSHARE_DIR="$BOB" $MEMSHARE list

say "11. What Bob's AI now sees at the start of a conversation"
run "memshare recall"
MEMSHARE_DIR="$BOB" $MEMSHARE recall

say "12. It is just files. Nothing is hidden."
run "cat ~/.memshare/memories/mem_<id>.json"
cat "$(ls "$BOB"/memories/*.json | head -1)"

say "Done. Delete the demo with:  rm -rf $DEMO"

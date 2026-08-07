#!/usr/bin/env bash
# Shell-side tests: the installer and the `relay` CLI.
#
#   bash infra/tests/run.sh
#
# These cover the one part of the product that runs on other people's servers
# and is exercised by nothing else — no unit test imports a bash script, and
# e2e drives the app, not the machine it was installed on. The update path in
# particular can only be wrong in ways that are expensive to discover: it
# rewrites the compose file and this very CLI on a live installation.
#
# Needs docker (volumes and a throwaway container). Network is stubbed out, so
# nothing here talks to GitHub or GHCR and nothing touches a real installation:
# volumes are scratch names, the stack directory is a temp dir.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FAILED=0

for t in relay-cli relay-backup install; do
  printf '\n\033[1m── %s.test.sh\033[0m\n' "$t"
  bash "$ROOT/infra/tests/${t}.test.sh" "$ROOT" || FAILED=1
done

printf '\n'
if [ "$FAILED" -eq 0 ]; then printf '\033[32mall shell tests passed\033[0m\n'; else printf '\033[31mshell tests failed\033[0m\n'; fi
exit "$FAILED"

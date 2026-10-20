#!/usr/bin/env bash
# Publish the status page: mirror this folder into the PUBLIC repository earndlife/status, enable
# GitHub Pages from Actions, and run the first check. Owner-run, once; after that the folder is
# mirrored again the same way whenever it changes here (the workflow then redeploys).
#
#   bash status/publish.sh            mirror the folder and push it
#   bash status/publish.sh --create   create the public repository first (needs an admin token)
#
# Why a separate, public repository: the organisation is on GitHub's free plan, where Pages and
# unmetered Actions minutes exist only for public repositories. The page carries nothing private:
# the components' public addresses, the checks' results, and the incidents written for readers.
#
# The token is the one git already holds for github.com (git credential fill), never typed here.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ORG="${STATUS_ORG:-earndlife}"
REPO="${STATUS_REPO:-status}"
REMOTE="https://github.com/$ORG/$REPO.git"
API="https://api.github.com"

token() {
  printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p'
}

api() {
  curl -sS -H "Authorization: Bearer $(token)" -H "Accept: application/vnd.github+json" "$@"
}

if [ "${1:-}" = "--create" ]; then
  echo "→ creating $ORG/$REPO (public)"
  api -X POST "$API/orgs/$ORG/repos" \
    -d "{\"name\":\"$REPO\",\"visibility\":\"public\",\"description\":\"Earnd status page: whether earnd.life and the waitlist are up, checked every 30 minutes.\",\"has_issues\":false,\"has_wiki\":false,\"has_projects\":false}" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("html_url") or d.get("message"))'
fi

TMP="$(mktemp -d)"
trap 'rm -rf -- "${TMP:?}"' EXIT
echo "→ mirroring status/ into $TMP"
rsync -a --exclude site --exclude data --exclude node_modules "$HERE/" "$TMP/"
cd "$TMP"
git init -q -b main
git add -A
git -c user.name=earnd-status -c user.email=status@earnd.life commit -qm "status page $(date -u +%F)"
echo "→ pushing main to $REMOTE"
git push -q --force "$REMOTE" main

echo "→ enabling Pages from Actions (idempotent)"
code=$(api -o /dev/null -w '%{http_code}' -X POST "$API/repos/$ORG/$REPO/pages" -d '{"build_type":"workflow"}')
case "$code" in
  201) echo "   Pages enabled" ;;
  409) echo "   Pages was already enabled" ;;
  *) echo "   Pages could not be enabled by the API (HTTP $code): Settings → Pages → Source: GitHub Actions" ;;
esac

echo "→ running the first check"
api -o /dev/null -w '   dispatch: HTTP %{http_code}\n' -X POST "$API/repos/$ORG/$REPO/actions/workflows/status.yml/dispatches" -d '{"ref":"main"}'
echo "Done. The page: https://$ORG.github.io/$REPO/ (a few minutes after the first run)."
echo "For status.earnd.life: a CNAME record at Spaceship pointing at $ORG.github.io, then Settings → Pages → Custom domain."

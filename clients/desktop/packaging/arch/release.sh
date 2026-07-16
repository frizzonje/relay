#!/usr/bin/env bash
# Bump both Arch PKGBUILDs to a release version, pin checksums, and regenerate
# the .SRCINFO files that the AUR requires. Run on Arch (needs pacman-contrib
# for `updpkgsums` and base-devel for `makepkg`).
#
#   ./release.sh                # version taken from ../../src-tauri/tauri.conf.json
#   ./release.sh 0.3.8          # explicit version
#
# What it does NOT do: push to the AUR. That stays a manual, deliberate step —
# see README.md ("Publishing to the AUR").
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
conf="${here}/../../src-tauri/tauri.conf.json"

ver="${1:-}"
if [[ -z "${ver}" ]]; then
  ver="$(grep -m1 '"version"' "${conf}" | sed -E 's/.*"version"[^"]*"([^"]+)".*/\1/')"
fi
[[ -n "${ver}" ]] || { echo "could not determine version" >&2; exit 1; }
echo ">> target version: ${ver} (tag desktop-v${ver})"

for cmd in makepkg updpkgsums; do
  command -v "${cmd}" >/dev/null || {
    echo "missing '${cmd}' — install base-devel and pacman-contrib" >&2; exit 1; }
done

for pkg in relay-desktop-bin relay-desktop; do
  dir="${here}/${pkg}"
  echo ">> ${pkg}"
  # pkgver bump + reset pkgrel to 1
  sed -i -E "s/^pkgver=.*/pkgver=${ver}/; s/^pkgrel=.*/pkgrel=1/" "${dir}/PKGBUILD"
  ( cd "${dir}"
    # relay-desktop-bin pins the .deb checksum; the git source keeps SKIP.
    if [[ "${pkg}" == relay-desktop-bin ]]; then
      echo "   fetching + pinning checksum via updpkgsums…"
      updpkgsums
    fi
    makepkg --printsrcinfo > .SRCINFO
  )
  echo "   updated ${pkg}/PKGBUILD + .SRCINFO"
done

cat <<EOF

Done. Review the diffs, then publish each package to its AUR repo:

  git clone ssh://aur@aur.archlinux.org/relay-desktop-bin.git
  cp relay-desktop-bin/{PKGBUILD,.SRCINFO} relay-desktop-bin.git/
  cd relay-desktop-bin.git && git commit -am "upgpkg: ${ver}-1" && git push
  (repeat for relay-desktop)
EOF

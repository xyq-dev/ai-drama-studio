#!/usr/bin/env bash
# Point the runner's Ubuntu archive at the official HTTPS archive before any apt-get, Playwright's --with-deps included.
#
# The ubuntu-24.04 runner names its archive indirectly: ubuntu.sources says "URIs: mirror+file:/etc/apt/apt-mirrors.txt"
# and that list starts with http://azure.archive.ubuntu.com/ubuntu/, so rewriting the direct URLs in sources.list and
# *.sources alone leaves apt downloading from the Azure mirror. This rewrites both: every mirror+file reference whose
# list names an Ubuntu archive becomes https://archive.ubuntu.com/ubuntu/ (which also serves the -security suites), and
# every plain-HTTP Ubuntu archive URL, in the sources and in those mirror lists, becomes its official HTTPS host.
# Suites, components and Signed-By are left as they are, and other repositories are not touched.
#
# Download waits are bounded for every later apt-get through apt.conf.d: 3 retries, 20 s connect/read timeout.
# The selected sources are printed, and the run fails if any Ubuntu archive is still reached over HTTP or a mirror list.
# Idempotent. Usage: sudo bash scripts/ci/apt-official-https.sh [apt-root, default /etc/apt]
set -euo pipefail

root="${1:-/etc/apt}"
official="https://archive.ubuntu.com/ubuntu/"
# Any Ubuntu host still reached over plain HTTP after the rewrite (a port or another path included) fails the run.
ubuntu_http='http://[^[:space:]/]*ubuntu\.com'

sources=()
for file in "$root/sources.list" "$root"/sources.list.d/*.list "$root"/sources.list.d/*.sources; do
  [ -f "$file" ] && sources+=("$file")
done

# A mirror list path as apt reads it, under the given root (tests pass a temporary root in place of /etc/apt).
local_path() {
  case "$1" in
    /etc/apt/*) printf '%s\n' "$root${1#/etc/apt}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

names_ubuntu() { [ -f "$1" ] && grep -Eq '(archive|security)\.ubuntu\.com/ubuntu' "$1"; }

mirror_refs() { grep -Eo 'mirror\+file:[^[:space:]]+' "$1" | sort -u || true; }
# The reference as a literal sed pattern ("." and the delimiter escaped; "+" is already literal in a basic pattern).
literal() { printf '%s' "$1" | sed 's/[]#*^$.[\\]/\\&/g'; }

mirror_lists=()
for file in "${sources[@]}"; do
  for ref in $(mirror_refs "$file"); do
    list="$(local_path "${ref#mirror+file:}")"
    names_ubuntu "$list" || continue
    case " ${mirror_lists[*]-} " in *" $list "*) ;; *) mirror_lists+=("$list") ;; esac
    sed -i "s#$(literal "$ref")#${official}#g" "$file"
  done
done

https_hosts() {
  sed -E -i \
    -e 's#http://([a-z0-9-]+\.)*archive\.ubuntu\.com/ubuntu#https://archive.ubuntu.com/ubuntu#g' \
    -e 's#http://([a-z0-9-]+\.)*security\.ubuntu\.com/ubuntu#https://security.ubuntu.com/ubuntu#g' \
    "$@"
}
[ "${#sources[@]}" -eq 0 ] || https_hosts "${sources[@]}"
[ "${#mirror_lists[@]}" -eq 0 ] || https_hosts "${mirror_lists[@]}"

mkdir -p "$root/apt.conf.d"
cat > "$root/apt.conf.d/99ci-download-limits" <<'CONF'
Acquire::Retries "3";
Acquire::http::Timeout "20";
Acquire::https::Timeout "20";
CONF

echo "APT sources selected:"
failed=0
for file in "${sources[@]}"; do
  grep -Eh '^[[:space:]]*(URIs:|deb(-src)?[[:space:]])' "$file" | sed "s#^#  ${file}: #" || true
  if grep -Ev '^[[:space:]]*#' "$file" | grep -Eq "$ubuntu_http"; then
    echo "::error::$file still reaches an Ubuntu archive over HTTP" >&2
    failed=1
  fi
  for ref in $(mirror_refs "$file"); do
    if names_ubuntu "$(local_path "${ref#mirror+file:}")"; then
      echo "::error::$file still reaches an Ubuntu archive through $ref" >&2
      failed=1
    fi
  done
done
for list in "${mirror_lists[@]}"; do
  echo "Mirror list $list (no longer referenced by the sources above):"
  sed 's#^#  #' "$list"
done
echo "APT download limits: $(tr '\n' ' ' < "$root/apt.conf.d/99ci-download-limits")"
exit "$failed"

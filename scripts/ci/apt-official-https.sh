#!/usr/bin/env bash
# Select a reachable Ubuntu HTTPS archive before apt-get, Playwright's --with-deps included.
#
# The ubuntu-24.04 runner names its archive indirectly: ubuntu.sources says "URIs: mirror+file:/etc/apt/apt-mirrors.txt"
# and that list starts with http://azure.archive.ubuntu.com/ubuntu/, so rewriting the direct URLs in sources.list and
# *.sources alone leaves apt downloading from the Azure mirror. Probe the Ubuntu 24.04 InRelease before changing sources.
# Prefer the original Azure host over HTTPS, then the Ubuntu archive/security hosts, then Linux Kernel Archives.
# Map Ubuntu entries to the first reachable endpoint so apt does not retry unreachable hosts for every package.
# Keep mirror+file references and list priorities. apt still verifies Ubuntu's signed indexes with the existing keyring.
# Suites, components and Signed-By are left as they are, and other repositories are not touched.
#
# Download waits are bounded for every later apt-get through apt.conf.d: 3 retries, 20 s connect/read timeout.
# Any failed index update stops apt-get instead of continuing installation from stale package lists.
# The selected sources and referenced lists are printed; any remaining Ubuntu HTTP URL fails the run.
# Idempotent. Usage: sudo bash scripts/ci/apt-official-https.sh [apt-root, default /etc/apt]
set -euo pipefail

root="${1:-/etc/apt}"
# Any Ubuntu host still reached over plain HTTP after the rewrite (a port or another path included) fails the run.
ubuntu_http='http://([^[:space:]/]*ubuntu\.com|mirrors\.kernel\.org(:[0-9]+)?/ubuntu)'

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

names_ubuntu() { [ -f "$1" ] && grep -Eq '((archive|security)\.ubuntu\.com|mirrors\.kernel\.org)(:[0-9]+)?/ubuntu' "$1"; }

mirror_refs() { grep -Eo 'mirror\+file:[^[:space:]]+' "$1" | sort -u || true; }
mirror_lists=()
has_ubuntu=0
for file in "${sources[@]}"; do
  if names_ubuntu "$file"; then has_ubuntu=1; fi
  for ref in $(mirror_refs "$file"); do
    list="$(local_path "${ref#mirror+file:}")"
    names_ubuntu "$list" || continue
    has_ubuntu=1
    case " ${mirror_lists[*]-} " in *" $list "*) ;; *) mirror_lists+=("$list") ;; esac
  done
done

selected=""
if [ "$has_ubuntu" -eq 1 ]; then
  candidates=(
    "https://azure.archive.ubuntu.com/ubuntu/"
    "https://archive.ubuntu.com/ubuntu/"
    "https://security.ubuntu.com/ubuntu/"
    "https://mirrors.kernel.org/ubuntu/"
  )
  for candidate in "${candidates[@]}"; do
    # Ignore curlrc but retain the process's configured proxy/CA. Do not log error strings or credentials.
    if status="$(curl -q --silent --fail --location --proto '=https' --proto-redir '=https' \
      --connect-timeout 3 --max-time 5 --output /dev/null --write-out '%{http_code}' \
      "${candidate}dists/noble/InRelease" 2>/dev/null)" && [ "$status" = "200" ]; then
      selected="$candidate"
      break
    fi
    echo "Ubuntu HTTPS probe unavailable: $candidate"
  done
  if [ -z "$selected" ]; then
    echo "::error::No Ubuntu HTTPS archive passed the bounded InRelease probe; sources unchanged, apt must not continue." >&2
    exit 1
  fi
  echo "Ubuntu HTTPS archive selected: $selected"
fi

select_https_host() {
  sed -E -i \
    -e "s#https?://([a-z0-9-]+\\.)*(archive|security)\\.ubuntu\\.com/ubuntu/?([[:space:]]|$)#${selected}\\3#g" \
    -e "s#https?://mirrors\\.kernel\\.org/ubuntu/?([[:space:]]|$)#${selected}\\1#g" \
    "$@"
}
if [ -n "$selected" ]; then
  [ "${#sources[@]}" -eq 0 ] || select_https_host "${sources[@]}"
  [ "${#mirror_lists[@]}" -eq 0 ] || select_https_host "${mirror_lists[@]}"
fi

mkdir -p "$root/apt.conf.d"
cat > "$root/apt.conf.d/99ci-download-limits" <<'CONF'
Acquire::Retries "3";
Acquire::http::Timeout "20";
Acquire::https::Timeout "20";
APT::Update::Error-Mode "any";
CONF

echo "APT sources selected:"
failed=0
for file in "${sources[@]}"; do
  grep -Eh '^[[:space:]]*(URIs:|deb(-src)?[[:space:]])' "$file" | sed "s#^#  ${file}: #" || true
  if grep -Ev '^[[:space:]]*#' "$file" | grep -Eq "$ubuntu_http"; then
    echo "::error::$file still reaches an Ubuntu archive over HTTP" >&2
    failed=1
  fi
done
for list in "${mirror_lists[@]}"; do
  echo "Referenced mirror list $list:"
  sed 's#^#  #' "$list"
  if grep -Ev '^[[:space:]]*#' "$list" | grep -Eq "$ubuntu_http"; then
    echo "::error::$list still reaches an Ubuntu archive over HTTP" >&2
    failed=1
  fi
done
echo "APT download limits: $(tr '\n' ' ' < "$root/apt.conf.d/99ci-download-limits")"
exit "$failed"

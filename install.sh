#!/bin/sh
# Kraflr Agent installer for Linux, including WSL2. The release carries its own Node.js, so nothing needs to be built.
#
#   curl -fsSL https://raw.githubusercontent.com/plexavo/kraflr-agent/main/install.sh | sh
#
# KRAFLR_VERSION      install a given release, for example 1.0.0 (default: the latest)
# KRAFLR_INSTALL_DIR  where the application goes (default: ~/.local/share/kraflr)
# KRAFLR_BIN_DIR      where the kraflr command goes (default: ~/.local/bin)
# KRAFLR_RELEASE_URL  download from another folder that holds the release files, for testing a build
set -eu

say() { printf 'kraflr: %s\n' "$*"; }
fail() { printf 'kraflr: %s\n' "$*" >&2; exit 1; }

# Everything runs from main, so a download that stops halfway through this script does nothing.
main() {
  repository="plexavo/kraflr-agent"
  version="${KRAFLR_VERSION:-latest}"
  home="${KRAFLR_INSTALL_DIR:-$HOME/.local/share/kraflr}"
  bin="${KRAFLR_BIN_DIR:-$HOME/.local/bin}"

  [ "$(uname -s)" = Linux ] || fail "this installer supports Linux and WSL2. On other systems, run Kraflr from source (see the README)."
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    *) fail "releases are built for x86_64 only. On $(uname -m), run Kraflr from source (see the README)." ;;
  esac
  libc=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}') || libc=
  [ -n "$libc" ] || fail "a glibc-based Linux is needed; Alpine and other musl systems are not supported."
  [ "$(printf '2.35\n%s\n' "$libc" | sort -V | head -n 1)" = 2.35 ] || fail "glibc 2.35 or newer is needed (found $libc), for example Ubuntu 22.04 or Debian 12."
  for tool in curl tar gzip sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is needed. Install it and run this again."
  done

  # Replacing the files under a running workspace would mix two versions, so it has to be stopped first.
  if [ -x "$bin/kraflr" ] && "$bin/kraflr" status >/dev/null 2>&1; then
    fail "Kraflr is running. Finish your work, run 'kraflr stop', then run the installer again."
  fi

  asset="kraflr-agent-linux-$arch.tar.gz"
  if [ -n "${KRAFLR_RELEASE_URL:-}" ]; then base=$KRAFLR_RELEASE_URL
  elif [ "$version" = latest ]; then base="https://github.com/$repository/releases/latest/download"
  else base="https://github.com/$repository/releases/download/v${version#v}"
  fi

  mkdir -p "$home" "$bin"
  work=$(mktemp -d)
  trap 'rm -rf "$work" "$home/app.new"' EXIT
  trap 'exit 1' INT TERM

  say "downloading $asset ($version)"
  curl -fsSL --retry 3 -o "$work/$asset" "$base/$asset" || fail "download failed: $base/$asset"
  curl -fsSL --retry 3 -o "$work/$asset.sha256" "$base/$asset.sha256" || fail "download failed: $base/$asset.sha256"
  (cd "$work" && sha256sum -c "$asset.sha256" >/dev/null 2>&1) || fail "the download does not match its checksum. Nothing was installed."

  new="$home/app.new"
  rm -rf "$new"
  mkdir "$new"
  tar -xzf "$work/$asset" -C "$new" --strip-components=1
  if ! problem=$(cd "$new" && ./runtime/bin/node -e "require('node-pty')" 2>&1); then
    case "$problem" in
      *libatomic.so.1*) fail "one system library is missing. Install it, then run this again:  sudo apt-get install -y libatomic1   (Fedora: sudo dnf install libatomic). Nothing was installed." ;;
    esac
    printf '%s\n' "$problem" >&2
    fail "this build does not run on this system. Nothing was installed."
  fi

  rm -rf "$home/app.previous"
  if [ -d "$home/app" ]; then mv "$home/app" "$home/app.previous"; fi
  mv "$new" "$home/app"

  # A command made another way, such as a source checkout, is kept beside the new one.
  if [ -e "$bin/kraflr" ] && ! grep -qF "$home/app/" "$bin/kraflr" 2>/dev/null; then
    mv "$bin/kraflr" "$bin/kraflr.previous"
    say "your earlier kraflr command was kept as $bin/kraflr.previous"
  fi
  cat > "$bin/kraflr" <<EOF
#!/bin/sh
exec "$home/app/runtime/bin/node" "$home/app/bin/kraflr.mjs" "\$@"
EOF
  chmod 755 "$bin/kraflr"

  installed=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$home/app/package.json" | head -n 1)
  say "installed Kraflr Agent $installed in $home/app"
  case ":$PATH:" in
    *":$bin:"*) ;;
    *) say "add it to your PATH:  export PATH=\"$bin:\$PATH\"" ;;
  esac
  command -v git >/dev/null 2>&1 || say "git is not installed; source reviews need it."
  say "next, check your setup with:  kraflr doctor"
}

main "$@"

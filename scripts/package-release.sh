#!/bin/sh
# Builds dist/kraflr-agent-linux-x64.tar.gz and its checksum: the application, its production dependencies with node-pty compiled for this
# system, and the Node.js runtime named in .node-version. Build on the oldest Linux the release has to support (the workflow uses Ubuntu 22.04).
# Needs curl, tar, xz, sha256sum, Python 3, make and a C++ compiler.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
node_version=$(tr -d ' \r\n' < "$root/.node-version")
pnpm_version=$(sed -n 's/.*"packageManager": *"pnpm@\([0-9.]*\)".*/\1/p' "$root/package.json")
[ "$(uname -s)-$(uname -m)" = Linux-x86_64 ] || { echo "Build the release on Linux x86_64." >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# The official runtime, checked against the checksum list Node.js publishes with it.
node_name="node-v$node_version-linux-x64"
curl -fsSL --retry 3 -o "$work/$node_name.tar.xz" "https://nodejs.org/dist/v$node_version/$node_name.tar.xz"
curl -fsSL --retry 3 -o "$work/SHASUMS256.txt" "https://nodejs.org/dist/v$node_version/SHASUMS256.txt"
(cd "$work" && grep " $node_name.tar.xz\$" SHASUMS256.txt | sha256sum -c -)
tar -xJf "$work/$node_name.tar.xz" -C "$work"
PATH="$work/$node_name/bin:$PATH"
export PATH

# Only what an installed Kraflr runs, listed by name so that nothing else in the folder can slip into a release.
stage="$work/kraflr-agent"
mkdir -p "$stage/scripts" "$stage/runtime/bin"
for item in bin cli server shared docs package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .node-version README.md LICENSE NOTICE; do
  cp -R "$root/$item" "$stage/$item"
done
cp "$root/scripts/burp-relay.mjs" "$root/scripts/ensure-native-terminal.mjs" "$stage/scripts/"

# A flat node_modules with real files travels well in an archive.
(cd "$stage" && npm exec --yes --package="pnpm@$pnpm_version" -- pnpm install --prod --frozen-lockfile --config.node-linker=hoisted --store-dir "$work/store")
(cd "$stage" && node scripts/ensure-native-terminal.mjs && node -e "require('node-pty')")
# Binaries for other systems and compiler leftovers are not needed at run time.
rm -rf "$stage/.tools" "$stage/node_modules/node-pty/prebuilds" "$stage/node_modules/node-pty/third_party" "$stage/node_modules/node-pty/build/Release/obj.target"
(cd "$stage" && node -e "require('node-pty')")

cp "$work/$node_name/bin/node" "$stage/runtime/bin/node"
cp "$work/$node_name/LICENSE" "$stage/runtime/LICENSE"
"$stage/runtime/bin/node" "$stage/bin/kraflr.mjs" --help >/dev/null

mkdir -p "$root/dist"
asset=kraflr-agent-linux-x64.tar.gz
tar -czf "$root/dist/$asset" -C "$work" kraflr-agent
(cd "$root/dist" && sha256sum "$asset" > "$asset.sha256")
echo "Built dist/$asset ($(du -h "$root/dist/$asset" | cut -f1))"

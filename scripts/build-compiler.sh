#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p gen
source_dir="gen/componentize-qjs-src"
revision=eee19a60b144321b2535a50cc58e05b73d9f5242
if [[ ! -d "$source_dir/.git" ]]; then
  git clone https://github.com/andreiltd/componentize-qjs.git "$source_dir"
fi
if [[ "$(git -C "$source_dir" rev-parse HEAD)" != "$revision" ]]; then
  git -C "$source_dir" checkout "$revision"
fi
if git -C "$source_dir" apply --check "$PWD/patches/componentize-qjs.patch"; then
  git -C "$source_dir" apply "$PWD/patches/componentize-qjs.patch"
else
  git -C "$source_dir" apply --reverse --check "$PWD/patches/componentize-qjs.patch"
fi
CARGO_TARGET_DIR="$PWD/gen/compiler-target" cargo build --locked --release \
  --manifest-path "$source_dir/Cargo.toml" -p componentize-qjs-cli
cp gen/compiler-target/release/componentize-qjs gen/componentize-qjs

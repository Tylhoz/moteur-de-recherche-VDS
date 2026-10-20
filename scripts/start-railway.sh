#!/bin/sh
set -eu
umask 077
VDS_PRIVATE_DATA_ROOT="${VDS_PRIVATE_DATA_ROOT:-/data}"
export VDS_PRIVATE_DATA_ROOT
mkdir -p "$VDS_PRIVATE_DATA_ROOT"
test ! -L "$VDS_PRIVATE_DATA_ROOT"
chmod 700 "$VDS_PRIVATE_DATA_ROOT"
export VDS_VOLUME_LOCKED=true
exec flock --no-fork -n "$VDS_PRIVATE_DATA_ROOT/.writer-lock" node --import tsx server/railway.ts

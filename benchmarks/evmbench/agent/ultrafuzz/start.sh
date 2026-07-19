#!/usr/bin/env bash
set -euo pipefail

exec node /opt/ultrafuzz/packages/evmbench/dist/adapter-cli.js

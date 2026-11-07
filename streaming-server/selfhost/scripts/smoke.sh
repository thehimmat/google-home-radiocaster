#!/bin/sh
# Checks a running streaming server the way a listener would. Exits non-zero on failure.
#
#   sh smoke.sh https://stream.atthebunga.com            # or http://127.0.0.1:3001 on the VM
#   sh smoke.sh https://129-80-1-2.sslip.io fremont      # a station other than Golden Temple
#
# /health is reported but never fails the check: it's 503 whenever no source is on air, which says
# nothing about this server. The station must be listed and its /stream must carry AAC (ADTS) frames.
set -u
base=${1:?usage: smoke.sh <base-url> [station]}
station=${2:-golden-temple}
seconds=${SMOKE_STREAM_SECONDS:-15}
base=${base%/}

stations=$(curl -fsS --max-time 10 "$base/stations") || { echo "FAIL /stations unreachable"; exit 1; }
case "$stations" in
  *"\"slug\":\"$station\""*) echo "ok   /stations lists $station" ;;
  *) echo "FAIL /stations does not list $station"; exit 1 ;;
esac

health=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$base/health")
echo "info /health $health"

# ADTS frames start with the 12-bit syncword 0xFFF (fff1 or fff9 for MPEG-4 / MPEG-2, no CRC).
# The stream never ends, so take what arrives within the time limit.
hex=$(curl -sS --max-time "$seconds" "$base/$station/stream" 2>/dev/null | head -c 65536 | od -An -tx1 | tr -d ' \n')
case "$hex" in
  *fff1* | *fff9*) echo "ok   /$station/stream carries AAC frames (${#hex} hex chars in ${seconds}s or less)" ;;
  *) echo "FAIL /$station/stream: no AAC frames within ${seconds}s"; exit 1 ;;
esac

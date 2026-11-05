#!/bin/bash
# Deploy latest main to the Windows server (run on the Mac).
set -e
cd "$(dirname "$0")/.."
git push -q origin main
ssh win-pc 'powershell -NoProfile -ExecutionPolicy Bypass -File D:\AIGame\scripts\restart.ps1'
sleep 3
curl -s -m 5 http://100.94.116.56:8787/api/health && echo

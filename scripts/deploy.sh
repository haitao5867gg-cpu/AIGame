#!/bin/bash
# Deploy latest main to the Windows server (run on the Mac): push, pull on Windows, restart the scheduled task.
set -e
cd "$(dirname "$0")/.."
git push -q origin main
ssh win-pc 'Set-Location D:\AIGame; git pull -q; Stop-ScheduledTask "AIGame Server"; Get-CimInstance Win32_Process -Filter "Name=''node.exe''" | ? { $_.CommandLine -match "server.js" } | % { Stop-Process -Id $_.ProcessId -Force }; Start-Sleep 1; Start-ScheduledTask "AIGame Server"'
sleep 3
curl -s -m 5 http://100.94.116.56:8787/api/health && echo

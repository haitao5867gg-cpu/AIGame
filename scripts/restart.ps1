# Runs on Windows: pull latest code and restart the game server task.
Set-Location D:\AIGame
git pull -q
Stop-ScheduledTask "AIGame Server" -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'server\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# Stop-Process -Force skips node's exit handlers, so the Cloudflare quick tunnel the server started would be left running.
Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -match 'tunnel --no-autoupdate --url http://localhost:' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep 1
Start-ScheduledTask "AIGame Server"

$env:Path = "C:\Users\thoma\.cargo\bin;" + $env:Path
Set-Location C:\Users\thoma\Zeus
Start-Process -FilePath "cmd.exe" -ArgumentList "/c","npm run dev" -WorkingDirectory "C:\Users\thoma\Zeus" -WindowStyle Hidden
Write-Host "launched"
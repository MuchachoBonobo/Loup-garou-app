# Lance le serveur Loup-Garou avec les variables du fichier .env
# Utilisation : clic droit sur ce fichier > "Executer avec PowerShell"
#           ou : dans PowerShell, taper  .\start.ps1

Set-Location -Path $PSScriptRoot

if (Test-Path ".env") {
    Get-Content ".env" | ForEach-Object {
        if ($_ -match '^([^#=]+)=(.*)$') {
            [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim())
        }
    }
    Write-Host "Variables .env chargees." -ForegroundColor Green
} else {
    Write-Host "Pas de fichier .env trouve - le jeu demarre sans les lumieres." -ForegroundColor Yellow
}

node server.js

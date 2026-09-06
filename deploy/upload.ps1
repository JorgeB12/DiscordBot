# Sube Juan a una VM de Oracle Cloud y, si pides -Setup, lo instala y arranca.
# Ejemplo:
#   .\deploy\upload.ps1 -VmHost 129.146.x.x
#   .\deploy\upload.ps1 -VmHost 129.146.x.x -Setup

param(
  [Parameter(Mandatory = $true)]
  [string]$VmHost,
  [string]$User = "ubuntu",
  [string]$Key = "$env:USERPROFILE\.ssh\oracle_juan",
  [switch]$Setup
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$archive = Join-Path $env:TEMP "juan-bot.tar.gz"

if (-not (Test-Path $Key)) {
  throw "No encuentro la clave SSH en $Key. Generala con:`n  ssh-keygen -t ed25519 -f `"$Key`" -N `"`""
}

if (-not (Test-Path (Join-Path $root ".env"))) {
  throw "Falta .env en $root. Copialo de .env.example y rellena el token."
}

if (Test-Path $archive) { Remove-Item $archive -Force }

Push-Location $root
try {
  # Compilamos aquí y subimos dist/ ya listo: la VM no tiene TypeScript instalado.
  Write-Host "Compilando..."
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "La compilacion fallo; no subo nada." }
  tar -czf $archive --exclude=node_modules --exclude=.git --exclude=*.log .
} finally {
  Pop-Location
}

$ssh = @("-i", $Key, "-o", "StrictHostKeyChecking=accept-new")
$remote = "${User}@${VmHost}"

Write-Host "Subiendo el bot a $remote ..."
ssh @ssh $remote "mkdir -p ~/juan"
scp @ssh $archive "${remote}:~/juan-bot.tar.gz"
ssh @ssh $remote "tar -xzf ~/juan-bot.tar.gz -C ~/juan && rm ~/juan-bot.tar.gz"
Remove-Item $archive -Force

if ($Setup) {
  Write-Host "Instalando Node y arrancando el servicio..."
  # Por si Windows guardó los scripts con CRLF: los normalizamos en la VM antes de ejecutarlos.
  ssh @ssh $remote "sed -i 's/\r$//' ~/juan/deploy/setup.sh ~/juan/deploy/juan.service ~/juan/.env && chmod +x ~/juan/deploy/setup.sh && ~/juan/deploy/setup.sh"
} else {
  Write-Host "Actualizando dependencias y reiniciando el servicio..."
  ssh @ssh $remote "cd ~/juan && sed -i 's/\r$//' .env && npm install --omit=dev --no-audit --no-fund && sudo systemctl restart juan && sleep 2 && systemctl --no-pager status juan | head -n 6"
  Write-Host ""
  Write-Host "Logs en vivo: ssh -i `"$Key`" $remote `"journalctl -u juan -f`""
}

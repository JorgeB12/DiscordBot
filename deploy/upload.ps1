# Sube Bemol a una VM de Oracle Cloud y, si pides -Setup, lo instala y arranca.
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
$archive = Join-Path $env:TEMP "bemol-bot.tar.gz"

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
  tar -czf $archive --exclude=node_modules --exclude=.git --exclude=data --exclude=*.log .
} finally {
  Pop-Location
}

$ssh = @("-i", $Key, "-o", "StrictHostKeyChecking=accept-new")
$remote = "${User}@${VmHost}"

Write-Host "Subiendo el bot a $remote ..."
ssh @ssh $remote "mkdir -p ~/bemol"
scp @ssh $archive "${remote}:~/bemol-bot.tar.gz"
ssh @ssh $remote "tar -xzf ~/bemol-bot.tar.gz -C ~/bemol && rm ~/bemol-bot.tar.gz"
Remove-Item $archive -Force

if ($Setup) {
  Write-Host "Instalando Node y arrancando el servicio..."
  # Por si Windows guardó los scripts con CRLF: los normalizamos en la VM antes de ejecutarlos.
  ssh @ssh $remote "sed -i 's/\r$//' ~/bemol/deploy/setup.sh ~/bemol/deploy/bemol.service ~/bemol/.env && chmod +x ~/bemol/deploy/setup.sh && ~/bemol/deploy/setup.sh"
} else {
  Write-Host "Actualizando dependencias y reiniciando el servicio..."
  ssh @ssh $remote "cd ~/bemol && sed -i 's/\r$//' .env && npm install --omit=dev --no-audit --no-fund && sudo systemctl restart bemol && sleep 2 && systemctl --no-pager status bemol | head -n 6"
  Write-Host ""
  Write-Host "Logs en vivo: ssh -i `"$Key`" $remote `"journalctl -u bemol -f`""
}

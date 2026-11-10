# NEXUS OS en Windows: abre NEXUS OS en una ventana de VirtualBox. Lo lanza «Abrir NEXUS.bat» (doble clic).
#
# La primera vez crea en VirtualBox la máquina «NEXUS OS»: sus archivos pequeños (ajustes, registros) van a la carpeta
# de VirtualBox del usuario; el sistema y todo lo que se guarda en NEXUS está en nexus-os.vdi, junto a este archivo.
# Cada vez: ajusta la pantalla de la máquina a la del PC, vuelve a conectar el disco si la carpeta ha cambiado de
# sitio (otra letra de unidad, otro PC, una copia en el disco del PC) y arranca la máquina.
#
# En el repositorio: vm/windows/nexus-windows.ps1. vm/lab/make-windows-folder.sh lo copia (UTF-8 con BOM y CRLF, para
# Windows PowerShell 5.1) a la carpeta «Instalar NEXUS (Windows)». Necesita VirtualBox 7 o más nuevo.

$ErrorActionPreference = 'Continue'   # VBoxManage escribe avisos en stderr: cada llamada se comprueba por su código
Add-Type -AssemblyName System.Windows.Forms
$Name = 'NEXUS OS'
$Vdi = Join-Path $PSScriptRoot 'nexus-os.vdi'

function Say([string]$Text, [string]$Icon = 'Information', [string]$Buttons = 'OK') {
  return [System.Windows.Forms.MessageBox]::Show($Text, 'NEXUS OS', [System.Windows.Forms.MessageBoxButtons]$Buttons,
    [System.Windows.Forms.MessageBoxIcon]$Icon)
}
function Fail([string]$Text) { [void](Say $Text 'Error'); exit 1 }

if (-not (Test-Path -LiteralPath $Vdi)) {
  Fail "No encuentro el sistema de NEXUS OS:`n$Vdi`n`nTiene que estar en la carpeta Sistema, al lado de «Abrir NEXUS»."
}

# 1. VirtualBox (gratis, de Oracle): su instalador guarda dónde está en VBOX_MSI_INSTALL_PATH
$VBox = @($env:VBOX_MSI_INSTALL_PATH, $env:VBOX_INSTALL_PATH, (Join-Path $env:ProgramFiles 'Oracle\VirtualBox')) |
  Where-Object { $_ } | ForEach-Object { Join-Path $_ 'VBoxManage.exe' } |
  Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $VBox) {
  $r = Say ("Para abrir NEXUS en Windows hace falta VirtualBox (gratis, de Oracle).`n`n" +
            "¿Abro su página de descarga? Descarga el de «Windows hosts», instálalo (pide permiso de administrador) " +
            "y vuelve a hacer doble clic en «Abrir NEXUS».") 'Information' 'YesNo'
  if ($r -eq 'Yes') { Start-Process 'https://www.virtualbox.org/wiki/Downloads' }
  exit 1
}

# VB arg...: VBoxManage con esos argumentos; si falla, para y enseña lo que ha dicho VirtualBox
function VB {
  $out = & $VBox @args 2>&1 | ForEach-Object { "$_" }
  if ($LASTEXITCODE -ne 0) {
    $text = ($out | Where-Object { $_ -notmatch '^\s*$' }) -join "`n"
    $hint = ''
    if ($text -match 'VT-x|AMD-V|SVM|HMR3Init|VERR_VMX|VERR_SVM') {
      $hint = "`n`nTu PC tiene la virtualización apagada. Enciéndela en la BIOS/UEFI del PC (se llama «Intel VT-x», " +
              "«Intel Virtualization Technology» o «AMD SVM») y vuelve a probar."
    }
    Fail ("VirtualBox no ha podido hacer: VBoxManage $($args -join ' ')`n`n$text$hint")
  }
  return $out
}
# Prop lines key: un valor de «VBoxManage showvminfo --machinereadable» (key=valor o "key"="valor")
function Prop($Lines, [string]$Key) {
  foreach ($l in $Lines) {
    foreach ($k in @("$Key=", "`"$Key`"=")) { if ($l.StartsWith($k)) { return $l.Substring($k.Length).Trim('"') } }
  }
  return $null
}

$version = (& $VBox --version 2>$null | Select-Object -First 1)
if ($version -match '^(\d+)\.' -and [int]$Matches[1] -lt 7) {
  Fail "Tienes VirtualBox $version y NEXUS necesita VirtualBox 7 o más nuevo. Instala el último desde virtualbox.org."
}

# 2. La pantalla: la de NEXUS tiene la forma de la del PC (en pantalla completa la llena entera), como mucho
#    1920 de ancho: NEXUS dibuja sin tarjeta gráfica dentro de VirtualBox y más píxeles lo harían ir lento.
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$w = [int]$screen.Width; $h = [int]$screen.Height
if ($w -gt 1920) { $h = [int][math]::Round($h * 1920 / $w); $w = 1920 }
if ($w -lt 1024 -or $h -lt 640) { $w = 1280; $h = 800 }
$w -= $w % 8; $h -= $h % 2

# 3. La máquina: se crea la primera vez
$info = & $VBox showvminfo $Name --machinereadable 2>$null
$created = $false
if ($LASTEXITCODE -ne 0) {
  $ramMB = [math]::Floor((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB)
  $mem = [int][math]::Min(6144, [math]::Max(2048, [math]::Floor($ramMB / 2 / 512) * 512))     # la mitad, 2-6 GB
  $cpus = [int][math]::Min(6, [math]::Max(2, [math]::Floor([Environment]::ProcessorCount / 2)))
  VB createvm --name $Name --ostype Debian_64 --register | Out-Null
  # EFI (NEXUS arranca así), VMSVGA (la tarjeta gráfica virtual que Linux conoce), ratón tipo tableta (se mueve
  # entre Windows y NEXUS sin «capturarlo»), red NAT (NEXUS sale a Internet; nada de fuera entra en NEXUS)
  VB modifyvm $Name --memory $mem --cpus $cpus --firmware efi --ioapic on --rtc-use-utc on `
    --graphicscontroller vmsvga --vram 128 --accelerate-3d off --mouse usbtablet --usb-ohci on `
    --nic1 nat --boot1 disk --boot2 none --boot3 none --boot4 none | Out-Null
  VB storagectl $Name --name SATA --add sata --controller IntelAhci --portcount 1 | Out-Null
  # cerrar la ventana apaga NEXUS bien; la ventana se adapta a su tamaño (modo escalado) y empieza maximizada
  VB setextradata $Name GUI/DefaultCloseAction Shutdown | Out-Null
  VB setextradata $Name GUI/Scale true | Out-Null
  VB setextradata $Name GUI/LastNormalWindowPosition "40,40,$([int]($w * 0.8)),$([int]($h * 0.8)),max" | Out-Null
  $info = VB showvminfo $Name --machinereadable
  $created = $true
}

$state = Prop $info 'VMState'
if ($state -in @('running', 'paused', 'starting', 'restoring', 'saving', 'stopping')) {
  Fail 'NEXUS OS ya está abierto (mira la barra de tareas). Si no lo ves, ciérralo desde VirtualBox y vuelve a probar.'
}

# El tamaño de pantalla con el que arranca el firmware: NEXUS lo usa para su escritorio (nexus-boot-display)
VB setextradata $Name VBoxInternal2/EfiGraphicsResolution "${w}x${h}" | Out-Null

# 4. El disco: si VirtualBox lo tiene en otro sitio (otra letra de unidad, otra copia de la carpeta), se cambia por éste
$cur = Prop $info 'SATA-0-0'
if ($cur -ne $Vdi) {
  # una máquina «guardada» no deja cambiar su disco: se olvida lo guardado (como apagar de golpe)
  if ($state -eq 'saved') { VB discardstate $Name | Out-Null }
  if ($cur -and $cur -ne 'none') { VB storageattach $Name --storagectl SATA --port 0 --device 0 --medium none | Out-Null }
  $hdds = (& $VBox list hdds 2>$null | ForEach-Object { "$_" }) -join "`n"
  foreach ($block in ($hdds -split "\n\s*\n")) {
    if ($block -match '(?m)^UUID:\s+(\S+)' ) { $uuid = $Matches[1] } else { continue }
    if ($block -match '(?m)^Location:\s+(.+?)\s*$') { $loc = $Matches[1] } else { continue }
    if ((Split-Path -Leaf $loc) -ieq 'nexus-os.vdi' -and $loc -ne $Vdi) { & $VBox closemedium disk $uuid 2>$null | Out-Null }
  }
  VB storageattach $Name --storagectl SATA --port 0 --device 0 --type hdd --medium $Vdi | Out-Null
}

if ($created) {
  [void](Say ("Listo: NEXUS OS ya está en VirtualBox. Ahora se abre.`n`n" +
              "• La primera vez tarda un poco más en arrancar (desde un disco externo, unos minutos).`n" +
              "• Contraseña: nexus`n" +
              "• Pantalla completa: Ctrl derecho + F (lo mismo para salir).`n" +
              "• Para cerrar: apaga desde NEXUS o cierra la ventana.`n`n" +
              "No desconectes el disco mientras NEXUS esté abierto."))
}

# 5. Abrir
VB startvm $Name --type gui | Out-Null

@echo off
rem NEXUS OS en Windows: doble clic para abrir NEXUS en una ventana de VirtualBox.
rem El trabajo lo hace Sistema\nexus-windows.ps1 (en el repositorio: vm/windows).
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0Sistema\nexus-windows.ps1"

@echo off
setlocal DisableDelayedExpansion
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1" %*
set "installStatus=%errorlevel%"
if "%installStatus%"=="0" exit /b 0
echo(
pause
exit /b %installStatus%

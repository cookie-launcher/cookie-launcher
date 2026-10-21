@echo off
setlocal EnableExtensions
title Cookie Launcher - Offline LAN Fix

echo ============================================================
echo  Cookie Launcher - offline LAN fix
echo ============================================================
echo.
echo Close Minecraft completely before running this file.
echo This only edits files in your own AppData folder.
echo No administrator rights are needed.
echo.
pause

set "MC=%APPDATA%\.minecraft"

if not exist "%MC%" (
  echo ERROR: Minecraft folder not found:
  echo %MC%
  pause
  exit /b 1
)

call :write_file "%MC%\server.properties"

if exist "%MC%\instances" (
  for /d %%D in ("%MC%\instances\*") do (
    call :write_file "%%~fD\server.properties"
    if exist "%%~fD\saves" (
      for /d %%W in ("%%~fD\saves\*") do call :write_file "%%~fW\server.properties"
    )
  )
)

if exist "%MC%\saves" (
  for /d %%W in ("%MC%\saves\*") do call :write_file "%%~fW\server.properties"
)

echo.
echo ============================================================
echo  DONE. Now restart Minecraft, enter the world,
echo  open it to LAN, and share it again from the launcher.
echo ============================================================
echo.
pause
exit /b 0

:write_file
set "TARGET=%~1"
if not exist "%TARGET%" (
  >"%TARGET%" echo online-mode=false
  echo Created: %TARGET%
  exit /b 0
)
findstr /I /V /B /C:"online-mode=" "%TARGET%" > "%TARGET%.tmp"
>>"%TARGET%.tmp" echo online-mode=false
move /Y "%TARGET%.tmp" "%TARGET%" >nul
echo Updated: %TARGET%
exit /b 0

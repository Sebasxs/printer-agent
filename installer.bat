@echo off
setlocal EnableDelayedExpansion
title SmartPOS Agent - Asistente de Instalacion

:: ==========================================
:: DEFINICION DE COLORES (ANSI)
:: ==========================================
for /F "tokens=1,2 delims=#" %%a in ('"prompt #$H#$E# & echo on & for %%b in (1) do rem"') do set "ESC=%%b"
set "RESET=%ESC%[0m"
set "BOLD=%ESC%[1m"
set "RED=%ESC%[91m"
set "GREEN=%ESC%[92m"
set "YELLOW=%ESC%[93m"
set "CYAN=%ESC%[96m"
set "GRAY=%ESC%[90m"
set "WHITE=%ESC%[97m"

:: ==========================================
:: CONFIGURACION
:: ==========================================
set "NOMBRE_SERVICIO=smartpos_printer"
set "RUTA_INSTALACION=C:\SmartPOS"
set "FUENTE=%~dp0"
:: ==========================================

:: 1. VERIFICAR PERMISOS
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo.
    echo  %RED%[ERROR CRITICO] SE REQUIEREN PERMISOS DE ADMINISTRADOR.%RESET%
    echo  Por favor, haz %BOLD%CLICK DERECHO%RESET% sobre este archivo
    echo  y selecciona "%WHITE%EJECUTAR COMO ADMINISTRADOR%RESET%".
    echo.
    pause
    exit
)

cls
echo.
echo  %CYAN%========================================================%RESET%
echo       %BOLD%ASISTENTE DE INSTALACION SMARTPOS PRINTER%RESET%
echo  %CYAN%========================================================%RESET%
echo.
echo  %GRAY%Ruta de instalacion:%RESET% %RUTA_INSTALACION%
echo.

:: 2. VERIFICAR SI EL SERVICIO YA EXISTE
sc query "%NOMBRE_SERVICIO%" >nul 2>&1
if %errorLevel% equ 0 (
    set "MODO=ACTUALIZACION"
    echo  [%CYAN%INFO%RESET%] El servicio ya existe, vamos a realizar una %CYAN%ACTUALIZACION%RESET%.
) else (
    set "MODO=INSTALACION"
    echo  [%GREEN%OK%RESET%] El servicio no existe, vamos a realizar una %GREEN%INSTALACION LIMPIA%RESET%.
)
echo.
echo  Presiona cualquier tecla para comenzar...
pause >nul

:: 3. DETENER SERVICIO
if "%MODO%"=="ACTUALIZACION" (
    echo.
    echo  %YELLOW%[1/5]%RESET% Deteniendo servicio actual...
    net stop "%NOMBRE_SERVICIO%" >nul 2>&1
    timeout /t 3 /nobreak >nul
)

:: 4. PREPARAR CARPETA
echo.
echo  %YELLOW%[2/5]%RESET% Preparando carpeta de destino...
if not exist "%RUTA_INSTALACION%" mkdir "%RUTA_INSTALACION%"

:: 5. COPIAR ARCHIVOS
echo.
echo  %YELLOW%[3/5]%RESET% Copiando archivos al sistema...

if not exist "%FUENTE%bin\node.exe" (
    echo  %RED%[ALERTA]%RESET% No se encontro node.exe en el instalador.
    echo  El servicio podria fallar si el cliente no tiene Node instalado.
    echo.
    pause
)

robocopy "%FUENTE%." "%RUTA_INSTALACION%" *.* /E /XD node_modules /XF installer.bat uninstaller.bat /IS /IT >nul

if exist "%FUENTE%node_modules" (
    echo        - Copiando librerias %GRAY%(esto puede tardar)%RESET%...
    robocopy "%FUENTE%node_modules" "%RUTA_INSTALACION%\node_modules" /E >nul
) else (
    echo  %RED%[ERROR]%RESET% No se encontro carpeta node_modules en el origen.
    echo  Sin esto, el programa no funcionara en modo portable.
    pause
    exit
)

if %errorLevel% geq 8 (
    echo.
    echo %RED%[ERROR]%RESET% Fallo al copiar archivos. Verifica permisos.
    pause
    exit
)

:: 6. SEGURIDAD BASICA
echo.
echo  %YELLOW%[4/5]%RESET% Aplicando seguridad basica...
if exist "%RUTA_INSTALACION%\.env" attrib +h +r "%RUTA_INSTALACION%\.env"
if exist "%RUTA_INSTALACION%\*.json" attrib +h +r "%RUTA_INSTALACION%\*.json"
if exist "%RUTA_INSTALACION%\credentials" attrib +h +s "%RUTA_INSTALACION%\credentials" /s /d

:: 7. INSTALACION / REINICIO
echo.
echo  %YELLOW%[5/5]%RESET% Configurando servicio...

cd /d "%RUTA_INSTALACION%"

if "%MODO%"=="INSTALACION" (
    echo        - Registrando servicio en Windows...
    ".\bin\node.exe" ".\bin\install_service.js"
) else (
    echo        - Reiniciando servicio actualizado...
    net start "%NOMBRE_SERVICIO%"
)

echo.
echo  %GREEN%========================================================%RESET%
echo       %BOLD%PROCESO COMPLETADO EXITOSAMENTE%RESET%
echo  %GREEN%========================================================%RESET%
echo.
if "%MODO%"=="INSTALACION" echo  El servicio se iniciara automaticamente.
if "%MODO%"=="ACTUALIZACION" echo  El servicio ha sido actualizado y reiniciado.
echo.
pause
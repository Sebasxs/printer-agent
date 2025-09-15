@echo off
setlocal EnableDelayedExpansion
title SmartPOS Printer - Desinstalador

:: ==========================================
:: DEFINICION DE COLORES
:: ==========================================
for /F "tokens=1,2 delims=#" %%a in ('"prompt #$H#$E# & echo on & for %%b in (1) do rem"') do set "ESC=%%b"
set "RESET=%ESC%[0m"
set "BOLD=%ESC%[1m"
set "RED=%ESC%[91m"
set "GREEN=%ESC%[92m"
set "YELLOW=%ESC%[93m"
set "CYAN=%ESC%[96m"

:: ==========================================
:: CONFIGURACION
:: ==========================================
set "NOMBRE_SERVICIO=smartpos_printer"
:: ==========================================

:: 1. VERIFICAR PERMISOS
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo.
    echo  %RED%[ERROR] SE REQUIEREN PERMISOS DE ADMINISTRADOR.%RESET%
    echo  Por favor, ejecuta este archivo como Administrador.
    echo.
    pause
    exit
)

cls
echo.
echo  %CYAN%========================================================%RESET%
echo       %BOLD%DESINSTALADOR SMARTPOS PRINTER%RESET%
echo  %CYAN%========================================================%RESET%
echo.

:: 2. VERIFICAR SI EXISTE
sc query "%NOMBRE_SERVICIO%" >nul 2>&1
if %errorLevel% neq 0 (
    echo  %YELLOW%[!] El servicio no esta instalado en Windows.%RESET%
    echo      No hay nada que desinstalar.
    echo.
    pause
    exit
)

echo  Se procedera a eliminar el servicio: %BOLD%%NOMBRE_SERVICIO%%RESET%
echo.
pause

:: 3. DETENER Y ELIMINAR
echo.
echo  %YELLOW%[1/2]%RESET% Deteniendo servicio...
net stop "%NOMBRE_SERVICIO%" >nul 2>&1

echo.
echo  %YELLOW%[2/2]%RESET% Eliminando del registro de Windows...

sc delete "%NOMBRE_SERVICIO%" >nul 2>&1

if %errorLevel% equ 0 (
    echo.
    echo  %GREEN%========================================================%RESET%
    echo       %BOLD%SERVICIO ELIMINADO CORRECTAMENTE%RESET%
    echo  %GREEN%========================================================%RESET%
    echo.
    echo  %BOLD%NOTA:%RESET% Ya puedes borrar esta carpeta manualmente si lo deseas.
) else (
    echo.
    echo  %RED%[ERROR]%RESET% No se pudo eliminar el servicio.
)

echo.
pause
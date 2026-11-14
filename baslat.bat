@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title Alev Laboratuvari
cd /d "%~dp0"

echo ==================================================
echo    Mikrogravite Alev Laboratuvari - Baslatici
echo ==================================================
echo.

rem ---------------------------------------------------
rem 1) Node.js kontrolu (Vite 8 icin Node 20.19+ gerekir)
rem ---------------------------------------------------
call :checkNode
if "!NODE_OK!"=="1" goto :deps

echo [!] Node.js bulunamadi ya da surumu eski (en az 20.19 gerekir).
where winget >nul 2>nul
if errorlevel 1 goto :noWinget

echo [*] Node.js LTS winget ile kuruluyor...
winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
rem Yeni kurulan Node'u bu pencerede de kullanabilmek icin PATH'e ekle
set "PATH=%ProgramFiles%\nodejs;%APPDATA%\npm;%PATH%"
call :checkNode
if "!NODE_OK!"=="1" goto :deps

echo.
echo [!] Kurulum bitti ama Node bu pencerede gorunmuyor.
echo     Bu pencereyi kapatip baslat.bat'i yeniden calistirin.
pause
exit /b 1

:noWinget
echo [!] winget yok; Node.js otomatik kurulamadi.
echo     https://nodejs.org adresinden LTS surumunu kurup bu dosyayi yeniden calistirin.
start "" https://nodejs.org/
if exist "dist-single\index.html" (
  echo.
  echo [*] Bu arada hazir derlenmis tek dosyalik surum aciliyor...
  start "" "%~dp0dist-single\index.html"
)
pause
exit /b 1

rem ---------------------------------------------------
rem 2) Paketler (vite, yazi tipleri)
rem ---------------------------------------------------
:deps
echo [OK] Node !NODE_VER!
if exist "node_modules\.bin\vite.cmd" goto :menu
echo [*] Paketler yukleniyor (ilk calistirmada 1-2 dakika surebilir)...
if exist "package-lock.json" (
  call npm ci --no-audit --no-fund
) else (
  call npm install --no-audit --no-fund
)
if errorlevel 1 (
  echo [!] npm ci basarisiz, npm install deneniyor...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [HATA] Paketler yuklenemedi. Internet baglantisini kontrol edin.
    pause
    exit /b 1
  )
)

rem ---------------------------------------------------
rem 3) Calistirma secenekleri
rem ---------------------------------------------------
:menu
echo.
echo   [1] Calistir (gelistirme sunucusu, tarayici otomatik acilir)
echo   [2] Tek dosyalik surumu derle ve ac (dist-single\index.html)
echo   [3] Yalnizca paketleri yeniden yukle
echo   [4] Cikis
echo.
choice /C 1234 /N /T 15 /D 1 /M "Seciminiz (15 sn icinde secilmezse 1): "
if errorlevel 4 exit /b 0
if errorlevel 3 goto :reinstall
if errorlevel 2 goto :single

:dev
echo.
echo [*] Sunucu baslatiliyor: http://localhost:47321
echo     Ayni agdaki baska bir cihazdan da acilabilir (asagidaki Network adresi).
echo     Kapatmak icin bu pencerede Ctrl+C.
echo.
call npm run dev -- --open
pause
exit /b 0

:single
echo.
echo [*] Tek dosyalik surum derleniyor...
call npm run build:single
if errorlevel 1 (
  echo [HATA] Derleme basarisiz.
  pause
  exit /b 1
)
start "" "%~dp0dist-single\index.html"
echo [OK] dist-single\index.html acildi. Bu dosya internetsiz de calisir.
pause
exit /b 0

:reinstall
if exist node_modules rmdir /s /q node_modules
call npm install --no-audit --no-fund
goto :menu

rem ---------------------------------------------------
:checkNode
set "NODE_OK=0"
set "NODE_VER="
where node >nul 2>nul || exit /b 0
for /f "delims=" %%v in ('node -v') do set "NODE_VER=%%v"
set "V=!NODE_VER:v=!"
for /f "tokens=1,2 delims=." %%a in ("!V!") do (
  set /a MAJ=%%a
  set /a MIN=%%b
)
if !MAJ! GTR 22 set "NODE_OK=1"
if !MAJ! EQU 22 if !MIN! GEQ 12 set "NODE_OK=1"
if !MAJ! EQU 21 set "NODE_OK=0"
if !MAJ! EQU 20 if !MIN! GEQ 19 set "NODE_OK=1"
exit /b 0

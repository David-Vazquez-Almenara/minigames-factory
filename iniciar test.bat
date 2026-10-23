@echo off
rem Arranca el entorno de pruebas: servidor (backend) y frontend en dos terminales separadas.
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo No se encuentra npm. Instala Node.js desde https://nodejs.org y vuelve a intentarlo.
  pause
  exit /b 1
)

rem Variables de entorno locales: si no existen los .env, se crean a partir de las plantillas.
if not exist "backend\.env" (
  echo Creando backend\.env a partir de backend\.env.example...
  copy /y "backend\.env.example" "backend\.env" >nul
)

if not exist "frontend\.env" (
  echo Creando frontend\.env a partir de frontend\.env.example...
  copy /y "frontend\.env.example" "frontend\.env" >nul
)

if not exist "backend\node_modules" (
  echo Instalando dependencias del servidor...
  call npm --prefix backend install
)

if not exist "frontend\node_modules" (
  echo Instalando dependencias del frontend...
  call npm --prefix frontend install
)

start "Servidor (backend) - puerto 3000" /D "%~dp0backend" cmd /k npm run dev
start "Frontend (Angular) - puerto 4200" /D "%~dp0frontend" cmd /k npm start

echo.
echo Servidor:  http://localhost:3000
echo Frontend:  http://127.0.0.1:4200
echo.
echo Abriendo el navegador cuando el frontend termine de compilar...
timeout /t 12 /nobreak >nul
start "" "http://127.0.0.1:4200"
endlocal

@echo off
title OSCE Simulator - Buat Shortcut Desktop
cd /d "%~dp0"

echo ============================================
echo  Membuat shortcut OSCE Simulator di Desktop
echo ============================================
echo.

REM --- Salin icon ke dalam folder project supaya shortcut tetap valid
REM     walau folder dipindah (selama isi folder tidak berubah)
set "ICON=%~dp0osce-simulator.ico"

if not exist "%ICON%" (
    echo [ERROR] File icon tidak ditemukan: %ICON%
    echo Pastikan file osce-simulator.ico berada di folder yang sama dengan bat ini.
    pause
    exit /b 1
)

if not exist "%~dp0OSCE Simulator.bat" (
    echo [ERROR] File "OSCE Simulator.bat" tidak ditemukan di folder ini.
    echo Pastikan semua file diekstrak ke folder yang sama.
    pause
    exit /b 1
)

REM --- Buat shortcut via PowerShell (tidak perlu install apapun)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s = (New-Object -COM WScript.Shell).CreateShortcut('%USERPROFILE%\Desktop\OSCE Simulator.lnk');" ^
  "$s.TargetPath  = '%~dp0OSCE Simulator.bat';" ^
  "$s.WorkingDirectory = '%~dp0';" ^
  "$s.IconLocation = '%ICON%,0';" ^
  "$s.Description  = 'OSCE CR Simulator - Psikiatri & Neurologi';" ^
  "$s.Save()"

if %ERRORLEVEL% neq 0 (
    echo [ERROR] Gagal membuat shortcut. Coba jalankan sebagai Administrator.
    pause
    exit /b 1
)

echo.
echo [OK] Shortcut "OSCE Simulator" berhasil dibuat di Desktop.
echo      Icon sudah terpasang secara otomatis.
echo.
echo Kamu bisa hapus file bat ini setelah shortcut berhasil dibuat.
echo.
pause

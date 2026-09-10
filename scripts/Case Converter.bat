@echo off
powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0case-converter.ps1"
if %errorlevel% neq 0 (
    echo.
    echo ERROR: PowerShell script gagal dengan kode %errorlevel%
    echo Pastikan case-converter.ps1 ada di folder yang sama dengan Case Converter.bat
    pause
)

@echo off
rem Starts the local server and opens EMG Hand in its own Edge/Chrome window.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
if errorlevel 1 pause

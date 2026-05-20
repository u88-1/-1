@echo off
cd /d "%~dp0"
start "Otzaria Source Checker" node server.js
timeout /t 1 /nobreak >nul
start "" http://localhost:3000

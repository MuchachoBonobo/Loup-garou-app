@echo off
REM Double-clic pour verifier la connexion aux lumieres Philips Hue.
title Loup-Garou - test des lumieres
cd /d "%~dp0..\code"
node outils\test-hue.js
echo.
echo Appuie sur une touche pour fermer.
pause >nul

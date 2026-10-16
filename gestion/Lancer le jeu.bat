@echo off
REM Double-clic pour lancer le serveur du Loup-Garou.
REM Laisser cette fenetre ouverte pendant toute la partie (la fermer = arreter le jeu).
title Loup-Garou - serveur
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\code\start.ps1"
echo.
echo Le serveur s est arrete. Appuie sur une touche pour fermer.
pause >nul

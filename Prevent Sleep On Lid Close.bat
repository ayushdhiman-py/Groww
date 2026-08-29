@echo off
powershell -Command "Start-Process powershell -ArgumentList '-NoExit -ExecutionPolicy Bypass -File \"D:\Groww\prevent-sleep.ps1\"' -Verb RunAs"

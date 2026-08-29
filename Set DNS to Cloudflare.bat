@echo off
powershell -Command "Start-Process powershell -ArgumentList '-NoExit -ExecutionPolicy Bypass -File \"D:\Groww\set-dns.ps1\"' -Verb RunAs"

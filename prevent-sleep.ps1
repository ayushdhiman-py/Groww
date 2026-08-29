# Covers BOTH AC (plugged-in) and DC (battery) — the scanner/site needs to
# survive a lid close regardless of power source, so both must disable
# sleep-on-lid-close and the idle standby timeout. Real tradeoff, deliberately
# accepted: if the laptop is ever left running on battery with the lid
# closed, it keeps running full tilt (Node + WebSocket feed + Cloudflare
# tunnel) — battery drains fast, and a closed lid blocks normal venting, so
# it also runs hotter than usual with no airflow. Plug in when leaving it
# unattended for long stretches.
#
# "Lid close action" is a HIDDEN power setting on this hardware (Modern
# Standby / S0-only systems often hide it) — powercfg -attributes un-hides it
# first so later `powercfg /query` calls (e.g. re-checking this) actually
# show the current value instead of nothing.
powercfg -attributes SUB_BUTTONS LIDACTION -ATTRIB_HIDE

powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /setactive SCHEME_CURRENT

Write-Host "Done. Closing the lid no longer sleeps the PC, on AC or battery, and it will never sleep from inactivity either way." -ForegroundColor Green
Write-Host "Reminder: plug in before closing the lid for any extended stretch — otherwise it drains the battery and runs hot with no venting." -ForegroundColor Yellow

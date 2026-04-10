# 🚀 Quick Deploy Script for Windows (PowerShell)
# Run this in PowerShell: .\deploy.ps1

Write-Host "`n🚀 Ayush's Groww Scanner - Quick Deploy Guide" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

# Check if git repo
$gitExists = Test-Path ".git"
if (-not $gitExists) {
    Write-Host "❌ Not a git repository. Initializing..." -ForegroundColor Yellow
    git init
    git add .
    git commit -m "Initial commit: Groww Scanner ready for deployment"
    Write-Host "✅ Git repository initialized!" -ForegroundColor Green
    Write-Host ""
}

Write-Host "📋 Next Steps:" -ForegroundColor Yellow
Write-Host "==============" -ForegroundColor Yellow
Write-Host ""

Write-Host "1️⃣  Push to GitHub (if not already):" -ForegroundColor Green
Write-Host "   git remote add origin https://github.com/YOUR_USERNAME/groww-scanner.git"
Write-Host "   git branch -M main"
Write-Host "   git push -u origin main"
Write-Host ""

Write-Host "2️⃣  Deploy on Render:" -ForegroundColor Green
Write-Host "   → Go to https://render.com"
Write-Host "   → Sign in with GitHub"
Write-Host "   → New + → Web Service"
Write-Host "   → Select your repo"
Write-Host "   → Configure:"
Write-Host "     • Build: npm install"
Write-Host "     • Start: node scanner_testing.mjs"
Write-Host "     • Plan: Free"
Write-Host ""

Write-Host "3️⃣  Add Environment Variables in Render:" -ForegroundColor Green
Write-Host "   → Click 'Advanced' section"
Write-Host "   → Add these:"
Write-Host "     GROWW_API_KEY=<from src/config.mjs line 6>"
Write-Host "     GROWW_API_SECRET=<from src/config.mjs line 7>"
Write-Host "     NODE_ENV=production"
Write-Host ""

Write-Host "4️⃣  Click 'Create Web Service'" -ForegroundColor Green
Write-Host "   → Wait 2-3 minutes for deploy"
Write-Host "   → You'll get URL like: https://your-app.onrender.com"
Write-Host ""

Write-Host "5️⃣  (Optional) Keep it awake with UptimeRobot:" -ForegroundColor Green
Write-Host "   → Go to https://uptimerobot.com"
Write-Host "   → Add monitor: https://your-app.onrender.com/api/status"
Write-Host "   → Set interval: 5 minutes"
Write-Host ""

Write-Host "📚 For detailed instructions, see DEPLOYMENT.md" -ForegroundColor Cyan
Write-Host ""
Write-Host "✨ You're all set! Happy trading! 📈" -ForegroundColor Magenta
Write-Host ""

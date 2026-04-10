#!/bin/bash
# 🚀 Quick Deploy Script for Render
# Run this after pushing to GitHub

echo "🚀 Ayush's Groww Scanner - Quick Deploy Guide"
echo "=============================================="
echo ""

# Check if git repo
if [ ! -d ".git" ]; then
    echo "❌ Not a git repository. Initializing..."
    git init
    git add .
    git commit -m "Initial commit: Groww Scanner ready for deployment"
    echo "✅ Git repository initialized!"
fi

echo ""
echo "📋 Next Steps:"
echo "=============="
echo ""
echo "1️⃣  Push to GitHub (if not already):"
echo "   git remote add origin https://github.com/YOUR_USERNAME/groww-scanner.git"
echo "   git branch -M main"
echo "   git push -u origin main"
echo ""
echo "2️⃣  Deploy on Render:"
echo "   → Go to https://render.com"
echo "   → Sign in with GitHub"
echo "   → New + → Web Service"
echo "   → Select your repo"
echo "   → Configure:"
echo "     • Build: npm install"
echo "     • Start: node scanner_testing.mjs"
echo "     • Plan: Free"
echo ""
echo "3️⃣  Add Environment Variables in Render:"
echo "   → Click 'Advanced' section"
echo "   → Add these:"
echo "     GROWW_API_KEY=<from src/config.mjs line 6>"
echo "     GROWW_API_SECRET=<from src/config.mjs line 7>"
echo "     NODE_ENV=production"
echo ""
echo "4️⃣  Click 'Create Web Service'"
echo "   → Wait 2-3 minutes for deploy"
echo "   → You'll get URL like: https://your-app.onrender.com"
echo ""
echo "5️⃣  (Optional) Keep it awake with UptimeRobot:"
echo "   → Go to https://uptimerobot.com"
echo "   → Add monitor: https://your-app.onrender.com/api/status"
echo "   → Set interval: 5 minutes"
echo ""
echo "📚 For detailed instructions, see DEPLOYMENT.md"
echo ""
echo "✨ You're all set! Happy trading! 📈"

# 🚀 Deployment Guide — Ayush's Groww Scanner

## Quick Deploy to Render (5 minutes)

### Why Render?
- ✅ **Free forever** (750 hours/month = 24/7 on free tier)
- ✅ **Auto-deploys** from GitHub on every push
- ✅ **HTTPS** automatically configured
- ✅ **Zero DevOps** required
- ⚠️ **Spins down** after 15 min of inactivity (wakes in ~30 seconds)

---

## Option 1: Render.com (Recommended — Easiest)

### Step 1: Push to GitHub

```bash
# If not already a git repo
git init
git add .
git commit -m "Initial commit: Groww Scanner"

# Push to GitHub (create repo first)
git remote add origin https://github.com/YOUR_USERNAME/groww-scanner.git
git branch -M main
git push -u origin main
```

### Step 2: Deploy on Render

1. **Sign up**: Go to [render.com](https://render.com) → Sign up with GitHub
2. **New Service**: Click "New +" → "Web Service"
3. **Connect Repo**: Select your `groww-scanner` repository
4. **Configure**:
   - **Name**: `ayush-groww-scanner` (or any name)
   - **Region**: Choose closest to India (Oregon or Frankfurt)
   - **Branch**: `main`
   - **Root Directory**: Leave blank
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node scanner_testing.mjs`
   - **Plan**: **Free**

5. **Add Environment Variables**:
   Click "Advanced" → "Add Environment Variable":
   ```
   GROWW_API_KEY=<copy from src/config.mjs line 6>
   GROWW_API_SECRET=<copy from src/config.mjs line 7>
   NODE_ENV=production
   ```

6. **Deploy**: Click "Create Web Service"
   - First deploy takes 2-3 minutes
   - You'll get a URL like: `https://ayush-groww-scanner.onrender.com`

### Step 3: Keep It Awake (Optional)

To prevent spin-down on free tier:

**Option A: UptimeRobot (Free)**
1. Go to [uptimerobot.com](https://uptimerobot.com)
2. Add monitor: `https://your-app.onrender.com/api/status`
3. Set interval: 5 minutes
4. This keeps your app awake 24/7!

**Option B: cron-job.org (Free)**
1. Go to [cron-job.org](https://cron-job.org)
2. Create cron job hitting: `https://your-app.onrender.com/api/status`
3. Set to run every 5 minutes

---

## Option 2: Railway.app (Alternative)

1. Go to [railway.app](https://railway.app)
2. "New Project" → "Deploy from GitHub repo"
3. Same env vars as Render
4. Free tier: $5 credit/month (enough for ~500 hours)

---

## Option 3: Oracle Cloud Always-Free VM (Most Powerful)

**Specs**: 4 ARM cores, 24GB RAM, 200GB storage — completely free

### Steps:

1. **Sign up**: [oracle.com/cloud/free](https://www.oracle.com/cloud/free/)
2. **Create VM**:
   - Go to OCI Console → Compute → Instances
   - "Create Instance"
   - Choose **Ampere A1** (ARM) shape: `VM.Standard.A1.Flex`
   - Image: `Ubuntu 22.04`
   - Shape: 4 OCPUs, 24GB RAM

3. **SSH into VM**:
   ```bash
   ssh -i your-key.pem ubuntu@YOUR_VM_IP
   ```

4. **Install Node.js**:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

5. **Deploy app**:
   ```bash
   git clone https://github.com/YOUR_USERNAME/groww-scanner.git
   cd groww-scanner
   npm install
   ```

6. **Create env file**:
   ```bash
   nano .env
   ```
   Add:
   ```
   GROWW_API_KEY=your_key_here
   GROWW_API_SECRET=your_secret_here
   NODE_ENV=production
   PORT=4000
   ```

7. **Run with PM2** (auto-restart):
   ```bash
   sudo npm install -g pm2
   pm2 start scanner_testing.mjs --name groww-scanner
   pm2 save
   pm2 startup
   ```

8. **Open port 4000** in Oracle Cloud security list

9. **Access**: `http://YOUR_VM_IP:4000`

---

## Option 4: Self-Host on Your PC + ngrok (Immediate)

If you want to host from your Windows machine:

```bash
# Set env variables (Windows)
set GROWW_API_KEY=your_key
set GROWW_API_SECRET=your_secret
set NODE_ENV=production

# Start server
npm start

# In another terminal, expose to internet (install ngrok first)
ngrok http 4000
```

**Cons**: Requires your PC to stay on 24/7

---

## Performance Optimization Tips

### For Fast First Load:

1. **Enable CDN** (Cloudflare):
   - Add your Render URL to Cloudflare
   - Static assets (HTML/CSS/JS) will be cached globally

2. **Reduce bundle size**:
   - Already optimized! Your frontend is a single HTML file

3. **Database caching**:
   - Add Redis for session persistence (paid tier)

### For Zero Downtime:

- **Best**: Oracle Cloud VM (always on, never sleeps)
- **Easiest**: Render + UptimeRobot (free, stays awake)

---

## Monitoring & Logs

### Render:
```
Dashboard → Your Service → Logs
```

### Check if running:
```bash
curl https://your-app.onrender.com/api/status
```

### Expected response:
```json
{
  "authenticated": true,
  "scanning": false,
  "scanProgress": { "done": 242, "total": 242 },
  "lastUpdated": "2026-04-10T...",
  "errors": 0,
  "universe": 242
}
```

---

## Troubleshooting

### App crashes on startup:
```bash
# Check logs (Render)
Dashboard → Logs → Filter by "error"

# Common issues:
# 1. Missing env vars → Add GROWW_API_KEY and GROWW_API_SECRET
# 2. Port binding → Render sets PORT automatically
# 3. Dependencies → Run npm install
```

### "No session" error:
- Login via the web UI after deployment
- Session persists for 23 hours

### Rate limit errors:
- Groww API has limits (10 req/sec, 300 req/min)
- Already handled in code, but if you see errors, wait 1-2 minutes

---

## Cost Breakdown

| Platform | Cost | Always On? | Best For |
|----------|------|------------|----------|
| **Render Free** | $0 | ❌ (sleeps after 15min) | Easy deployment |
| **Render + UptimeRobot** | $0 | ✅ | Best free combo |
| **Oracle Cloud VM** | $0 | ✅ | Most powerful free option |
| **Railway** | $5 credit/month | ❌ | Testing |
| **Heroku** | $7/month | ✅ | Paid simplicity |

---

## Recommended Setup

**For your requirements** (free, no downtime, fast load):

### 🏆 Winner: **Oracle Cloud Always-Free VM**

**Why?**
- ✅ Completely free forever
- ✅ 24/7 always on (never sleeps)
- ✅ 4 cores, 24GB RAM (overkill for this app)
- ✅ Fast first load (server always running)
- ✅ Full control

**Alternative**: Render + UptimeRobot (easier setup, but slightly slower wake-up)

---

## Next Steps

1. Choose your platform from above
2. Follow the deployment steps
3. Add environment variables
4. Test: Visit your deployed URL
5. (Optional) Set up uptime monitoring

**Need help?** Check `ENV_VARIABLES.md` for API key setup details.

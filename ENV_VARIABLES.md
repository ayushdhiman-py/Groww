# Environment Variables for Deployment

## Required Variables

### UPSTOX_ACCESS_TOKEN
- **Description**: Upstox Analytics Token — a long-lived (~1 year), read-only credential used for all market-data, historical-candle, option-chain, and portfolio calls.
- **How to get**: Log in to your Upstox account → Developer Apps → Analytics tab → Generate Token → Confirm.
- **Format**: JWT-style token string.
- **Notes**: Unlike the old Groww integration, there is no daily interactive login — this single token is used directly on every request until it expires or you regenerate it.
- ⚠️ **SECURITY**: Never commit this to git! It is read from the environment / `.env` file only. Rotate it from the Upstox dashboard if it is ever exposed.

## Optional Variables

### PORT
- **Description**: Server port number
- **Default**: `4000` (local), `10000` (Render)
- **Render**: Auto-set to `$PORT` by platform

### NODE_ENV
- **Description**: Application environment
- **Values**: `development` | `production`
- **Default**: `development`
- **Production**: Set to `production` for optimized behavior

## For Render Deployment

When deploying to Render, set these in the Render Dashboard → Your Service → Environment:

```
UPSTOX_ACCESS_TOKEN=<your_upstox_analytics_token>
NODE_ENV=production
```

**Note**: Render automatically sets `PORT` and `NODE_VERSION`, so you don't need to configure those.

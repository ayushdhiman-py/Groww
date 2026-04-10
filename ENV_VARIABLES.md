# Environment Variables for Deployment

## Required Variables

### GROWW_API_KEY
- **Description**: Your Groww API key (Angel One / SmartAPI)
- **How to get**: Login to your Groww trading account → API section → Generate API key
- **Format**: JWT token string
- **Current value**: See `src/config.mjs` line 6 (the long JWT string)
- ⚠️ **SECURITY**: Never commit this to git! Use environment variables in production

### GROWW_API_SECRET  
- **Description**: Your Groww API secret key
- **How to get**: Same location as API key in your Groww dashboard
- **Current value**: See `src/config.mjs` line 7 (`***REDACTED_SECRET***`)
- ⚠️ **SECURITY**: This is sensitive! Rotate if exposed

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
GROWW_API_KEY=<your_api_key_from_config>
GROWW_API_SECRET=<your_api_secret_from_config>
NODE_ENV=production
```

**Note**: Render automatically sets `PORT` and `NODE_VERSION`, so you don't need to configure those.

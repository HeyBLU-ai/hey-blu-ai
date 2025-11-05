# HeyBLU.AI Deployment & DNS Configuration Guide

**Last Updated:** January 2025  
**Purpose:** Complete reference for deploying HeyBLU.AI to Vercel with custom domain

---

## 🚨 CRITICAL: Domain Nameservers Must Be Changed at GoDaddy

**The #1 Issue:** Your domain `heyblu.ai` is registered with **GoDaddy**, not Cloudflare. Cloudflare is just managing DNS, but the nameservers are controlled by GoDaddy.

### Step 1: Change Nameservers at GoDaddy
1. **Log into GoDaddy.com**
2. **Go to "My Products" → "Domains"**
3. **Click on `heyblu.ai`**
4. **Click "DNS" or "Manage DNS"**
5. **Look for "Nameservers" section**
6. **Click "Change" or "Edit"**
7. **Select "Custom" nameservers**
8. **Replace with Vercel's nameservers:**
   - `ns1.vercel-dns.com`
   - `ns2.vercel-dns.com`
9. **Save changes**

### Step 2: Configure in Vercel
1. **Go to Vercel Dashboard → Your Project → Settings → Domains**
2. **Click "Configure Automatically" under `heyblu.ai`**
3. **Wait 5-60 minutes for DNS propagation**

---

## 📁 Project Structure

```
hey-blu-ai/
├── api/                    # Backend API functions
│   ├── ask.js             # Main rulebook API
│   ├── shorten.ts         # URL shortening
│   ├── retrieve.ts        # Shared links
│   └── data/              # Rulebook data files
├── rulebook/              # Rulebook frontend
│   └── index.html         # Advanced rulebook with league selection
├── pitchdeck/             # Pitch deck 1
├── pitchdeck2/            # Pitch deck 2  
├── pitchdeck3/            # Pitch deck 3
├── vercel.json            # Vercel configuration
└── .gitignore             # Git ignore rules
```

---

## ⚙️ Vercel Configuration

### vercel.json (Complete & Correct)
```json
{
  "version": 2,
  "builds": [
    {
      "src": "api/ask.js",
      "use": "@vercel/node",
      "config": {
        "includeFiles": ["api/data/**"]
      }
    },
    { "src": "api/shorten.ts", "use": "@vercel/node", "config": { "includeFiles": ["api/data/**"] } },
    { "src": "api/retrieve.ts", "use": "@vercel/node", "config": { "includeFiles": ["api/data/**"] } },
    { "src": "index.html", "use": "@vercel/static" },
    { "src": "manifest.json", "use": "@vercel/static" },
    { "src": "service-worker.js", "use": "@vercel/static" },
    { "src": "dist/output.css", "use": "@vercel/static" },
    { "src": "rulebook/index.html", "use": "@vercel/static" },
    { "src": "rulebook/share.html", "use": "@vercel/static" },
    { "src": "rulebook/legal.html", "use": "@vercel/static" },
    { "src": "rulebook/manifest.json", "use": "@vercel/static" },
    { "src": "rulebook/service-worker.js", "use": "@vercel/static" },
    { "src": "pitchdeck/index.html", "use": "@vercel/static" },
    { "src": "pitchdeck2/index.html", "use": "@vercel/static" },
    { "src": "pitchdeck3/index.html", "use": "@vercel/static" },
    { "src": "pitchdeck/assets/**", "use": "@vercel/static" },
    { "src": "pitchdeck/images/**", "use": "@vercel/static" },
    { "src": "vision/index.html", "use": "@vercel/static" },
    { "src": "thank-you.html", "use": "@vercel/static" },
    { "src": "images/**", "use": "@vercel/static" }
  ],
  "routes": [
    { "src": "/api/ask", "dest": "api/ask.js" },
    { "src": "/api/shorten", "dest": "api/shorten.ts" },
    { "src": "/r/(?<slug>[^/]+)", "dest": "/api/retrieve.ts?slug=$slug" },
    { "src": "/manifest.json", "dest": "/manifest.json" },
    { "src": "/service-worker.js", "dest": "/service-worker.js" },
    { "src": "/dist/output.css", "dest": "/dist/output.css" },
    { "src": "/rulebook/share.html", "dest": "/rulebook/share.html" },
    { "src": "/rulebook/legal.html", "dest": "/rulebook/legal.html" },
    { "src": "/rulebook/manifest.json", "dest": "/rulebook/manifest.json" },
    { "src": "/rulebook/service-worker.js", "dest": "/rulebook/service-worker.js" },
    { "src": "/rulebook", "dest": "/rulebook/index.html" },
    { "src": "/pitchdeck", "dest": "/pitchdeck/index.html" },
    { "src": "/pitchdeck2", "dest": "/pitchdeck2/index.html" },
    { "src": "/pitchdeck3", "dest": "/pitchdeck3/index.html" },
    { "src": "/pitchdeck/**", "dest": "/pitchdeck/$1" },
    { "src": "/vision", "dest": "/vision/index.html" },
    { "src": "/thank-you", "dest": "/thank-you.html" },
    { "src": "/", "dest": "/index.html" }
  ]
}
```

### Environment Variables Required
**Vercel Dashboard → Settings → Environment Variables:**
- `OPENAI_API_KEY` - Your OpenAI API key
- `DATABASE_URL` - PostgreSQL connection string
- `DOMAIN` - `https://heyblu.ai` (optional)

---

## 🔧 Common Issues & Solutions

### Issue 1: "Invalid Configuration" in Vercel
**Cause:** Nameservers still pointing to Cloudflare instead of Vercel  
**Solution:** Change nameservers at GoDaddy (see Step 1 above)

### Issue 2: Cloudflare Error 522 "Connection timed out"
**Cause:** Cloudflare trying to proxy traffic to old GitHub Pages  
**Solution:** Wait for DNS propagation after changing nameservers to Vercel

### Issue 3: Pitch Deck 404 Errors
**Cause:** Missing routes in vercel.json  
**Solution:** Ensure vercel.json includes all pitchdeck routes (see above)

### Issue 4: Rulebook "Something went wrong"
**Cause:** Missing environment variables or wrong API endpoint  
**Solution:** 
- Add environment variables in Vercel
- Ensure rulebook uses `/api/ask` (relative path)

### Issue 5: Old content showing
**Cause:** Browser caching  
**Solution:** Hard refresh (Ctrl+F5) or incognito mode

### Issue 6: New Pages/Directories Return 404 After Adding to vercel.json
**Cause:** Files exist locally but are not committed to git  
**Solution:** 
1. **Check if files are tracked in git:**
   ```bash
   git ls-files your-directory/
   ```
   If empty, files are not tracked.

2. **Add and commit files:**
   ```bash
   git add your-directory/
   git add vercel.json
   git commit -m "Add new page/directory"
   git push
   ```

3. **Verify deployment:** Vercel only deploys files that are in your git repository. Local-only files will never be deployed.

**Key Lesson:** Always commit new files to git before expecting them to appear on the deployed site. Vercel builds from your git repository, not your local filesystem.

---

## ✅ Testing Checklist

After deployment, test these URLs:
- [ ] `https://heyblu.ai` - Main landing page
- [ ] `https://heyblu.ai/rulebook` - Advanced rulebook with league selection
- [ ] `https://heyblu.ai/pitchdeck` - Pitch deck 1
- [ ] `https://heyblu.ai/pitchdeck2` - Pitch deck 2
- [ ] `https://heyblu.ai/pitchdeck3` - Pitch deck 3
- [ ] Ask a question in rulebook - Should work without "something went wrong"

---

## 🚫 What NOT to Do

1. **Don't edit DNS records in Cloudflare** - Change nameservers at GoDaddy instead
2. **Don't use absolute URLs** for API calls - Use relative paths like `/api/ask`
3. **Don't forget environment variables** - API won't work without them
4. **Don't test with cached browser** - Use incognito mode for testing

---

## 📞 Quick Reference

**GoDaddy:** Where domain is registered, change nameservers here  
**Cloudflare:** Currently managing DNS, will be bypassed after nameserver change  
**Vercel:** Where app is deployed, will manage DNS after nameserver change  
**GitHub:** Where code is stored, triggers Vercel deployments

**Key Files:**
- `vercel.json` - Vercel routing configuration
- `rulebook/index.html` - Advanced rulebook frontend
- `api/ask.js` - Main API endpoint

**Key URLs:**
- Vercel Dashboard: `https://vercel.com/dashboard`
- GoDaddy: `https://dcc.godaddy.com/`
- Test Domain: `https://heyblu.ai`

---

*This document should prevent future confusion and save hours of troubleshooting.*

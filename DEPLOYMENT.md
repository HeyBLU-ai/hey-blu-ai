# Deployment Guide - HeyBLU AI

**Last Updated:** April 2026  
**Purpose:** Complete reference for deploying HeyBLU AI to Vercel with custom domain

---

## 📋 Table of Contents

- [🚨 CRITICAL: DNS Configuration](#-critical-dns-configuration)
- [🏗️ Hosting Architecture](#️-hosting-architecture)
- [🚀 Deployment Process](#-deployment-process)
- [🔧 Common Issues & Troubleshooting](#-common-issues--troubleshooting)
- [⚙️ Vercel Configuration](#️-vercel-configuration)
- [📱 Mobile & Cross-Platform Issues](#-mobile--cross-platform-issues)
- [🖼️ Image Serving](#️-image-serving)
- [🗄️ Database Setup](#️-database-setup)
- [🔌 Third-Party Services](#-third-party-services)
- [🚨 Error Handling & Monitoring](#-error-handling--monitoring)
- [📋 Deployment Checklist](#-deployment-checklist)

---

## 🚨 CRITICAL: DNS Configuration

### Domain Nameservers Must Be Changed at GoDaddy

**The #1 Issue:** Your domain `heyblu.ai` is registered with **GoDaddy**, not Cloudflare. Cloudflare is just managing DNS, but the nameservers are controlled by GoDaddy.

#### Step 1: Change Nameservers at GoDaddy

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

#### Step 2: Configure in Vercel

1. **Go to Vercel Dashboard → Your Project → Settings → Domains**
2. **Click "Configure Automatically" under `heyblu.ai`**
3. **Wait 5-60 minutes for DNS propagation**

### Domain Management Reference

**GoDaddy:** Where domain is registered, change nameservers here  
**Cloudflare:** Currently managing DNS, will be bypassed after nameserver change  
**Vercel:** Where app is deployed, will manage DNS after nameserver change  
**GitHub:** Where code is stored, triggers Vercel deployments

---

## 🏗️ Hosting Architecture

### Primary Platform: Vercel

**Why Vercel?**
- Serverless functions for API endpoints
- Automatic deployments from Git
- Global CDN for fast content delivery
- Built-in HTTPS and security features
- Excellent developer experience

### Domain Management: Bluehost

**Why Bluehost?**
- Reliable domain registration
- Easy DNS management
- Cost-effective hosting
- Good customer support

### Current Setup

```
heyblu.ai (Primary Domain)
├── www.heyblu.ai (Redirect to heyblu.ai)
├── heyblu.ai/rulebook (PWA Application)
├── heyblu.ai/pitchdeck (Investor Materials)
├── heyblu.ai/use-of-funds (Financial Model)
├── heyblu.ai/field-guide (iPhone app help / print guide; old `/docs/setup/...` redirects here)
└── heyblu.ai/api/* (API Endpoints)
```

### SSL Certificate

- **Automatic**: Vercel provides free SSL certificates
- **Auto-renewal**: Certificates renew automatically
- **HTTPS Redirect**: All HTTP traffic redirects to HTTPS

---

## 🚀 Deployment Process

### 1. Vercel Deployment

#### Initial Setup

1. **Connect Repository**
   ```bash
   # Install Vercel CLI
   npm i -g vercel
   
   # Login to Vercel
   vercel login
   
   # Link project
   vercel link
   ```

2. **Configure Environment Variables**
   ```bash
   vercel env add OPENAI_API_KEY
   vercel env add DATABASE_URL
   ```

3. **Deploy**
   ```bash
   # Deploy to preview
   vercel
   
   # Deploy to production
   vercel --prod
   ```

#### Automatic Deployments

- **Main Branch**: Auto-deploys to production
- **Feature Branches**: Auto-deploys to preview URLs
- **Pull Requests**: Creates preview deployments

### 2. Manual Deployment Process

1. **Pre-deployment Checklist**
   - [ ] All tests passing
   - [ ] **All new files committed to git** (Critical: Vercel only deploys committed files)
     ```bash
     # Verify files are tracked
     git ls-files your-new-directory/
     # If empty, add and commit:
     git add your-new-directory/ vercel.json
     git commit -m "Add new feature"
     ```
   - [ ] Environment variables updated
   - [ ] Database migrations applied (if any)
   - [ ] Documentation updated

2. **Deploy Steps**
   ```bash
   # 1. Build locally
   npm run build
   npm run build:css
   
   # 2. Test locally
   npm run dev
   
   # 3. Commit and push to git (if not already done)
   git add .
   git commit -m "Deploy changes"
   git push
   
   # 4. Deploy to Vercel (or wait for auto-deploy)
   vercel --prod
   
   # 5. Verify deployment
   curl https://heyblu.ai/api/ask
   ```

### 3. CI/CD Pipeline (Optional)

GitHub Actions example:

```yaml
# .github/workflows/deploy.yml
name: Deploy to Vercel

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '18'
      - run: npm ci
      - run: npm run build
      - run: npm run build:css
      - uses: amondnet/vercel-action@v20
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.ORG_ID }}
          vercel-project-id: ${{ secrets.PROJECT_ID }}
          vercel-args: '--prod'
```

---

## 🔧 Common Issues & Troubleshooting

### Issue 1: "Invalid Configuration" in Vercel
**Cause:** Nameservers still pointing to Cloudflare instead of Vercel  
**Solution:** Change nameservers at GoDaddy (see [DNS Configuration](#-critical-dns-configuration) section)

### Issue 2: Cloudflare Error 522 "Connection timed out"
**Cause:** Cloudflare trying to proxy traffic to old hosting  
**Solution:** Wait for DNS propagation after changing nameservers to Vercel (5-60 minutes)

### Issue 3: Pitch Deck 404 Errors
**Cause:** Missing routes in vercel.json OR files not committed to git  
**Solution:** 
- Ensure vercel.json includes all pitchdeck routes (see [Vercel Configuration](#️-vercel-configuration))
- **Critical:** Verify files are committed to git - Vercel only deploys committed files
  ```bash
  git ls-files pitchdeck/  # Check if files are tracked
  git add pitchdeck/ vercel.json
  git commit -m "Add pitchdeck"
  git push
  ```

### Issue 4: Rulebook "Something went wrong"
**Cause:** Missing environment variables or wrong API endpoint  
**Solution:** 
- Add environment variables in Vercel Dashboard
- Ensure rulebook uses `/api/ask` (relative path, not absolute)

### Issue 5: Old content showing
**Cause:** Browser caching  
**Solution:** Hard refresh (Ctrl+F5 or Cmd+Shift+R) or use incognito mode

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

### Issue 7: Images Not Loading
**Cause:** External URLs or missing static asset configuration  
**Solution:** 
- Always use local images in project directory
- Ensure `vercel.json` includes static asset routing (see [Image Serving](#️-image-serving) section)

---

## ⚙️ Vercel Configuration

### vercel.json Structure

The `vercel.json` file configures builds and routes. Key sections:

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
    { "src": "index.html", "use": "@vercel/static" },
    { "src": "pitchdeck/index.html", "use": "@vercel/static" },
    { "src": "pitchdeck/images/**", "use": "@vercel/static" }
  ],
  "routes": [
    { "src": "/api/ask", "dest": "api/ask.js" },
    { "src": "/pitchdeck", "dest": "/pitchdeck/index.html" },
    { "src": "/pitchdeck/(.*)", "dest": "/pitchdeck/$1" }
  ]
}
```

### Adding New Routes

When adding a new page/directory:

1. **Add to builds:**
   ```json
   { "src": "your-directory/index.html", "use": "@vercel/static" },
   { "src": "your-directory/**", "use": "@vercel/static" }
   ```

2. **Add to routes:**
   ```json
   { "src": "/your-directory", "dest": "/your-directory/index.html" },
   { "src": "/your-directory/", "dest": "/your-directory/index.html" },
   { "src": "/your-directory/(.*)", "dest": "/your-directory/$1" }
   ```

3. **Commit to git** (see Issue 6 above)

### Environment Variables

**Vercel Dashboard → Settings → Environment Variables:**

| Variable | Description | Required |
|----------|-------------|----------|
| `OPENAI_API_KEY` | OpenAI API key for GPT-4 and embeddings | Yes |
| `DATABASE_URL` | PostgreSQL connection string | No |
| `NODE_ENV` | Environment (production/development) | Optional |

### Environment-Specific Settings

**Development:**
```env
NODE_ENV=development
VERCEL_ENV=development
```

**Production:**
```env
NODE_ENV=production
VERCEL_ENV=production
```

---

## 📱 Mobile & Cross-Platform Issues

### Critical CSS Requirements

#### Viewport Configuration
**Essential for all devices:**
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
```

#### CSS Layout Requirements
**For proper cross-platform compatibility, slides MUST include:**

```css
.slide {
    min-height: 100dvh;           /* Use dynamic viewport height */
    max-height: 100dvh;           /* Prevent overflow on mobile */
    overflow: hidden;             /* Hide scrollbars on slides */
    padding-top: env(safe-area-inset-top, 1rem);     /* iOS notch */
    padding-bottom: env(safe-area-inset-bottom, 1rem); /* iOS home bar */
}

.slide-content {
    min-height: calc(100dvh - 2rem);  /* Account for padding */
    max-height: calc(100dvh - 2rem);  /* Prevent content overflow */
    overflow-y: auto;                 /* Allow scrolling within content */
}
```

#### Mobile-Specific CSS
**Required for mobile devices:**
```css
@media (max-width: 768px) {
    .slide {
        padding: 0.5rem;
        min-height: 100dvh;
        max-height: 100dvh;
    }
    .slide-content {
        padding: 0.75rem;
        min-height: calc(100dvh - 1rem);
        max-height: calc(100dvh - 1rem);
    }
    /* Scale down large text */
    h1 { font-size: 2.5rem !important; }
    h2 { font-size: 2rem !important; }
    .text-4xl { font-size: 1.875rem !important; }
    .text-5xl { font-size: 2.25rem !important; }
}
```

### Common Mobile Issues & Solutions

**Problem**: Content cut off at top on mobile
- **Cause**: Missing `viewport-fit=cover` and safe-area padding
- **Solution**: Add `viewport-fit=cover` and `env(safe-area-inset-*)` padding

**Problem**: Unwanted scrollbars on Android
- **Cause**: Missing `overflow: hidden` on `.slide` or incorrect height constraints
- **Solution**: Ensure `.slide` has `overflow: hidden` and proper height constraints

**Problem**: Content overlapping on iOS Safari
- **Cause**: Using `100vh` instead of `100dvh` (doesn't account for browser chrome)
- **Solution**: Always use `100dvh` for dynamic viewport height

**Problem**: Text too large on mobile
- **Cause**: No responsive text scaling
- **Solution**: Add mobile-specific font-size overrides

### Testing Checklist for New Pitchdecks

- [ ] Test on iPhone Safari (iOS)
- [ ] Test on Android Chrome
- [ ] Test on Mac Safari
- [ ] Test on Windows Chrome
- [ ] Verify no content cut-off
- [ ] Verify no unwanted scrollbars
- [ ] Verify natural scrolling behavior
- [ ] Verify text scales appropriately

---

## 🖼️ Image Serving

### Common Image Problems

#### External Image URLs Not Loading
**Problem**: Images from external sources (Google Cloud Storage, etc.) may not load due to CORS restrictions or billing issues.

**Solution**: Always use local images in the project directory structure:
```html
<!-- ❌ Don't use external URLs -->
<img src="https://storage.googleapis.com/context-images/image.jpg" alt="...">

<!-- ✅ Use local images -->
<img src="images/image.jpg" alt="...">
```

#### Image Directory Structure
For pitchdecks, create a local `images/` directory:
```
pitchdeck4/
├── index.html
└── images/
    ├── image1.jpg
    └── image2.jpg
```

#### Vercel Configuration for Images
Ensure `vercel.json` includes static asset routing:
```json
{
  "builds": [
    { "src": "pitchdeck4/images/**", "use": "@vercel/static" }
  ],
  "routes": [
    { "src": "/pitchdeck4/(.*)", "dest": "/pitchdeck4/$1" }
  ]
}
```

### Image Optimization Best Practices
- Use WebP format when possible
- Compress images before adding to repository
- Use descriptive alt text for accessibility
- Test image loading in production environment

### Field guide (iPhone app help)

**Canonical public URL (use this in the iOS app):**
- `https://heyblu.ai/field-guide`

**Legacy URL** (redirects to `/field-guide`): `https://heyblu.ai/docs/setup/HeyBLU_Field_Guide.html`

**Vercel:** `vercel.json` includes `field-guide/index.html` and `field-guide/**` in builds, plus routes for `/field-guide`. The `docs/setup/**` build remains for the small redirect stub only.

**Deploy checklist for updates:**
1. Edit **`field-guide/index.html`** in this repo (canonical hosted copy).
2. Optionally keep `docs/setup/HeyBLU_Field_Guide.html` in sync only if you still want a redirect stub at the old path (currently it redirects to `/field-guide`).
3. **Commit and push** — Vercel only deploys tracked files (same rule as images and new pages).
4. After deploy, verify `https://heyblu.ai/field-guide` in **Safari** and **Chrome** on iPhone (layout scrolls; Print uses system sheet).

**CDN note:** The field guide loads Tailwind, Phosphor icons, and Google Fonts from the network. The device needs connectivity for styling and icons; print/PDF still works once the page has loaded.

---

## 🗄️ Database Setup

### PostgreSQL Configuration

#### Production Database (Recommended: Supabase)

1. **Create Supabase Project**
   - Go to [supabase.com](https://supabase.com)
   - Create new project
   - Note connection string

2. **Database Schema**
   ```sql
   -- Create question_logs table
   CREATE TABLE question_logs (
     id SERIAL PRIMARY KEY,
     question TEXT NOT NULL,
     answer TEXT NOT NULL,
     rule_ref VARCHAR(50),
     rulebook VARCHAR(100),
     created_at TIMESTAMP DEFAULT NOW()
   );
   
   -- Create feedback table
   CREATE TABLE feedback (
     id SERIAL PRIMARY KEY,
     question TEXT NOT NULL,
     answer TEXT NOT NULL,
     feedback_type VARCHAR(20) NOT NULL,
     feedback_text TEXT,
     created_at TIMESTAMP DEFAULT NOW()
   );
   ```

3. **Connection String**
   ```env
   DATABASE_URL=postgresql://postgres:[password]@db.[project-ref].supabase.co:5432/postgres
   ```

#### Local Development Database

```bash
# Using Docker
docker run --name heyblu-postgres \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=heyblu_dev \
  -p 5432:5432 \
  -d postgres:15

# Connection string
DATABASE_URL=postgresql://postgres:password@localhost:5432/heyblu_dev
```

---

## 🔌 Third-Party Services

### OpenAI API

**Setup:**
1. Create account at [platform.openai.com](https://platform.openai.com)
2. Generate API key
3. Add to Vercel environment variables

**Usage Limits:**
- Monitor usage in OpenAI dashboard
- Set up billing alerts
- Consider rate limiting for production

### Formspree (Form Handling)

**Setup:**
1. Create account at [formspree.io](https://formspree.io)
2. Create form endpoint
3. Update form action URLs

**Configuration:**
```html
<!-- Update form action in rulebook/index.html -->
<form action="https://formspree.io/f/YOUR_FORM_ID" method="POST">
```

#### Homepage beta / TestFlight application (`index.html` `#beta`)

The main site’s **Apply for Beta / Request TestFlight Access** form posts to the same Formspree endpoint as some other forms (`f/mjkrezok`). Submissions include a hidden field **`_subject`** set to `Beta / TestFlight application` so you can filter or route in the Formspree dashboard.

**Fields submitted (names):** `first_name`, `last_name`, `email`, `city`, `state`, `league_or_team` (optional), multiple `role` (max 3 enforced in the browser), `age_group`, `field_description` (only when age group is HS+ / College / Pro / Adult Amateur), and required acknowledgements `ack_iphone_ios`, `ack_tripod`, `ack_outdoor` (value `yes`).

**Deploy:** Changes live in `index.html` only—no `vercel.json` change needed. Commit and push; Vercel redeploys automatically.

**Homepage images (`/images/`):** The marketing homepage references assets under `images/` (for example hero photography and Field Notes thumbnails). `vercel.json` already includes `{ "src": "images/**", "use": "@vercel/static" }` and routes `/images/(.*)` — **add any new image files to git** or they will 404 in production (see [Image Serving](#️-image-serving)).

**Post-deploy:** Submit a test from `https://heyblu.ai/#beta` and confirm the entry appears in Formspree with the expected subject and fields. Optionally spot-check `https://heyblu.ai/#field-notes` (Substack links) and hero imagery on `/`.

### Beehiiv (Email Marketing)

**Integration:**
- Collect emails through the homepage beta signup and other forms (export or sync as needed)
- Export to Beehiiv for newsletter campaigns
- Track conversion rates

---

## 🚨 Error Handling & Monitoring

### Troubleshooting 404 Errors for New Pages

**Common Cause:** Files exist locally but are not committed to git.

Vercel builds from your git repository, not your local filesystem. If you add a new directory or page:

1. **Verify files are tracked in git:**
   ```bash
   git ls-files your-directory/
   ```
   If this returns nothing, your files are not tracked.

2. **Add and commit files:**
   ```bash
   git add your-directory/
   git add vercel.json  # If you updated routes
   git commit -m "Add new page"
   git push
   ```

3. **Wait for Vercel deployment** (usually 1-2 minutes after push)

4. **Verify in deployment:**
   - Check Vercel dashboard for successful deployment
   - Verify files appear in the deployment logs
   - Test the URL after deployment completes

**Key Lesson:** Always commit new files to git before expecting them on the deployed site. Local-only files will never appear in production.

### Vercel Function Logs

```bash
# View function logs
vercel logs

# View specific function logs
vercel logs api/ask
```

### Custom Error Tracking

```javascript
// Example: Enhanced error logging
function logError(error, context) {
  console.error('Error:', error);
  console.error('Context:', context);
  
  // Send to external service (e.g., Sentry)
  if (typeof Sentry !== 'undefined') {
    Sentry.captureException(error, { extra: context });
  }
}
```

### Health Checks

```javascript
// api/health.js
export default function handler(req, res) {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.VERCEL_GIT_COMMIT_SHA || 'unknown'
  });
}
```

### Monitoring Checklist

- [ ] Check Vercel dashboard daily
- [ ] Monitor OpenAI API usage
- [ ] Review error logs weekly
- [ ] Test core functionality monthly
- [ ] Update dependencies quarterly

### Emergency Procedures

1. **Site Down**
   - Check Vercel status page
   - Review function logs
   - Rollback if necessary

2. **API Issues**
   - Check OpenAI API status
   - Verify environment variables
   - Test with curl/Postman

3. **Database Issues**
   - Check Supabase status
   - Review connection logs
   - Restore from backup if needed

---

## 📋 Deployment Checklist

### Pre-Deployment
- [ ] Code reviewed and tested
- [ ] **All new files committed to git** (Vercel only deploys committed files)
  ```bash
  git ls-files your-new-directory/  # Verify files are tracked
  git add your-new-directory/ vercel.json
  git commit -m "Add new feature"
  git push
  ```
- [ ] Environment variables updated
- [ ] Database migrations applied
- [ ] Documentation updated
- [ ] Performance tested

### Post-Deployment
- [ ] Site loads correctly
- [ ] API endpoints responding
- [ ] Forms submitting properly
- [ ] PWA installing correctly
- [ ] Mobile responsiveness verified
- [ ] Analytics tracking working

### Testing Checklist

After deployment, test these URLs:
- [ ] `https://heyblu.ai` - Main landing page; confirm hero and Field Notes images load; scroll to **Apply for Beta** (`#beta`) and submit a test Formspree entry
- [ ] `https://heyblu.ai/#field-notes` - Field Notes section (Substack article cards)
- [ ] `https://heyblu.ai/rulebook` - Advanced rulebook with league selection
- [ ] `https://heyblu.ai/pitchdeck` - Pitch deck 1
- [ ] `https://heyblu.ai/pitchdeck2` - Pitch deck 2
- [ ] `https://heyblu.ai/pitchdeck3` - Pitch deck 3
- [ ] `https://heyblu.ai/use-of-funds` - Financial model
- [ ] `https://heyblu.ai/field-guide` - Field guide (mobile Safari & Chrome; print/PDF)
- [ ] Ask a question in rulebook - Should work without "something went wrong"

---

## 🚫 What NOT to Do

1. **Don't edit DNS records in Cloudflare** - Change nameservers at GoDaddy instead
2. **Don't use absolute URLs** for API calls - Use relative paths like `/api/ask`
3. **Don't forget environment variables** - API won't work without them
4. **Don't test with cached browser** - Use incognito mode for testing
5. **Don't expect local-only files to deploy** - Always commit to git first

---

## 📞 Quick Reference

**Key Files:**
- `vercel.json` - Vercel routing configuration
- `index.html` - Marketing homepage; beta / TestFlight application form at `#beta` (Formspree)
- `rulebook/index.html` - Advanced rulebook frontend
- `api/ask.js` - Main API endpoint
- `field-guide/index.html` - Hosted field guide for the iPhone app (`https://heyblu.ai/field-guide`)

**Key URLs:**
- Vercel Dashboard: `https://vercel.com/dashboard`
- GoDaddy: `https://dcc.godaddy.com/`
- Test Domain: `https://heyblu.ai`

---

**Need Help?** Contact the development team or check the [Architecture Guide](ARCHITECTURE.md) for technical details.

*This document consolidates all deployment lessons learned to prevent future confusion and save hours of troubleshooting.*

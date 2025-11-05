# Deployment Guide - HeyBLU AI

This guide covers the complete deployment process for HeyBLU AI, including hosting architecture, DNS configuration, and third-party service integration.

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
└── heyblu.ai/api/* (API Endpoints)
```

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

### 2. Domain Configuration

#### DNS Settings (Bluehost)

**A Records:**
```
Type: A
Name: @
Value: 76.76.19.61 (Vercel IP)
TTL: 3600

Type: A  
Name: www
Value: 76.76.19.61 (Vercel IP)
TTL: 3600
```

**CNAME Records:**
```
Type: CNAME
Name: api
Value: cname.vercel-dns.com
TTL: 3600
```

#### Vercel Domain Configuration

1. **Add Domain in Vercel Dashboard**
   - Go to Project Settings → Domains
   - Add `heyblu.ai`
   - Add `www.heyblu.ai`

2. **Configure Redirects**
   ```json
   // vercel.json
   {
     "redirects": [
       {
         "source": "/www.heyblu.ai/(.*)",
         "destination": "https://heyblu.ai/$1",
         "permanent": true
       }
     ]
   }
   ```

### 3. SSL Certificate

- **Automatic**: Vercel provides free SSL certificates
- **Auto-renewal**: Certificates renew automatically
- **HTTPS Redirect**: All HTTP traffic redirects to HTTPS

## 🔧 Environment Configuration

### Production Environment Variables

```env
# Required
OPENAI_API_KEY=sk-...
DATABASE_URL=postgresql://...

# Optional
NODE_ENV=production
VERCEL_ENV=production
```

### Environment-Specific Settings

#### Development
```env
NODE_ENV=development
VERCEL_ENV=development
```

#### Preview
```env
NODE_ENV=preview
VERCEL_ENV=preview
```

#### Production
```env
NODE_ENV=production
VERCEL_ENV=production
```

## 📊 Monitoring & Analytics

### Vercel Analytics

- **Performance Metrics**: Core Web Vitals
- **Function Metrics**: API response times
- **Error Tracking**: Function errors and logs
- **Usage Analytics**: Page views and user behavior

### Custom Analytics

```javascript
// Example: Custom event tracking
function trackEvent(eventName, properties) {
  if (typeof gtag !== 'undefined') {
    gtag('event', eventName, properties);
  }
}

// Usage
trackEvent('rule_question_asked', {
  league: 'MLB',
  question_type: 'infield_fly'
});
```

## 🔄 CI/CD Pipeline

### GitHub Actions (Optional)

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

### Manual Deployment Process

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

### Beehiiv (Email Marketing)

**Integration:**
- Collect emails through waitlist form
- Export to Beehiiv for newsletter campaigns
- Track conversion rates

## 📱 Mobile Responsiveness & Cross-Platform Issues

### Critical CSS Requirements for All Devices

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

#### Common Mobile Issues & Solutions

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

## 🖼️ Image Serving Issues & Solutions

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

## 🔒 Security Considerations

### API Security

1. **CORS Configuration**
   ```javascript
   // Only allow specific origins
   const allowedOrigins = [
     'https://heyblu.ai',
     'https://www.heyblu.ai'
   ];
   ```

2. **Rate Limiting**
   ```javascript
   // Implement rate limiting
   const rateLimit = new Map();
   const RATE_LIMIT = 100; // requests per hour
   ```

3. **Input Validation**
   ```javascript
   // Validate all inputs
   if (!question || typeof question !== 'string') {
     return res.status(400).json({ error: 'Invalid question' });
   }
   ```

### Environment Security

- **Never commit secrets** to version control
- **Use Vercel's environment variables** for sensitive data
- **Rotate API keys** regularly
- **Monitor access logs** for suspicious activity

## 📈 Performance Optimization

### Vercel Optimizations

1. **Function Configuration**
   ```json
   // vercel.json
   {
     "functions": {
       "api/ask.js": {
         "maxDuration": 30
       }
     }
   }
   ```

2. **Caching Strategy**
   ```javascript
   // Set appropriate cache headers
   res.setHeader('Cache-Control', 'public, max-age=3600');
   ```

3. **CDN Configuration**
   - Static assets served from Vercel's CDN
   - Images optimized automatically
   - Gzip compression enabled

### Database Optimization

1. **Connection Pooling**
   ```javascript
   // Use connection pooling
   const pool = new Pool({
     connectionString: process.env.DATABASE_URL,
     max: 20,
     idleTimeoutMillis: 30000,
     connectionTimeoutMillis: 2000,
   });
   ```

2. **Query Optimization**
   ```sql
   -- Add indexes for common queries
   CREATE INDEX idx_question_logs_created_at ON question_logs(created_at);
   CREATE INDEX idx_question_logs_rulebook ON question_logs(rulebook);
   ```

## 🔄 Backup & Recovery

### Database Backups

1. **Automated Backups** (Supabase)
   - Daily automated backups
   - Point-in-time recovery
   - Cross-region replication

2. **Manual Backups**
   ```bash
   # Export database
   pg_dump $DATABASE_URL > backup_$(date +%Y%m%d).sql
   ```

### Code Backups

- **Git Repository**: Primary backup
- **Vercel Deployments**: Automatic deployment history
- **Local Backups**: Regular local repository clones

## 🚀 Rollback Procedures

### Vercel Rollback

```bash
# List deployments
vercel ls

# Rollback to previous deployment
vercel rollback [deployment-url]
```

### Database Rollback

```bash
# Restore from backup
psql $DATABASE_URL < backup_20240101.sql
```

## 📞 Support & Maintenance

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

---

**Need Help?** Contact the development team or check the [Architecture Guide](ARCHITECTURE.md) for technical details.

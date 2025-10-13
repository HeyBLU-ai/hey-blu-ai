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
   
   # 3. Deploy to Vercel
   vercel --prod
   
   # 4. Verify deployment
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

## 🚨 Error Handling & Monitoring

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

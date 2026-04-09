# Setup docs (heyblu.ai marketing repo)

## Field guide — canonical URL

**Use this everywhere (iOS app, links, docs):**

`https://heyblu.ai/field-guide`

The full HTML lives in this repo at **`field-guide/index.html`** (not under `docs/setup/`).  
`docs/setup/HeyBLU_Field_Guide.html` is only a **redirect** to `/field-guide` for old links.

Swift example:

```swift
static let fieldGuideURL = URL(string: "https://heyblu.ai/field-guide")!
```

After editing the guide, **commit and push** so Vercel deploys. See **DEPLOYMENT.md** → *Field guide (iPhone app help)*.

## Vercel

- `field-guide/**` and routes `/field-guide` in `vercel.json`
- `docs/setup/**` kept for redirect stub only

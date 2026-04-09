# Setup docs (hosted on heyblu.ai)

Static files in this folder are deployed with the HeyBLU marketing site (Vercel).

## Field guide (iOS app)

| Resource | URL |
|----------|-----|
| **Field guide (HTML)** | `https://heyblu.ai/docs/setup/HeyBLU_Field_Guide.html` |

Use this URL in the iPhone app for `UIApplication.shared.open(url)` or `SFSafariViewController`:

```swift
static let fieldGuideURL = URL(string: "https://heyblu.ai/docs/setup/HeyBLU_Field_Guide.html")!
```

The canonical styled HTML should live in this repo at `docs/setup/HeyBLU_Field_Guide.html` (copy from the app repo’s `docs/setup/` when updated). After changes, **commit and push** so Vercel deploys the new file.

**Note:** The guide uses Tailwind CDN, Phosphor (`@phosphor-icons/web@2.1.1`), and Google Fonts — the device needs network for those assets unless you vendor or inline them.

**Mobile:** The HTML uses a single-column layout on small screens (`md:` breakpoint) so Safari and Chrome on iPhone are readable; the troubleshooting table scrolls horizontally if needed. `viewport-fit=cover` and safe-area padding help on notched devices.

## Vercel

- `vercel.json` includes `docs/setup/**` in builds and a route for `/docs/setup/(.*)`.
- See **deployment.md** → *Setup docs & app help* for the full deploy and test checklist.

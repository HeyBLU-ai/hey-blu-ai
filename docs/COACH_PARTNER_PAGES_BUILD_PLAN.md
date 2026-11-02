# Coach and partner pages — build plan

**Written:** 2026-11-01
**Status:** Proposed working plan. Terms (discount %, commission %, prices) are placeholders to be set by Rob and JP; nothing here is a decision. Change anything.
**Related:** `heyblu-hq/docs/strategy/AFFILIATE_PILOT_PLAN.md` (the offer and the 60-day test), `heyblu-hq/docs/strategy/CHANNEL_SURFACE.md`, `BLU-App/docs/pilot-beta/BACKLOG.md` (sales attribution item).
**Standards that apply:** `docs/HEYBLU_BRAND_GUIDE.md` and `docs/HEYBLU_BEST_PRACTICES.md` (read before editing any HTML here).

## Goal

Give pitching coaches, coach companies, and facilities a way to recommend HeyBLU to their families and earn a share of each subscriber, and make every download and subscriber traceable to the partner who sent it. The same pages double as lead capture for coaches who find us through a podcast or an ad (and later `/pitchdesign`).

## What exists today (checked in this repo)

| Thing | State | Why it matters |
| --- | --- | --- |
| `/coaches` | **Refreshed 2026-11-01:** TestFlight button replaced with the App Store link (own `ct=Coaches` token), prices now read from `pricing-config.js`, "HeyBLU Coach (soon)" removed from the pricing box, and a short "A program for coaches" section added (email link, no commission details). | Done. The existing "HeyBLU Coach, coming soon" waitlist block was left alone because the coach dashboard is still a planned item. |
| `/pitchdesign` | A built React app ("Pitch Design Lab, Powered by HeyBLU"), committed here as built output. The source is its own repo, `robreganSF/pitch-design-lab` (local: `GitHub_Projects/pitch-design-lab`), clean and pushed as of 2026-11-01. Its `index.html` loads none of the site scripts (no PostHog, no UTM capture). | **Parked.** Not a priority; the work is saved in both repos. Later ideas are at the bottom. |
| `utm-capture.js` | Stores `utm_*`, `fbclid`, `gclid` for 30 days and registers them as PostHog properties on every event. Deliberate exception for `utm_source=app`: do not remove. | A partner link that uses `utm_campaign=<partner_id>` is tracked in PostHog with **no code change**. |
| `site-download.js` | Builds the App Store link. A page sets `window.HEYBLU_DOWNLOAD_CT` before it loads to give itself its own campaign token (`/softball` does this). | The same mechanism gives every partner their own `ct` token. |
| App Store link | `https://apps.apple.com/app/apple-store/id6479205383?pt=126940554&ct=<token>&mt=8` | The `ct` token is the only thing that survives the web-to-App Store hop. |
| Lead capture | None. No form, no endpoint. `api/` has serverless functions and a `pg` database client used by the rulebook tools. | A lead form needs a small new endpoint (or a third-party list). |
| `vercel.json` | Every page needs three entries: a `builds` line, a `routes` line, and (for the no-cache headers) membership in the two page-list regexes. Redirects with path parameters are supported. | A new page that skips these will 404. |

## The code system (what "codes" means here)

One identifier, used in five places. Keep it simple: the **partner ID** is everything.

| # | Piece | Format and rules | Where it lives |
| --- | --- | --- | --- |
| 1 | **Partner ID** | Lowercase letters, digits, hyphens, 3–24 characters, never reused. Examples: `jsmith`, `acme-pitching`. | The partner registry (a spreadsheet for the pilot): partner ID, name, type (coach, company, facility, creator), terms, status, W-9 on file, date added. |
| 2 | **Partner link** | `heyblu.ai/c/<partner_id>`. A redirect expands it to `/coach?ref=<partner_id>&utm_source=partner&utm_medium=coach&utm_campaign=<partner_id>`. Short enough for a text message and a QR code. | `vercel.json` redirect (one rule for all partners). |
| 3 | **App Store campaign token** | `Coach-<partner_id>`, 40 characters or fewer. | Set by the `/coach` page through `HEYBLU_DOWNLOAD_CT`. App Store Connect → App Analytics → Campaigns then shows downloads **per partner**, free. This counts downloads only, not who subscribed. |
| 4 | **Typed code in the app** | The same partner ID, typed on a "Have a coach code?" screen before the paywall. Sets a RevenueCat subscriber attribute `partner_id` and a PostHog person property. | **BLU-App change** (separate repo and test cycle; this is the sales-attribution item in the backlog). It is the only deterministic link from a partner to a paying subscriber, and the fallback for people who search the App Store by name and lose the token. |
| 5 | **Customer discount** | **One shared** Apple offer code for all partners (for example "first year at X% off"), not one per partner. Apple allows only 10 active offers per subscription product, and an offer code does not write a partner ID onto the transaction. | App Store Connect. Attribution comes from #3 and #4, never from the offer. Offers are a fixed price per territory, so a list-price change means new offers. |

**Payout rule for the pilot (proposed):** pay only on a paid, non-refunded subscription whose RevenueCat record carries the partner's `partner_id` (typed code), after the refund hold. Use `Coach-<id>` download counts as a cross-check, not as payment proof. A spreadsheet ledger is enough for ten partners: partner ID, RevenueCat transaction ID, plan, amount paid, refunded (y/n), hold ends, commission, paid date.

**Partner's own account:** complimentary, tagged `store = "promotional"` in RevenueCat and excluded from revenue and trial counts (already the rule in the affiliate plan).

**Open check before anything is promised to customers:** in the App Store Connect sandbox, confirm how an offer code interacts with the 14-day trial (does the discounted year start after the trial, or replace it?). The affiliate plan assumes the trial stays.

## Pages

Each page serves one audience and leads with benefits (`HEYBLU_BEST_PRACTICES.md` §3). No tripod or setup copy; that stays in `/field-guide`.

1. **`/coaches` (refreshed).** What a coach gets, plus one short line that a coach program exists. Parents and students never see program or commission language. When the lead form exists, point the "Ask about the coach program" email link at it.
2. **`/coaches/partners` (new, coach-facing only, not linked from parent pages): the program page.** Audience: coaches, coach companies, facilities. Benefit first ("earn on every family you send"), how it works in three lines, the apply form, a link to partner terms. No eyebrow kicker above the H1.
''s code in large type ("Enter this code when you open the app"). Display names come from a small public `partners.json` containing only ID and display name; commission terms never go in it. Unknown or missing `ref` falls back to a plain HeyBLU page with no partner name.
4. **`/pitchdesign`:** parked, see the end of this file.

## Tracking

- **Web funnel per partner is free.** `utm-capture.js` already adds `utm_campaign=<partner_id>` to every PostHog event, including `app_store_click`. No script change needed.
- **Add one event, `partner_landing`,** fired by `/coach` with `ref`. It is the denominator for click-through per partner.
- **Downloads per partner:** App Store Connect → App Analytics → Campaigns (token `Coach-<id>`). Apple can lag by a day or more and may hide small counts.
- **Subscribers per partner:** RevenueCat attribute `partner_id`, then a staging column and a monthly statement query in `heyblu-analytics` once the in-app code exists. Per that repo's rules, comped accounts are excluded and the 15% Apple commission comes from the seed, not from RevenueCat.

## Pitch Design Lab (`/pitchdesign`): parked, ideas for later

It is a built app, so edits to the built `index.html` here are overwritten on the next build. Make any change in the `pitch-design-lab` repo's `index.html` template, then rebuild and copy the output here.

1. Load `posthog-init.js`, `utm-capture.js`, and the Vercel insights script, the same as other pages. Without these there is no data on who visits or from where.
2. Add one soft lead capture: email plus a role choice (coach, parent, player) on a natural moment, such as saving or sharing a pitch design. Do not gate the tool itself.
3. Add a "Powered by HeyBLU" link to `/coaches` (not straight to the App Store), tagged `utm_source=pitchdesign&utm_medium=tool`, so a coach lands on the partner pitch and the lead is attributable.
4. Audit what its existing feedback `mailto:` and any footer link point to, and make them consistent.

## Lead capture (shared by `/coaches`, `/coaches/partners`, `/pitchdesign`)

- **Endpoint:** new `api/lead.js`, same CORS and sanitize pattern as `api/submit-feedback.js`. Stores email, role, source page, `utm_*` from `HEYBLU_CAMPAIGN`, timestamp. Fires a PostHog event on success. Rate-limit and a honeypot field against spam.
- **Storage:** a `leads` table in the existing Postgres, or a third-party list (the site already links the HeyBLU Substack). Decide before building; the table is the lowest-effort option.
- **Privacy:** add the lead use to `/privacy`. The pitch tool will be used by kids, so the form copy addresses coaches and parents only and collects nothing from players.

## Build order (one change at a time, test after each)

| # | Change | Owner | Done when |
| --- | --- | --- | --- |
| 1 | `vercel.json` redirect `/c/:id` → `/coach?ref=:id&utm_*`, and the `builds`, `routes`, and header-regex entries for `/coach` and `/coaches/partners`. | Rob / agent | `heyblu.ai/c/test` redirects and the placeholder page loads. |
| 2 | `/coach` page: reads `ref`, sets `HEYBLU_DOWNLOAD_CT = 'Coach-<id>'`, shows the code, fires `partner_landing`. | Rob / agent | A test link shows the App Store button with `ct=Coach-test` and PostHog shows `utm_campaign=test` on `app_store_click`. |
| 3 | `/coaches` refresh: App Store CTA, prices from config. | Agent | **Done 2026-11-01.** |
| 4 | `api/lead.js` plus a shared form snippet. | Rob / agent | A test submission lands in the table and PostHog. |
| 5 | `/coaches/partners` program page with the apply form. | Rob / agent | A submission arrives as a lead with the source tagged. |
| 6 | `/pitchdesign`: parked. | n/a | n/a |
| 7 | `partners.json` and the registry sheet, first test partner (a coach Rob knows). | Rob / JP | The partner's real link works end to end. |
| 8 | In-app code screen (**BLU-App**, separate change and device test). | Rob | A typed code appears as a RevenueCat attribute on a sandbox purchase. |
| 9 | Shared discount offer in App Store Connect, including the trial check. | Rob | A sandbox redemption prices as intended. |
| 10 | App Store custom product pages: **Coach** and **Softball**, each with its own `ct`. The site passes the page's `ppid` to the App Store link (small addition to `site-download.js`). The same pages are the landing targets for Apple Search Ads. | Rob | Downloads from `/coach` show in the Coach page's analytics. |
| 11 | `heyblu-analytics`: `partner_id` into staging, a statement query, comped-account exclusion. | Agent in that repo | A test purchase appears in the monthly statement. |

Steps 1–5 need no app release and can run in parallel with step 8's design. Do not hand a live partner link to a real coach until step 8 works on a real device; before that, `ct` counts are the only evidence.

## Compliance notes

- **Endorsement disclosure.** Rob
- **Site standards.** Do not invent features or tell users how to market HeyBLU on public pages. Suggested "assign two bullpens" language for coaches goes in an optional downloadable coach kit, only with Rob's explicit approval. Use baseball words, not app terms, on new pages. Never write "not for live games."
- **Partner terms.** A one-page agreement (commission basis, refund hold, W-9, no misleading claims, no paid ads on HeyBLU's brand terms) before the first payout. Have counsel read it.

## Decisions needed

1. Customer discount and partner commission (the Oct 23 plan says 20% off and 25% of the discounted annual; Rob's variant is 10% off and a 20% referral fee).
2. Pay on monthly subscribers or annual only.
3. Lead storage: `leads` table in the existing Postgres or a third-party list.
4. Launch prices: the discount offer and the `/coaches` copy depend on the new list price.
5. Whether the optional coach kit (homework and report templates) is allowed to exist under the site standards.

## Not in this plan

A partner portal or dashboard, per-partner customer pages with custom copy, third-party deep-link attribution (Branch or AppsFlyer) as an upgrade to the typed code, and a customer referral program. Add them only if the first partners show the loop works.

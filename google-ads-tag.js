// Google tag (gtag.js) — Google Ads account 534-835-4776 (heyblu-analytics tracking).
// Base tag only. Google Ads' "Outbound click" conversion goal auto-detects clicks on
// links to other domains (e.g. the App Store) once this base tag is present — no
// per-click custom event code needed. See ads.google.com > Tools > Data manager > Google tag.
window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
// The Google Ads account default is "not consented," and this site has no cookie-consent
// banner to override it — so every hit was being silently suppressed (2026-08-29 debugging,
// confirmed via Tag Assistant showing zero hits despite the tag loading correctly). Setting
// an explicit default here tells the tag to proceed as consented. heyblu.ai is a US product
// not targeting EU/UK users, so this is the pragmatic default absent a formal CMP.
gtag('consent', 'default', {
    'ad_storage': 'granted',
    'analytics_storage': 'granted',
    'ad_user_data': 'granted',
    'ad_personalization': 'granted'
});
gtag('js', new Date());
gtag('config', 'AW-18414770701');

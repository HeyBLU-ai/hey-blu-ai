// Server-side Meta Conversions API relay for the App Store badge tap.
//
// Why this exists: the browser pixel's AppStoreClick event races the redirect to the
// App Store (worst inside Facebook's in-app browser), and Meta credits ads only when the
// event carries the ad-click identifier (fbc). This endpoint receives one small beacon per
// tap and forwards a single server event to Meta with fbc/fbp/IP/user agent attached.
//
// Dedup: the browser pixel event uses the same event name ("AppStoreClick") and the same
// eventID, so Meta merges the two copies into one.
//
// Secrets: META_CAPI_TOKEN must be set in Vercel env vars. Never log or echo it.
// Optional: META_CAPI_TEST_CODE (Events Manager > Test Events) routes events to the
// Test Events tab only; remove it for live use.

const PIXEL_ID = '1739023907419263';
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v23.0';
const ALLOWED_HOST = /(^|\.)heyblu\.ai$|^localhost$|\.vercel\.app$/i;
const EVENT_ID_RE = /^ask_[a-z0-9]{6,40}$/i;

function hostOf(value) {
  try {
    return new URL(value).hostname;
  } catch (e) {
    return '';
  }
}

function clean(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function parseBody(req) {
  const body = req.body;
  if (!body) return {};
  if (typeof body === 'object') return body;
  try {
    return JSON.parse(body);
  } catch (e) {
    return {};
  }
}

export default async function handler(req, res) {
  // Always answer quickly with no body: this is fire-and-forget from the browser.
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const token = process.env.META_CAPI_TOKEN;
  if (!token) {
    res.status(204).end();
    return;
  }

  const origin = req.headers.origin || req.headers.referer || '';
  if (origin && !ALLOWED_HOST.test(hostOf(origin))) {
    res.status(204).end();
    return;
  }

  const body = parseBody(req);
  const eventId = clean(body.event_id, 60);
  if (!eventId || !EVENT_ID_RE.test(eventId)) {
    res.status(204).end();
    return;
  }

  const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || req.headers['x-real-ip'] || undefined;
  const userAgent = clean(req.headers['user-agent'], 500);

  const userData = {};
  if (ip) userData.client_ip_address = ip;
  if (userAgent) userData.client_user_agent = userAgent;
  const fbc = clean(body.fbc, 300);
  const fbp = clean(body.fbp, 100);
  if (fbc) userData.fbc = fbc;
  if (fbp) userData.fbp = fbp;

  const event = {
    event_name: 'AppStoreClick',
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: 'website',
    event_source_url: clean(body.url, 500) || undefined,
    user_data: userData,
    custom_data: {
      content_name: clean(body.location, 100),
      path: clean(body.path, 100),
    },
  };

  const payload = { data: [event] };
  if (process.env.META_CAPI_TEST_CODE) {
    payload.test_event_code = process.env.META_CAPI_TEST_CODE;
  }

  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PIXEL_ID}/events?access_token=${encodeURIComponent(token)}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      // Log status and Meta's error text only. The request URL carries the token, so never log it.
      const text = await resp.text();
      console.error('meta-capi: Meta responded', resp.status, text.slice(0, 300));
    }
  } catch (e) {
    console.error('meta-capi: request failed', e && e.name);
  }

  res.status(204).end();
}

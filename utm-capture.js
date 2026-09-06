(function () {
    // Ad-click identifiers (utm_*, fbclid, gclid) are otherwise lost the moment a
    // visitor lands — nothing else on the site reads them. This stores them
    // (last-touch, 30-day window) and registers them as PostHog super properties
    // so every event this visit — including app_store_click in site-analytics.js —
    // automatically carries campaign context, with no changes needed there.
    var STORAGE_KEY = 'heyblu_campaign';
    var MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

    var TRACKED_PARAMS = [
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
        'fbclid', 'gclid'
    ];

    function readIncoming() {
        var params;
        try {
            params = new URLSearchParams(window.location.search);
        } catch (e) {
            return null;
        }
        var found = {};
        var any = false;
        TRACKED_PARAMS.forEach(function (key) {
            var val = params.get(key);
            if (val) {
                found[key] = val;
                any = true;
            }
        });
        return any ? found : null;
    }

    function readStored() {
        try {
            var raw = window.localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            if (!parsed || !parsed.savedAt || (Date.now() - parsed.savedAt) > MAX_AGE_MS) {
                return null;
            }
            return parsed.data || null;
        } catch (e) {
            return null;
        }
    }

    function store(data) {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
                savedAt: Date.now(),
                data: data
            }));
        } catch (e) {
            /* localStorage unavailable (private mode, quota) — degrade silently */
        }
    }

    // In-app links (utm_source=app) are tagged so app-driven visits can be told apart from ad
    // traffic. They must not overwrite a stored ad click: someone the ad found, who installed
    // and later tapped "get a tripod" in the app, was still found by the ad. Plain last-touch
    // would hand that credit to the app and understate ad performance.
    function isAppSourced(data) {
        return !!data && data.utm_source === 'app';
    }

    var incoming = readIncoming();
    var stored = readStored();
    var campaign = incoming || stored;

    var wouldClobberAdClick = isAppSourced(incoming) && stored && !isAppSourced(stored);

    if (incoming && !wouldClobberAdClick) {
        store(incoming);
    }

    if (campaign && window.posthog && typeof window.posthog.register === 'function') {
        window.posthog.register(campaign);
    }

    // Exposed so other scripts (e.g. site-analytics.js) can read the resolved
    // campaign context without re-parsing localStorage themselves.
    window.HEYBLU_CAMPAIGN = campaign || null;
})();

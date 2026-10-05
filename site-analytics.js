(function () {
    window.va = window.va || function () {
        (window.vaq = window.vaq || []).push(arguments);
    };

    function trackEvent(name, data) {
        try {
            var payload = { name: name };
            if (data && typeof data === 'object') {
                payload.data = data;
            }
            window.va('event', payload);
        } catch (e) {
            /* analytics should never block UX */
        }
    }

    function pagePath() {
        return window.location.pathname || '/';
    }

    function onReady(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn);
        } else {
            fn();
        }
    }

    function readCookie(name) {
        var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
        return match ? decodeURIComponent(match[1]) : '';
    }

    // Sends the tap to our own server, which relays it to Meta's Conversions API with the
    // ad-click identifier (fbc) attached. sendBeacon is queued by the browser and survives
    // the hand-off to the App Store, unlike a normal pixel request.
    function sendServerAppStoreClick(eventId, location) {
        try {
            var fbc = readCookie('_fbc');
            var fbclid = window.HEYBLU_CAMPAIGN && window.HEYBLU_CAMPAIGN.fbclid;
            if (!fbc && fbclid) {
                fbc = 'fb.1.' + Date.now() + '.' + fbclid;
            }
            var body = JSON.stringify({
                event_id: eventId,
                location: location,
                path: pagePath(),
                url: window.location.href,
                fbc: fbc,
                fbp: readCookie('_fbp')
            });
            var sent = false;
            if (navigator.sendBeacon) {
                sent = navigator.sendBeacon('/api/meta-capi', new Blob([body], { type: 'application/json' }));
            }
            if (!sent && window.fetch) {
                window.fetch('/api/meta-capi', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: body,
                    keepalive: true
                });
            }
        } catch (e) {
            /* analytics should never block UX */
        }
    }

    onReady(function () {
        var appStoreLinks = document.querySelectorAll('#app-store-download-link, a.app-store-download-link');
        appStoreLinks.forEach(function (link) {
            link.addEventListener('click', function () {
                var location = link.getAttribute('data-cta') || link.id || 'unlabeled';
                trackEvent('app_store_click', {
                    path: pagePath(),
                    href: link.href || '',
                    location: location,
                    utm: window.HEYBLU_DOWNLOAD_UTM || ''
                });
                // One shared ID per physical tap. Meta uses event name + eventID to merge
                // duplicates: this page's pixel event, the same event re-sent by Meta's hosted
                // Conversions API, and our own server copy (/api/meta-capi) below.
                var appStoreEventId = 'ask_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
                sendServerAppStoreClick(appStoreEventId, location);
                if (typeof window.fbq === 'function') {
                    window.fbq('trackCustom', 'AppStoreClick', {
                        content_name: location,
                        path: pagePath()
                    }, { eventID: appStoreEventId });
                }
                if (typeof window.ttq === 'object' && typeof window.ttq.track === 'function') {
                    window.ttq.track('Download', {
                        content_name: location,
                        content_type: 'app_store',
                        path: pagePath()
                    });
                }
                if (typeof window.gtag === 'function') {
                    // Google's automatic "outbound click" detection does not fire for this
                    // link despite every relevant setting being enabled (confirmed via direct
                    // network inspection, 2026-08-29) — so this conversion action
                    // ("Outbound click (1)") is reported explicitly instead, the same way
                    // Meta/TikTok are above. Links open in a new tab (target="_blank"), so
                    // there is no navigation to delay and no event_callback is needed.
                    window.gtag('event', 'conversion', {
                        'send_to': 'AW-18414770701/NUe9CPrRpuocEI207MxE',
                        'value': 1.0,
                        'currency': 'USD'
                    });
                }
                if (window.posthog && typeof window.posthog.capture === 'function') {
                    window.posthog.capture('app_store_click', {
                        path: pagePath(),
                        href: link.href || '',
                        location: location
                    });
                }
            });
        });

        var testFlightLink = document.getElementById('testflight-invite-link');
        if (testFlightLink) {
            testFlightLink.addEventListener('click', function () {
                trackEvent('testflight_click', {
                    path: pagePath(),
                    href: testFlightLink.href || ''
                });
            });
        }

        var pricingToggle = document.getElementById('pricing-billing-toggle');
        if (pricingToggle) {
            pricingToggle.addEventListener('click', function () {
                window.setTimeout(function () {
                    var billing = pricingToggle.getAttribute('aria-checked') === 'true' ? 'annual' : 'monthly';
                    trackEvent('pricing_billing_toggle', {
                        path: pagePath(),
                        billing: billing
                    });
                }, 0);
            });
        }

        document.addEventListener('heyblu:waitlist-success', function () {
            trackEvent('waitlist_submit', { path: pagePath() });
        });

        var scrollMarks = [25, 50, 75, 100];
        var scrollFired = {};
        var scrollTicking = false;
        function checkScrollDepth() {
            var docHeight = document.documentElement.scrollHeight - window.innerHeight;
            if (docHeight <= 0) return;
            var scrollTop = window.pageYOffset || document.documentElement.scrollTop;
            var pct = Math.round((scrollTop / docHeight) * 100);
            scrollMarks.forEach(function (mark) {
                if (pct >= mark && !scrollFired[mark]) {
                    scrollFired[mark] = true;
                    trackEvent('scroll_depth', { path: pagePath(), percent: mark });
                }
            });
        }
        window.addEventListener('scroll', function () {
            if (scrollTicking) return;
            scrollTicking = true;
            window.requestAnimationFrame(function () {
                checkScrollDepth();
                scrollTicking = false;
            });
        }, { passive: true });
    });
})();

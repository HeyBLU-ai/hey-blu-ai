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

    onReady(function () {
        var appStoreLinks = document.querySelectorAll('#app-store-download-link, a.app-store-download-link');
        appStoreLinks.forEach(function (link) {
            link.addEventListener('click', function () {
                trackEvent('app_store_click', {
                    path: pagePath(),
                    href: link.href || '',
                    location: link.getAttribute('data-cta') || link.id || 'unlabeled',
                    utm: window.HEYBLU_DOWNLOAD_UTM || ''
                });
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

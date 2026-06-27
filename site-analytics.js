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
        var appStoreLink = document.getElementById('app-store-download-link');
        if (appStoreLink) {
            appStoreLink.addEventListener('click', function () {
                trackEvent('app_store_click', {
                    path: pagePath(),
                    href: appStoreLink.href || '',
                    utm: window.HEYBLU_DOWNLOAD_UTM || ''
                });
            });
        }

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
    });
})();

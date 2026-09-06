/**
 * Monthly / annual billing toggle for /pricing — reads HEYBLU_PRICING from pricing-config.js.
 * When showPublicAmounts is false (App Store price A/B), hides the toggle and dollar amounts.
 */
(function () {
    var DEFAULT_PRICING = {
        trialDays: 14,
        showPublicAmounts: true,
        monthlyUSD: 12.99,
        annualUSD: 79.99,
        launchRateLabel: '',
        currencySymbol: '$',
        annualSavingsPercent: function () {
            return 50;
        },
        formatUSD: function (amount) {
            return this.currencySymbol + amount.toFixed(2);
        },
        annualPerMonthUSD: function () {
            return this.annualUSD / 12;
        }
    };

    function init() {
        var cfg = window.HEYBLU_PRICING || DEFAULT_PRICING;

        var toggleWrap = document.getElementById('pricing-billing-toggle-wrap');
        var toggle = document.getElementById('pricing-billing-toggle');
        var knob = document.getElementById('pricing-toggle-knob');
        var labelMonthly = document.getElementById('pricing-label-monthly');
        var labelAnnual = document.getElementById('pricing-label-annual');
        var priceDisplay = document.getElementById('pro-price-display');
        var priceNote = document.getElementById('pro-price-note');
        var priceFootnote = document.getElementById('pro-price-footnote');
        var launchBadge = document.getElementById('pricing-launch-badge');
        var savingsBadge = document.getElementById('pricing-annual-savings');
        if (!priceDisplay) return;

        if (!cfg.showPublicAmounts) {
            if (toggleWrap) toggleWrap.classList.add('hidden');
            if (launchBadge) {
                launchBadge.classList.add('hidden');
                launchBadge.setAttribute('hidden', '');
            }
            if (priceFootnote) priceFootnote.classList.add('hidden');
            priceDisplay.textContent = 'Monthly or annual';
            if (priceNote) {
                priceNote.textContent = 'Current price shown in the app when you subscribe.';
            }
            return;
        }

        if (toggleWrap) toggleWrap.classList.remove('hidden');
        if (launchBadge && cfg.launchRateLabel) {
            launchBadge.textContent = cfg.launchRateLabel;
            launchBadge.classList.remove('hidden');
            launchBadge.removeAttribute('hidden');
        }
        if (priceFootnote) {
            if (cfg.launchRateLabel) {
                priceFootnote.classList.remove('hidden');
            } else {
                priceFootnote.classList.add('hidden');
            }
        }
        if (!toggle) return;

        var isAnnual = false;
        var savingsPct = cfg.annualSavingsPercent();

        if (savingsBadge && savingsPct > 0) {
            savingsBadge.textContent = 'Save ' + savingsPct + '%';
        }

        function setBilling(annual) {
            isAnnual = annual;
            toggle.setAttribute('aria-checked', annual ? 'true' : 'false');
            toggle.classList.toggle('bg-blue-600', annual);
            toggle.classList.toggle('bg-gray-200', !annual);
            if (knob) {
                knob.style.transform = annual ? 'translateX(1.5rem)' : 'translateX(0)';
            }
            if (labelMonthly) {
                labelMonthly.classList.toggle('text-gray-900', !annual);
                labelMonthly.classList.toggle('text-gray-500', annual);
            }
            if (labelAnnual) {
                labelAnnual.classList.toggle('text-gray-900', annual);
                labelAnnual.classList.toggle('text-gray-500', !annual);
            }
            if (annual) {
                priceDisplay.innerHTML =
                    cfg.formatUSD(cfg.annualUSD) +
                    '<span class="text-lg font-semibold text-gray-600">/yr</span>' +
                    '<span class="text-lg font-semibold text-gray-600" aria-hidden="true">*</span>';
                if (priceNote) {
                    priceNote.textContent =
                        'About ' + cfg.formatUSD(cfg.annualPerMonthUSD()) + '/mo billed annually';
                }
            } else {
                priceDisplay.innerHTML =
                    cfg.formatUSD(cfg.monthlyUSD) +
                    '<span class="text-lg font-semibold text-gray-600">/mo</span>' +
                    '<span class="text-lg font-semibold text-gray-600" aria-hidden="true">*</span>';
                if (priceNote) priceNote.textContent = '';
            }
        }

        toggle.addEventListener('click', function (event) {
            event.preventDefault();
            setBilling(!isAnnual);
        });

        if (labelMonthly) {
            labelMonthly.style.cursor = 'pointer';
            labelMonthly.addEventListener('click', function () {
                setBilling(false);
            });
        }
        if (labelAnnual) {
            labelAnnual.style.cursor = 'pointer';
            labelAnnual.addEventListener('click', function () {
                setBilling(true);
            });
        }

        setBilling(false);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

/**
 * Monthly / annual billing toggle for /pricing — reads HEYBLU_PRICING from pricing-config.js.
 */
(function () {
    var DEFAULT_PRICING = {
        trialDays: 14,
        monthlyUSD: 4.99,
        annualUSD: 49.99,
        launchRateLabel: 'Launch pricing',
        currencySymbol: '$',
        annualSavingsPercent: function () {
            var monthly = this.monthlyUSD * 12;
            if (monthly <= 0) return 0;
            return Math.round((1 - this.annualUSD / monthly) * 100);
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

        var toggle = document.getElementById('pricing-billing-toggle');
        var knob = document.getElementById('pricing-toggle-knob');
        var labelMonthly = document.getElementById('pricing-label-monthly');
        var labelAnnual = document.getElementById('pricing-label-annual');
        var priceDisplay = document.getElementById('pro-price-display');
        var priceNote = document.getElementById('pro-price-note');
        var savingsBadge = document.getElementById('pricing-annual-savings');
        if (!toggle || !priceDisplay) return;

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
                    '<span class="text-lg font-semibold text-gray-600">/yr</span>';
                if (priceNote) {
                    priceNote.textContent =
                        'About ' + cfg.formatUSD(cfg.annualPerMonthUSD()) + '/mo billed annually';
                }
            } else {
                priceDisplay.innerHTML =
                    cfg.formatUSD(cfg.monthlyUSD) +
                    '<span class="text-lg font-semibold text-gray-600">/mo</span>';
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

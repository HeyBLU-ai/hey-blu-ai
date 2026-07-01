/**
 * Client-side search for /faq — scores question titles first, then answers.
 */
(function () {
    var STOP_WORDS = {
        a: 1, an: 1, the: 1, is: 1, it: 1, i: 1, do: 1, to: 1, at: 1, on: 1, in: 1,
        or: 1, and: 1, for: 1, of: 1, my: 1, can: 1, why: 1, what: 1, how: 1, does: 1,
        are: 1, be: 1, with: 1, that: 1, this: 1, when: 1, if: 1, about: 1, get: 1, use: 1,
        will: 1, should: 1, have: 1, has: 1, was: 1, were: 1, from: 1, not: 1, did: 1, we: 1,
        you: 1, your: 1, there: 1, their: 1, they: 1, them: 1, than: 1, then: 1, into: 1,
        much: 1, also: 1, all: 1, any: 1, every: 1, only: 1, just: 1, need: 1, work: 1, works: 1
    };

    /** Extra terms that should match a search token (field-language, not substring noise). */
    var TOKEN_ALIASES = {
        wifi: ['wifi', 'wi fi', 'hotspot', 'hotspots', 'router', 'network', 'local network'],
        hotspot: ['hotspot', 'hotspots', 'wifi', 'wi fi', 'router', 'android'],
        connect: ['connect', 'connection', 'connected', 'pair', 'pairing', 'join'],
        calibrate: ['calibrate', 'calibration', 'calibrating', '9 zone', '9-zone', 'grid'],
        tripod: ['tripod', 'mount', 'mounted', 'mounting', 'height', 'mid zone', 'mid-zone', 'camera height', 'lens height'],
        height: ['height', 'tripod', 'mid zone', 'mid-zone', 'camera', 'lens', 'top of zone', 'bottom of zone'],
        price: ['price', 'pricing', 'cost', 'costs', 'subscription', 'trial', '4.99', '49.99'],
        subscription: ['subscription', 'subscribe', 'trial', 'pricing', 'cost'],
        report: ['report', 'reports', 'summary', 'spreadsheet', 'export', 'session'],
        android: ['android', 'hotspot'],
        ipad: ['ipad', 'second device', 'second phone', 'command center', 'follow game'],
        accuracy: ['accuracy', 'accurate', 'inch', 'inches', 'miss'],
        speed: ['speed', 'mph', 'velocity', 'velo'],
        swing: ['swing', 'swings', 'swung', 'batter'],
        zone: ['zone', 'strike zone', 'resize zone'],
        red: ['red', 'lines', 'framing', 'frame', 'framed'],
        lines: ['lines', 'red', 'framing', 'frame'],
        track: ['track', 'tracked', 'tracking', 'calls', 'call'],
        pitch: ['pitch', 'pitches', 'bullpen'],
        battery: ['battery', 'charge', 'charged', 'power'],
        pro: ['pro', 'pro max', 'measuring tape', 'distance', 'lens height']
    };

    function escapeHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function normalize(text) {
        return String(text || '')
            .toLowerCase()
            .replace(/[\u2010-\u2015\u2212]/g, '-')
            .replace(/wi[\s-]*fi/g, 'wifi')
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function slugify(text, idx) {
        var slug = normalize(text).replace(/\s+/g, '-').replace(/^-|-$/g, '').slice(0, 72);
        return slug ? 'faq-' + slug : 'faq-item-' + idx;
    }

    function parseTokens(rawQuery) {
        var normalized = normalize(rawQuery);
        if (!normalized) return [];

        var all = normalized.split(' ').filter(function (t) {
            return t.length >= 2;
        });
        if (!all.length) return [];

        var meaningful = all.filter(function (t) {
            return !STOP_WORDS[t];
        });

        return meaningful.length ? meaningful : all;
    }

    function aliasForms(token) {
        var forms = [token];
        var aliases = TOKEN_ALIASES[token];
        if (aliases) {
            aliases.forEach(function (a) {
                if (forms.indexOf(a) === -1) forms.push(a);
            });
        }
        return forms;
    }

    function containsPhrase(text, phrase) {
        return normalize(text).indexOf(normalize(phrase)) !== -1;
    }

    function tokenMatchesField(token, question, answer, keywords) {
        var forms = aliasForms(token);
        var fields = [question, answer, keywords];

        for (var f = 0; f < fields.length; f += 1) {
            var field = normalize(fields[f]);
            if (!field) continue;

            for (var i = 0; i < forms.length; i += 1) {
                var form = forms[i];
                if (!form) continue;

                if (form.indexOf(' ') !== -1) {
                    if (field.indexOf(form) !== -1) return { matched: true, weight: f === 0 ? 3 : f === 2 ? 2 : 1 };
                    continue;
                }

                var padded = ' ' + field + ' ';
                if (padded.indexOf(' ' + form + ' ') !== -1) {
                    return { matched: true, weight: f === 0 ? 3 : f === 2 ? 2 : 1 };
                }

                if (form.length >= 5 && field.indexOf(form) !== -1) {
                    return { matched: true, weight: f === 0 ? 2 : 1 };
                }
            }
        }

        return { matched: false, weight: 0 };
    }

    function scoreItem(item, tokens, rawQuery) {
        var score = 0;
        var nq = normalize(item.q);
        var phrase = normalize(rawQuery);

        if (phrase.length >= 3) {
            if (containsPhrase(item.q, rawQuery)) score += 120;
            else if (containsPhrase(item.keywords, rawQuery)) score += 90;
            else if (containsPhrase(item.a, rawQuery)) score += 45;
        }

        for (var t = 0; t < tokens.length; t += 1) {
            var match = tokenMatchesField(tokens[t], item.q, item.a, item.keywords);
            if (!match.matched) return 0;

            if (match.weight >= 3) score += 40;
            else if (match.weight === 2) score += 24;
            else score += 10;
        }

        return score;
    }

    function init() {
        var input = document.getElementById('faq-search-input');
        var results = document.getElementById('faq-search-results');
        if (!input || !results) return;

        var items = [];
        var usedIds = {};

        document.querySelectorAll('.faq-item').forEach(function (el, idx) {
            var questionEl = el.querySelector('.faq-button span');
            var answerEl = el.querySelector('.faq-button + div');
            if (!questionEl || !answerEl) return;

            var id = el.id;
            if (!id || id.indexOf('faq-search-') === 0) {
                id = slugify(questionEl.textContent, idx);
                var base = id;
                var n = 2;
                while (usedIds[id]) {
                    id = base + '-' + n;
                    n += 1;
                }
                el.id = id;
            }
            usedIds[id] = true;

            items.push({
                id: id,
                q: questionEl.textContent.trim(),
                a: answerEl.textContent.trim().replace(/\s+/g, ' '),
                keywords: el.getAttribute('data-keywords') || ''
            });
        });

        function expandItem(id) {
            var target = document.getElementById(id);
            if (!target) return;

            var faqBtn = target.querySelector('.faq-button');
            var content = faqBtn && faqBtn.nextElementSibling;
            if (!faqBtn || !content) return;

            var section = target.closest('section');
            if (section) {
                section.querySelectorAll('.faq-button').forEach(function (btn) {
                    if (btn !== faqBtn) {
                        btn.setAttribute('aria-expanded', 'false');
                        btn.nextElementSibling.classList.add('hidden');
                    }
                });
            }

            faqBtn.setAttribute('aria-expanded', 'true');
            content.classList.remove('hidden');

            if (history.replaceState) {
                history.replaceState(null, '', '#' + id);
            } else {
                location.hash = id;
            }

            requestAnimationFrame(function () {
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        }

        function search(rawQuery) {
            var tokens = parseTokens(rawQuery);
            if (!tokens.length || normalize(rawQuery).length < 2) return [];

            var scored = [];
            items.forEach(function (item) {
                var score = scoreItem(item, tokens, rawQuery);
                if (score > 0) scored.push({ item: item, score: score });
            });

            scored.sort(function (a, b) {
                return b.score - a.score;
            });

            return scored
                .filter(function (row) {
                    return row.score >= 20;
                })
                .map(function (row) {
                    return row.item;
                });
        }

        function render(matches) {
            results.innerHTML = '';
            var query = input.value.trim();
            if (!query) {
                results.classList.add('hidden');
                results.setAttribute('aria-hidden', 'true');
                return;
            }

            if (normalize(query).length < 2) {
                results.innerHTML = '<p class="px-4 py-3 text-sm text-slate-500">Type at least 2 characters.</p>';
                results.classList.remove('hidden');
                results.setAttribute('aria-hidden', 'false');
                return;
            }

            if (!matches.length) {
                results.innerHTML =
                    '<p class="px-4 py-3 text-sm text-slate-600">No matches. Try <strong>hotspot</strong>, <strong>calibrate</strong>, <strong>red lines</strong>, or <strong>pricing</strong>. Or open the <a href="/field-guide#fix-a-problem" class="text-blue-600 font-medium underline">Field Guide</a>.</p>';
                results.classList.remove('hidden');
                results.setAttribute('aria-hidden', 'false');
                return;
            }

            var list = document.createElement('ul');
            list.className = 'divide-y divide-slate-200';

            matches.slice(0, 8).forEach(function (item) {
                var li = document.createElement('li');
                var link = document.createElement('button');
                link.type = 'button';
                link.className = 'block w-full text-left px-4 py-3 hover:bg-slate-50 text-sm';
                link.innerHTML = '<span class="font-semibold text-slate-900">' + escapeHtml(item.q) + '</span>';
                link.addEventListener('click', function () {
                    expandItem(item.id);
                    results.classList.add('hidden');
                    results.setAttribute('aria-hidden', 'true');
                    input.blur();
                });
                li.appendChild(link);
                list.appendChild(li);
            });

            results.appendChild(list);
            results.classList.remove('hidden');
            results.setAttribute('aria-hidden', 'false');
        }

        input.addEventListener('input', function () {
            render(search(input.value));
        });

        input.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') {
                input.value = '';
                render([]);
                input.blur();
                return;
            }
            if (event.key === 'Enter') {
                event.preventDefault();
                var matches = search(input.value);
                if (matches.length) {
                    expandItem(matches[0].id);
                    results.classList.add('hidden');
                    results.setAttribute('aria-hidden', 'true');
                }
            }
        });

        document.addEventListener('click', function (event) {
            if (event.target === input || results.contains(event.target)) return;
            results.classList.add('hidden');
            results.setAttribute('aria-hidden', 'true');
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

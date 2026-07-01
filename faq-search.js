/**
 * Client-side search for /faq — indexes accordion Q&A and jumps to matches.
 */
(function () {
    function escapeHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function init() {
        var input = document.getElementById('faq-search-input');
        var results = document.getElementById('faq-search-results');
        if (!input || !results) return;

        var items = [];
        document.querySelectorAll('.faq-item').forEach(function (el, idx) {
            var questionEl = el.querySelector('.faq-button span');
            var answerEl = el.querySelector('.faq-button + div');
            if (!questionEl || !answerEl) return;

            var id = el.id;
            if (!id) {
                id = 'faq-search-' + idx;
                el.id = id;
            }

            items.push({
                id: id,
                q: questionEl.textContent.trim(),
                a: answerEl.textContent.trim().replace(/\s+/g, ' ')
            });
        });

        function openItem(id) {
            var target = document.getElementById(id);
            if (!target) return;
            var faqBtn = target.querySelector('.faq-button');
            if (faqBtn && faqBtn.getAttribute('aria-expanded') !== 'true' && typeof window.toggleFaq === 'function') {
                window.toggleFaq(faqBtn);
            }
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        function render(matches) {
            results.innerHTML = '';
            var query = input.value.trim();
            if (!query) {
                results.classList.add('hidden');
                results.setAttribute('aria-hidden', 'true');
                return;
            }

            if (!matches.length) {
                results.innerHTML =
                    '<p class="px-4 py-3 text-sm text-slate-600">No matches. Try the <a href="/field-guide#fix-a-problem" class="text-blue-600 font-medium underline">Field Guide</a> or email <a href="mailto:support@heyblu.ai" class="text-blue-600 font-medium underline">support@heyblu.ai</a>.</p>';
                results.classList.remove('hidden');
                results.setAttribute('aria-hidden', 'false');
                return;
            }

            var list = document.createElement('ul');
            list.className = 'divide-y divide-slate-200';

            matches.slice(0, 10).forEach(function (item) {
                var li = document.createElement('li');
                var link = document.createElement('button');
                link.type = 'button';
                link.className = 'block w-full text-left px-4 py-3 hover:bg-slate-50 text-sm';
                link.innerHTML = '<span class="font-semibold text-slate-900">' + escapeHtml(item.q) + '</span>';
                link.addEventListener('click', function () {
                    openItem(item.id);
                    results.classList.add('hidden');
                    results.setAttribute('aria-hidden', 'true');
                });
                li.appendChild(link);
                list.appendChild(li);
            });

            results.appendChild(list);
            results.classList.remove('hidden');
            results.setAttribute('aria-hidden', 'false');
        }

        input.addEventListener('input', function () {
            var query = input.value.trim().toLowerCase();
            if (!query) {
                render([]);
                return;
            }
            var words = query.split(/\s+/).filter(Boolean);
            var matches = items.filter(function (item) {
                var haystack = (item.q + ' ' + item.a).toLowerCase();
                return words.every(function (word) {
                    return haystack.indexOf(word) !== -1;
                });
            });
            render(matches);
        });

        input.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') {
                input.value = '';
                render([]);
                input.blur();
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

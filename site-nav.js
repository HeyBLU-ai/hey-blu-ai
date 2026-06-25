(function () {
    var header = document.getElementById('heyblu-site-header');
    if (!header) return;

    var isHome = window.location.pathname === '/' || window.location.pathname === '/index.html';

    function link(href) {
        if (href.charAt(0) === '#') return isHome ? href : '/' + href;
        return href;
    }

    var items = [
        { href: '#features', label: 'Features' },
        { href: '#how-it-works', label: 'How It Works' },
        { href: '#playbook', label: 'Use Cases' },
        { href: '/pricing', label: 'Pricing' },
        { href: '/about', label: 'About' },
        { href: '/faq', label: 'FAQ' },
        { href: '/field-guide', label: 'Field Guide' },
        { href: '#field-notes', label: 'Field Notes' }
    ];

    var desktopLinks = items.map(function (item) {
        return '<a href="' + link(item.href) + '" class="text-gray-700 hover:text-blue-600 font-medium transition">' + item.label + '</a>';
    }).join('');

    var mobileLinks = items.map(function (item) {
        return '<a href="' + link(item.href) + '" class="block py-2 px-4 text-gray-700 hover:bg-gray-100 rounded">' + item.label + '</a>';
    }).join('');

    header.innerHTML =
        '<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">' +
            '<div class="flex justify-between items-center py-4">' +
                '<a href="/" class="flex items-center space-x-3">' +
                    '<img src="/images/HeyBLU%20-%20black-blue%20vector%20logo5.svg" alt="HeyBLU" class="h-10 md:h-13 w-auto max-w-[200px]" loading="eager" fetchpriority="high">' +
                '</a>' +
                '<nav class="hidden md:flex items-center space-x-6" aria-label="Main">' +
                    desktopLinks +
                    '<a href="' + link('#beta') + '" class="bg-blue-600 text-white font-bold py-2 px-6 rounded-lg hover:bg-blue-700 transition transform hover:scale-105">Join Waitlist</a>' +
                '</nav>' +
                '<button type="button" id="menu-btn" class="md:hidden text-gray-900 hover:text-blue-600" aria-expanded="false" aria-controls="mobile-menu" aria-label="Open menu">' +
                    '<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">' +
                        '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>' +
                    '</svg>' +
                '</button>' +
            '</div>' +
            '<div id="mobile-menu" class="hidden md:hidden pb-4 space-y-2">' +
                mobileLinks +
                '<a href="' + link('#beta') + '" class="block py-2 px-4 text-gray-700 hover:bg-gray-100 rounded">Join Waitlist</a>' +
            '</div>' +
        '</div>';

    var menuBtn = document.getElementById('menu-btn');
    var mobileMenu = document.getElementById('mobile-menu');
    if (menuBtn && mobileMenu) {
        menuBtn.addEventListener('click', function () {
            var open = mobileMenu.classList.toggle('hidden');
            menuBtn.setAttribute('aria-expanded', open ? 'false' : 'true');
        });
        mobileMenu.querySelectorAll('a').forEach(function (anchor) {
            anchor.addEventListener('click', function () {
                mobileMenu.classList.add('hidden');
                menuBtn.setAttribute('aria-expanded', 'false');
            });
        });
    }
})();

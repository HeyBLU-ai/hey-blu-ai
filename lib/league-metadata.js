/**
 * Per-league display metadata for citations and disclaimer links.
 * Keyed by DB slug. websiteUrl is null when no official public URL is known.
 */
export const LEAGUE_METADATA = {
  mlb: {
    citationLabel: 'MLB',
    websiteUrl: 'https://mktg.mlbstatic.com/mlb/official-information/2025-official-baseball-rules.pdf',
    linkText: 'MLB Official Rules',
  },
  'little-league': {
    citationLabel: 'Little League',
    websiteUrl: 'https://www.littleleague.org/playing-rules/',
    linkText: 'Little League Official Rules',
  },
  usssa: {
    citationLabel: 'USSSA',
    websiteUrl: 'https://www.usssabaseball.org/images/USSSA_National_By-Laws5-16-2025.pdf',
    linkText: 'USSSA Baseball Rules',
  },
  'mill-valley-aaa': {
    citationLabel: 'Mill Valley AAA',
    websiteUrl: 'https://www.littleleague.org/playing-rules/',
    linkText: 'Little League Official Rules (with local modifications)',
  },
  bamsbl: {
    citationLabel: 'BAMSBL',
    websiteUrl: null,
    linkText: null,
  },
};

/**
 * @param {string|null|undefined} slug
 * @returns {{ citationLabel: string|null, websiteUrl: string|null, linkText: string|null }}
 */
export function getLeagueMetadata(slug) {
  if (!slug) return { citationLabel: null, websiteUrl: null, linkText: null };
  return LEAGUE_METADATA[slug] ?? { citationLabel: null, websiteUrl: null, linkText: null };
}

/**
 * Short label for "The Book" citations (e.g. "MLB Official Rule 6.01").
 *
 * @param {string|null|undefined} slug
 * @param {string|null|undefined} displayName
 */
export function citationLabelFor(slug, displayName) {
  const meta = getLeagueMetadata(slug);
  if (meta.citationLabel) return meta.citationLabel;
  const name = (displayName ?? '').trim();
  if (!name) return 'Official';
  if (/mlb/i.test(name)) return 'MLB';
  if (/usssa/i.test(name)) return 'USSSA';
  if (/little league/i.test(name)) return 'Little League';
  return name.split(/\s+/)[0];
}

import { Client } from 'pg';

function normalizeQuestion(q) {
  if (!q || typeof q !== 'string') return '';
  return q
    .trim()
    .toLowerCase()
    .replace(/[?!.,;:'"()[\]{}/\\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveLeagueSlug(league) {
  const value = (league || '').toLowerCase().trim();
  if (value === 'bamsbl') return 'bamsbl';
  if (value === 'little league' || value === 'little league international') return 'little-league';
  if (value === 'mill valley aaa' || value === 'mill valley') return 'mill-valley-aaa';
  if (value === 'usssa' || value === 'usssa baseball') return 'usssa';
  if (value === 'mlb' || value === 'mlb official rules of baseball') return 'mlb';
  return value;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { question, answer, league, feedback } = req.body;
  if (!feedback) {
    return res.status(400).json({ error: 'Feedback is required' });
  }
  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: 'Missing database connection' });
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    await client.query(
      'INSERT INTO feedback (question, answer, league, feedback, created_at) VALUES ($1, $2, $3, $4, NOW())',
      [question || '', answer || '', league || '', feedback]
    );
    let cacheDeleted = 0;
    if (feedback === 'negative' && question && league) {
      const leagueSlug = resolveLeagueSlug(league);
      const normalizedQuestion = normalizeQuestion(question);
      const deleted = await client.query(`
        DELETE FROM verified_answer_cache vac
        USING rulebook_versions rv, leagues l
        WHERE vac.rulebook_version_id = rv.id
          AND rv.league_id = l.id
          AND rv.status = 'active'
          AND vac.league_slug = $1
          AND l.slug = $1
          AND vac.normalized_question = $2
      `, [leagueSlug, normalizedQuestion]);
      cacheDeleted = deleted.rowCount;
    }
    await client.end();
    return res.status(200).json({ ok: true, cacheDeleted });
  } catch (err) {
    try { await client.end(); } catch {}
    return res.status(500).json({ error: 'Failed to save feedback' });
  }
} 
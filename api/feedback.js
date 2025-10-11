import { Client } from 'pg';

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
    await client.end();
    return res.status(200).json({ ok: true });
  } catch (err) {
    try { await client.end(); } catch {}
    return res.status(500).json({ error: 'Failed to save feedback' });
  }
} 
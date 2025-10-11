import pg from 'pg';
const { Client } = pg;

const withCors = (handler: any) => async (req: any, res: any) => {
  const origin = req.headers.origin || '';
  if (
    origin === 'https://heyblu.ai' ||
    origin === 'https://www.heyblu.ai' ||
    origin.endsWith('.vercel.app')
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  return handler(req, res);
};

// Generate a random slug
const generateSlug = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

const extractRuleRef = (sourceText: string): string => {
  // Try to extract the rule citation from the new answer format (second line)
  // Looks for a rule number pattern like 5.02(a) on the second line
  const lines = sourceText.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length >= 2) {
    const match = lines[1].match(/([0-9]+\.[0-9]+[a-z]?)/i);
    if (match && match[1]) {
      return match[1];
    }
  }
  // Fallback: try to find in the whole answer
  const match = sourceText.match(/([0-9]+\.[0-9]+[a-z]?)/i);
  if (match && match[1]) {
    return match[1];
  }
  return '';
};

const handler = async (req: any, res: any) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { rule_id, rulebook, source_text, question } = req.body;

  if (!rulebook || !source_text) {
    return res.status(400).json({ error: "Missing required fields: rulebook, source_text" });
  }

  // Use rule_id if provided, otherwise generate a descriptive one
  const finalRuleId = rule_id || `Shared Question - ${new Date().toISOString().split('T')[0]}`;
  const ruleRef = extractRuleRef(source_text);

  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    return res.status(500).json({ error: "Database configuration missing" });
  }

  const client = new Client({ connectionString: DATABASE_URL });

  try {
    await client.connect();
    
    // Generate a unique slug
    let slug: string = '';
    let isUnique = false;
    let attempts = 0;
    
    while (!isUnique && attempts < 10) {
      slug = generateSlug();
      const existing = await client.query('SELECT slug FROM shared_links WHERE slug = $1', [slug]);
      if (existing.rowCount === 0) {
        isUnique = true;
      } else {
        attempts++;
      }
    }

    if (!isUnique) {
      throw new Error('Could not generate unique slug');
    }

    // Insert the new link with rule_ref and question
    await client.query(
      'INSERT INTO shared_links (slug, rule_id, rulebook, source_text, created_at, rule_ref, question) VALUES ($1, $2, $3, $4, NOW(), $5, $6)',
      [slug, finalRuleId, rulebook, source_text, ruleRef, question || '']
    );

    await client.end();

    const short_url = `https://heyblu.ai/r/${slug}`;
    return res.status(200).json({ short_url });

  } catch (err: any) {
    console.error('SHORTEN ERROR:', err.message);
    try { await client.end(); } catch {}
    return res.status(500).json({ error: "Failed to create short link" });
  }
};

export default withCors(handler);


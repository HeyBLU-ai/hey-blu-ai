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

// Security: Sanitize input strings
const sanitizeInput = (input: any, maxLength: number = 5000): string => {
  if (!input || typeof input !== 'string') {
    return '';
  }
  // Trim and limit length
  let sanitized = input.trim().slice(0, maxLength);
  // Remove null bytes and other control characters (except newlines and tabs)
  sanitized = sanitized.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
  return sanitized;
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

  // Security: Validate and sanitize inputs
  if (!rulebook || typeof rulebook !== 'string') {
    return res.status(400).json({ error: "Missing or invalid rulebook field" });
  }
  if (!source_text || typeof source_text !== 'string') {
    return res.status(400).json({ error: "Missing or invalid source_text field" });
  }

  // Security: Sanitize all inputs
  const sanitizedRulebook = sanitizeInput(rulebook, 100);
  const sanitizedSourceText = sanitizeInput(source_text, 5000);
  const sanitizedQuestion = question ? sanitizeInput(question, 1000) : '';
  const sanitizedRuleId = rule_id ? sanitizeInput(rule_id, 200) : `Shared Question - ${new Date().toISOString().split('T')[0]}`;
  
  const ruleRef = sanitizeInput(extractRuleRef(sanitizedSourceText), 50);

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

    // Security: Insert sanitized data
    await client.query(
      'INSERT INTO shared_links (slug, rule_id, rulebook, source_text, created_at, rule_ref, question) VALUES ($1, $2, $3, $4, NOW(), $5, $6)',
      [slug, sanitizedRuleId, sanitizedRulebook, sanitizedSourceText, ruleRef, sanitizedQuestion]
    );

    await client.end();

    const short_url = `https://heyblu.ai/r/${slug}`;
    return res.status(200).json({ short_url });

  } catch (err: any) {
    // Security: Log full error details server-side but don't expose to client
    console.error('SHORTEN ERROR:', err);
    console.error('Error details:', err.message);
    console.error('Stack trace:', err.stack);
    try { await client.end(); } catch {}
    // Security: Don't expose internal error details to client
    return res.status(500).json({ error: "Failed to create short link" });
  }
};

export default withCors(handler);


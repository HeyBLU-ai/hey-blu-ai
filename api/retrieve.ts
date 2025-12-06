import pg from 'pg';
const { Client } = pg;

// Security: Validate slug format
const validateSlug = (slug: any): string | null => {
  if (!slug || typeof slug !== 'string') {
    return null;
  }
  // Only allow alphanumeric characters, 8 characters long
  if (!/^[a-zA-Z0-9]{8}$/.test(slug)) {
    return null;
  }
  return slug;
};

export default async function handler(req: any, res: any) {
  const { slug } = req.query;
  const DATABASE_URL = process.env.DATABASE_URL;

  // Security: Validate slug format
  const validatedSlug = validateSlug(slug);
  if (!validatedSlug) {
    return res.status(400).json({ error: 'Invalid slug format.' });
  }

  if (!DATABASE_URL) {
    return res.status(500).json({ error: 'Database configuration missing.' });
  }

  const client = new Client({ connectionString: DATABASE_URL });

  try {
    await client.connect();
    const result = await client.query(
      'SELECT rule_id, rulebook, source_text FROM shared_links WHERE slug = $1',
      [validatedSlug]
    );
    await client.end();

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Link not found.' });
    }

    const { rule_id, rulebook, source_text } = result.rows[0];

    // Encode the data to be passed as query parameters
    const q = Buffer.from(rule_id || 'Shared Question').toString('base64');
    const a = Buffer.from(source_text || 'No answer text available.').toString('base64');
    const l = Buffer.from(rulebook || 'MLB').toString('base64');

    // FIX: Redirect to the correct nested path
    res.redirect(307, `/rulebook/share.html?q=${q}&a=${a}&l=${l}`);

  } catch (err: any) {
    // Security: Log full error details server-side but don't expose to client
    console.error('RETRIEVE ERROR:', err);
    console.error('Error details:', err.message);
    console.error('Stack trace:', err.stack);
    try { await client.end(); } catch {}
    // Security: Don't expose internal error details to client
    return res.status(500).json({ error: 'Internal server error.' });
  }
}


import path from "path";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import pg from 'pg';
import Anthropic from '@anthropic-ai/sdk';
const { Client, Pool } = pg;
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 })
  : null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const withCors = (handler) => async (req, res) => {
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

function extractRuleRef(answer) {
  const lines = answer.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length >= 2) {
    const match = lines[1].match(/([0-9]+\.[0-9]+[a-z]?\([0-9]+\)|[0-9]+\.[0-9]+[a-z]?)/i);
    if (match && match[1]) {
      return match[1];
    }
  }
  const match = answer.match(/([0-9]+\.[0-9]+[a-z]?\([0-9]+\)|[0-9]+\.[0-9]+[a-z]?)/i);
  if (match && match[1]) {
    return match[1];
  }
  return '';
}

// Security: Validate and sanitize user input
function sanitizeInput(input, maxLength = 5000) {
  if (!input || typeof input !== 'string') {
    return '';
  }
  // Trim and limit length
  let sanitized = input.trim().slice(0, maxLength);
  // Remove null bytes and other control characters (except newlines and tabs)
  sanitized = sanitized.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
  return sanitized;
}

// Security: Validate conversation array
function validateConversation(conversation) {
  if (!conversation || !Array.isArray(conversation)) {
    return [];
  }
  // Limit conversation history length
  const maxTurns = 10;
  const limited = conversation.slice(0, maxTurns);
  
  return limited.map(turn => {
    if (!turn || typeof turn !== 'object') {
      return null;
    }
    return {
      user: sanitizeInput(turn.user, 1000),
      ai: sanitizeInput(turn.ai, 2000)
    };
  }).filter(turn => turn && turn.user && turn.ai);
}

const handler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { question, league, conversation } = req.body;

  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: "Question is required and must be a string" });
  }
  const sanitizedQuestion = sanitizeInput(question, 1000);
  if (!sanitizedQuestion || sanitizedQuestion.length < 3) {
    return res.status(400).json({ error: "Question must be at least 3 characters long" });
  }
  if (!anthropic) return res.status(500).json({ error: "Missing Anthropic API key" });
  if (!pool)      return res.status(500).json({ error: "Missing DATABASE_URL" });

  // Resolve league slug
  const leagueNorm = sanitizeInput(league ?? '', 50).toLowerCase();
  let leagueSlug = 'mlb';
  let leagueName = 'MLB Official Rules of Baseball';
  if (leagueNorm === 'usssa' || leagueNorm === 'usssa baseball')                      { leagueSlug = 'usssa';          leagueName = 'USSSA Baseball'; }
  else if (leagueNorm === 'little league' || leagueNorm === 'little league international') { leagueSlug = 'little-league'; leagueName = 'Little League International'; }
  else if (leagueNorm === 'mill valley aaa' || leagueNorm === 'mill valley')          { leagueSlug = 'mill-valley-aaa'; leagueName = 'Mill Valley AAA'; }
  else if (leagueNorm === 'bamsbl')                                                   { leagueSlug = 'bamsbl';          leagueName = 'Bay Area Men\'s Senior Baseball League'; }

  try {
    const dbClient = await pool.connect();
    let leagueRules = [], parentRules = [], parentName = null;
    try {
      const leagueRes = await dbClient.query(`
        SELECT l.name AS league_name, l.parent_league_id, r.rule_number, r.title, r.body
        FROM rules r JOIN leagues l ON l.id = r.league_id
        WHERE l.slug = $1 ORDER BY r.rule_number
      `, [leagueSlug]);
      leagueRules = leagueRes.rows;
      const parentId = leagueRes.rows[0]?.parent_league_id;
      if (parentId) {
        const pRes = await dbClient.query(`
          SELECT l.name AS league_name, r.rule_number, r.title, r.body
          FROM rules r JOIN leagues l ON l.id = r.league_id
          WHERE l.id = $1 ORDER BY r.rule_number
        `, [parentId]);
        parentRules = pRes.rows;
        parentName  = pRes.rows[0]?.league_name ?? null;
      }
      if (leagueRules.length === 0) {
        const mlbRes = await dbClient.query(`
          SELECT l.name AS league_name, r.rule_number, r.title, r.body
          FROM rules r JOIN leagues l ON l.id = r.league_id
          WHERE l.slug = 'mlb' ORDER BY r.rule_number
        `);
        leagueRules = mlbRes.rows;
      }
    } finally {
      dbClient.release();
    }

    const fmt = (rows) => rows.map(r => `Rule ${r.rule_number}: ${r.title}\n${r.body}`).join('\n\n');
    const validatedConversation = validateConversation(conversation);
    const historyText = validatedConversation.length > 0
      ? 'Conversation history:\n' + validatedConversation.map(t => `User: ${t.user}\nAssistant: ${t.ai}`).join('\n\n') + '\n\n'
      : '';

    const prompt = `You are an expert baseball rules official for the ${leagueName}.

Your job: answer the umpire's question accurately by reading the rulebook below. Always cite the specific rule number.

${historyText}QUESTION: ${sanitizedQuestion}

${leagueName.toUpperCase()} RULEBOOK (${leagueRules.length} rules):
${fmt(leagueRules)}
${parentRules.length > 0 ? `\n\n${parentName?.toUpperCase() ?? 'PARENT LEAGUE'} RULEBOOK — applies where ${leagueName} has no specific rule (${parentRules.length} rules):\n${fmt(parentRules)}` : ''}

Instructions:
- Search the rulebook above for every rule relevant to this question.
- Give a clear, plain-English answer an umpire can act on immediately.
- Cite the rule number(s) you are drawing from.
- If the ${leagueName} rulebook has a specific rule, use that. Only reference the parent rulebook if the local league has no applicable rule.
- If no rule covers the question at all, say so plainly.

Answer:`;

    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }],
    });

    const reply = message.content[0]?.text?.trim() || 'No answer received.';

    // Log the question/answer to question_logs (do not block response if this fails)
    (async () => {
      const DATABASE_URL = process.env.DATABASE_URL;
      if (!DATABASE_URL) return;
      const client = new Client({ connectionString: DATABASE_URL });
      try {
        await client.connect();
        const ruleRef = extractRuleRef(reply);
        // Security: Sanitize inputs before database insertion
        await client.query(
          'INSERT INTO question_logs (question, answer, rule_ref, rulebook, created_at) VALUES ($1, $2, $3, $4, NOW())',
          [sanitizedQuestion, sanitizeInput(reply, 5000), sanitizeInput(ruleRef, 50), sanitizeInput(leagueName, 100)]
        );
        await client.end();
      } catch (err) {
        console.error('Failed to log question/answer:', err);
        try { await client.end(); } catch {}
      }
    })();

    res.status(200).json({ reply, usedFallback: false, fallbackLeague: null, originalLeague: leagueName });

  } catch (err) {
    // Security: Log full error details server-side but don't expose to client
    console.error("ASK API ERROR:", err);
    console.error("Error details:", err.message);
    console.error("Stack trace:", err.stack);
    // Security: Don't expose internal error details to client
    res.status(500).json({ error: "Something went wrong processing the rules." });
  }
};

export default withCors(handler);
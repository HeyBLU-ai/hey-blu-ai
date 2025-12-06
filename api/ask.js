import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import pg from 'pg';
const { Client } = pg;

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

function cosineSimilarity(a, b) {
  let dot = 0.0, normA = 0.0, normB = 0.0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Security: Validate and sanitize file paths to prevent path traversal
function validateFilePath(filename) {
  if (!filename || typeof filename !== 'string') {
    return null;
  }
  // Remove any path traversal attempts
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return null;
  }
  // Only allow alphanumeric, hyphens, underscores, and dots
  if (!/^[a-zA-Z0-9._-]+\.json$/.test(filename)) {
    return null;
  }
  return filename;
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

  // Security: Validate and sanitize inputs
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: "Question is required and must be a string" });
  }
  
  const sanitizedQuestion = sanitizeInput(question, 1000);
  if (!sanitizedQuestion || sanitizedQuestion.length < 3) {
    return res.status(400).json({ error: "Question must be at least 3 characters long" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "Missing OpenAI API key" });
  }

  // Security: League selection logic with strict whitelist
  let rulesFileName = "rules-mlb.json";
  let embeddingsFileName = "rules-mlb-embeddings.json";
  let leagueName = "MLB";
  
  if (league && typeof league === "string") {
    const leagueNorm = sanitizeInput(league, 50).toLowerCase();
    if (leagueNorm === "usssa" || leagueNorm === "usssa baseball") {
      rulesFileName = "usssa-rules.json";
      embeddingsFileName = "usssa-rules-embeddings.json";
      leagueName = "USSSA Baseball";
    } else if (leagueNorm === "mlb") {
      rulesFileName = "rules-mlb.json";
      embeddingsFileName = "rules-mlb-embeddings.json";
      leagueName = "MLB";
    } else if (leagueNorm === "little league" || leagueNorm === "little league international") {
      rulesFileName = "little-league-international.json";
      embeddingsFileName = null;
      leagueName = "Little League International";
    } else if (leagueNorm === "mill valley aaa" || leagueNorm === "mill valley") {
      rulesFileName = "mill-valley-aaa-rules.json";
      embeddingsFileName = "mill-valley-aaa-rules-embeddings.json";
      leagueName = "Mill Valley AAA";
    } else if (leagueNorm === "bamsbl") {
      rulesFileName = "bamsbl-rules.json";
      embeddingsFileName = "bamsbl-rules-embeddings.json";
      leagueName = "BAMSBL";
    }
  }

  // Security: Validate file paths to prevent path traversal
  rulesFileName = validateFilePath(rulesFileName);
  if (embeddingsFileName) {
    embeddingsFileName = validateFilePath(embeddingsFileName);
  }
  
  if (!rulesFileName) {
    return res.status(400).json({ error: "Invalid league selection" });
  }

  try {
    // --- SEMANTIC SEARCH with FALLBACK LOGIC ---
    let selectedRules = [];
    let usedFallback = false;
    let fallbackLeague = null;
    
    // First, search the primary league's rules
    if (embeddingsFileName) {
      const embeddingsPath = path.join(__dirname, "data", embeddingsFileName);
      
      // Security: Additional path validation - ensure path stays within data directory
      const resolvedPath = path.resolve(embeddingsPath);
      const dataDir = path.resolve(path.join(__dirname, "data"));
      if (!resolvedPath.startsWith(dataDir)) {
        throw new Error("Invalid file path");
      }
      
      let embeddingsRaw;
      let ruleEmbeddings;
      try {
        embeddingsRaw = await fs.readFile(embeddingsPath, "utf-8");
        ruleEmbeddings = JSON.parse(embeddingsRaw);
      } catch (parseErr) {
        console.error("Error reading or parsing embeddings file:", parseErr);
        throw new Error("Failed to load rulebook data");
      }
      const embedRes = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: question
        })
      });
      const embedData = await embedRes.json();
      const questionEmbedding = embedData.data[0].embedding;
      const scored = ruleEmbeddings.map(rule => ({
        ...rule,
        similarity: cosineSimilarity(questionEmbedding, rule.embedding)
      }));
      scored.sort((a, b) => b.similarity - a.similarity);
      selectedRules = scored.slice(0, 10).map(r => ({ id: r.id, text: r.text }));
    } else {
      const rulesPath = path.join(__dirname, "data", rulesFileName);
      
      // Security: Additional path validation
      const resolvedPath = path.resolve(rulesPath);
      const dataDir = path.resolve(path.join(__dirname, "data"));
      if (!resolvedPath.startsWith(dataDir)) {
        throw new Error("Invalid file path");
      }
      
      let rulesFile;
      let rulesData;
      try {
        rulesFile = await fs.readFile(rulesPath, "utf-8");
        rulesData = JSON.parse(rulesFile);
      } catch (parseErr) {
        console.error("Error reading or parsing rules file:", parseErr);
        throw new Error("Failed to load rulebook data");
      }
      selectedRules = rulesData.map(r => ({ id: r.id, text: r.text })).slice(0, 40);
    }
    
    // Check if we need to fallback to other rulebooks
    const needsFallback = selectedRules.length > 0 && 
                         selectedRules.every(rule => 
                           rule.text.toLowerCase().includes("not specifically covered") ||
                           rule.text.toLowerCase().includes("not explicitly listed") ||
                           rule.text.toLowerCase().includes("not found") ||
                           rule.text.toLowerCase().includes("fallback")
                         );
    
    if (needsFallback) {
      // Determine the appropriate fallback based on the league
      let fallbackEmbeddingsPath;
      
      if (leagueName === "Mill Valley AAA") {
        // Mill Valley AAA falls back to Little League International
        usedFallback = true;
        fallbackLeague = "Little League International";
        fallbackEmbeddingsPath = path.join(__dirname, "data", "little-league-international.json");
      } else if (leagueName === "Little League International") {
        // Little League International falls back to MLB
        usedFallback = true;
        fallbackLeague = "MLB";
        fallbackEmbeddingsPath = path.join(__dirname, "data", "rules-mlb-embeddings.json");
      } else if (leagueName === "USSSA Baseball" || leagueName === "BAMSBL") {
        // USSSA Baseball and BAMSBL fall back to MLB
        usedFallback = true;
        fallbackLeague = "MLB";
        fallbackEmbeddingsPath = path.join(__dirname, "data", "rules-mlb-embeddings.json");
      }
      
      if (usedFallback && fallbackEmbeddingsPath) {
        // Security: Validate fallback path
        const resolvedFallbackPath = path.resolve(fallbackEmbeddingsPath);
        const dataDir = path.resolve(path.join(__dirname, "data"));
        if (!resolvedFallbackPath.startsWith(dataDir)) {
          throw new Error("Invalid fallback file path");
        }
        
        // Load fallback rules
        let fallbackRulesRaw;
        let fallbackRulesData;
        try {
          fallbackRulesRaw = await fs.readFile(fallbackEmbeddingsPath, "utf-8");
          fallbackRulesData = JSON.parse(fallbackRulesRaw);
        } catch (parseErr) {
          console.error("Error reading or parsing fallback rules file:", parseErr);
          throw new Error("Failed to load fallback rulebook data");
        }
        
        if (fallbackLeague === "Little League International") {
          // Little League International uses raw JSON, not embeddings
          selectedRules = fallbackRulesData.map(r => ({ id: r.id, text: r.text })).slice(0, 40);
        } else {
          // MLB and other leagues use embeddings
          const embedRes = await fetch("https://api.openai.com/v1/embeddings", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: "text-embedding-3-small",
              input: question
            })
          });
          const embedData = await embedRes.json();
          const questionEmbedding = embedData.data[0].embedding;
          
          const scored = fallbackRulesData.map(rule => ({
            ...rule,
            similarity: cosineSimilarity(questionEmbedding, rule.embedding)
          }));
          scored.sort((a, b) => b.similarity - a.similarity);
          selectedRules = scored.slice(0, 10).map(r => ({ id: r.id, text: r.text }));
        }
      }
    }
    
    const context = selectedRules.map(r => `${r.id}: ${r.text}`).join("\n\n");

    // Security: Validate and sanitize conversation history
    const validatedConversation = validateConversation(conversation);
    let historyContext = "";
    if (validatedConversation.length > 0) {
      historyContext = "Here is the history of our current conversation:\n" +
        validatedConversation.map(turn => `User: ${turn.user}\nAssistant: ${turn.ai}`).join('\n\n') +
        "\n\nPlease use this history to inform your answer to the new question.";
    }

    // --- THIS IS THE CORRECTED PROMPT ---
    const prompt = `
You are an expert on the ${usedFallback ? fallbackLeague : leagueName} rulebook. Your task is to answer a user's question clearly and concisely, citing the most relevant rule(s).
You will be given the conversation history, the user's latest question, and a set of relevant rules.

    ${usedFallback ? `**IMPORTANT:** The user asked about ${leagueName} rules, but this specific question is not covered in the ${leagueName} rulebook. You are now using ${fallbackLeague} rules as the fallback source. Keep your response concise and follow the exact format shown in the fallback example.` : ''}

Follow these steps precisely:
1.  **Analyze the Conversation History (if provided):** Understand the context of what has already been discussed.
2.  **Analyze the User's Latest Question:** Identify the core concept in the new question, mapping colloquial terms to official terminology (e.g., "overthrow" -> "thrown ball").
3.  **Find the Relevant Rule(s):** Search the provided rules to find the most relevant rule(s) for the LATEST question, considering the conversation history for context.
4.  **Synthesize the Answer:**
    * If the user is asking a follow-up, your answer should directly address it in the context of the previous answer.
    * Provide a concise, plain-English summary.
    * Then, cite the single most important rule number and the most relevant sentence from that rule.
    ${usedFallback ? `* **CRITICAL:** For fallback responses, first provide the natural language answer, then include a single brief line stating "Referencing ${fallbackLeague} rulebook because the provided ${leagueName} rulebook does not have a rule citation for this question." Then proceed with the rule citation as normal.` : ''}
5.  **Construct the Final Response:** You MUST format your response exactly as shown in the example below, with no extra labels, introductions, or conversational text.

---
**EXAMPLE**

**User Question:** what happens if a batter is hit by a pitch?

**Your Response:**
A batter is awarded first base if they are hit by a pitch, provided they made an attempt to avoid it and the pitch was not a strike.

Rule 5.05(b)(2): "*He is touched by a pitched ball which he is not attempting to hit unless (A) The ball is in the strike zone when it touches the batter, or (B) The batter makes no attempt to avoid being touched by the ball;*"
---

${usedFallback ? `**FALLBACK EXAMPLE**

**User Question:** what is the fraternization rule? (asked about USSSA Baseball)

**Your Response:**
The fraternization rule prohibits players from engaging in friendly interactions with members of the opposing team during the course of a game to maintain a competitive atmosphere.

Referencing MLB rulebook because the provided USSSA Baseball rulebook does not have a rule citation for this question.

MLB Rule 8.19: "*Umpire judgment shall be used to determine if all the runners are not attempting to advance.*"

**User Question:** what is the infield fly rule? (asked about Mill Valley AAA)

**Your Response:**
The infield fly rule applies when there are runners on first and second base (or bases loaded) with fewer than two outs, and a fair fly ball is hit that can be caught by an infielder with ordinary effort.

Referencing Little League International rulebook because the provided Mill Valley AAA rulebook does not have a rule citation for this question.

Little League Rule 2.00: "*An INFIELD FLY is a fair fly ball (not including a line drive nor an attempted bunt) which can be caught by an infielder with ordinary effort, when first and second, or first, second and third bases are occupied, before two are out.*"
---` : ''}

**Your Task**

${historyContext ? `--- \n**Conversation History** \n${historyContext}\n---` : ''}

**User's Latest Question:** "${sanitizedQuestion}"

**Relevant ${usedFallback ? fallbackLeague : leagueName} Rules:**
${context}

Answer:
`;

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4
      })
    });

    const data = await openaiRes.json();
    const reply = data?.choices?.[0]?.message?.content || "No answer received.";

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
          [sanitizedQuestion, sanitizeInput(reply, 5000), sanitizeInput(ruleRef, 50), sanitizeInput(usedFallback ? fallbackLeague : leagueName, 100)]
        );
        await client.end();
      } catch (err) {
        console.error('Failed to log question/answer:', err);
        try { await client.end(); } catch {}
      }
    })();

    res.status(200).json({ 
      reply,
      usedFallback,
      fallbackLeague,
      originalLeague: leagueName
    });

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
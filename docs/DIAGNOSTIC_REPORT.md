# HeyBLU AI — Complete Technical Diagnostic Report

**Audience:** Expert debugger / senior engineer familiar with LLM-powered document retrieval systems  
**Date:** June 2026  
**Repo:** `hey-blu-ai` (GitHub: HeyBLU-ai/hey-blu-ai)  
**Status at time of writing:** Active — retrieval quality issues under investigation

---

## 1. What Is This App

HeyBLU is a **baseball rulebook Q&A assistant** for umpires and league officials. Users ask plain-English questions ("Is there a uniform rule?" / "What happens when a runner is hit by a batted ball?") and the app returns a cited, verifiable answer sourced exclusively from the official rulebook of their league.

The primary league in production is **BAMSBL** (Bay Area Men's Senior Baseball League). MLB, Little League, USSSA, and Mill Valley are also registered but may not have active rulebooks loaded.

The product goal is a **zero-hallucination, always-cited answer**. Every answer must point to a verbatim excerpt from the rulebook and be independently verifiable by a human.

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| **Hosting** | Vercel (serverless functions + static assets) |
| **API runtime** | Node.js ESM (`.js` files under `api/`) |
| **Database** | PostgreSQL (Vercel Postgres / Neon) via `pg` pool |
| **LLM — Draft answer** | Anthropic Claude Sonnet (`claude-sonnet-4-6`) |
| **LLM — Routing classifier** | Anthropic Claude Haiku (`claude-haiku-4-5`) |
| **LLM — Verifier** | Anthropic Claude Opus (`claude-opus-4-8`) |
| **Frontend** | Static HTML + vanilla JS (no framework) |
| **Rulebook ingestion** | Local CLI Node scripts under `scripts/` and `lib/ingest/` |
| **PDF parsing** | `pdfjs-dist` (via `lib/ingest/parse-source.mjs`) |

---

## 3. Architecture Overview

```
User question
     │
     ▼
api/ask-v2.js  ◄── main entrypoint (Vercel serverless function)
     │
     ├─ 1. resolveLeague()         — maps UI league string to DB slug
     │
     ├─ 2. prescreenForMatrix()    — keyword pre-screen for judgment calls
     │       └─ if keyword match → classifyQuestion() (Haiku LLM)
     │             └─ if confirmed judgment → return needs_clarification
     │                                        (State B: starts interview)
     │
     ├─ 3. fetchSourceSpans()      — Postgres FTS retrieval (version-scoped)
     │       ├─ Pass 1: plainto_tsquery (strict AND)
     │       └─ Pass 2: to_tsquery (OR fallback, if Pass 1 = 0 results)
     │
     ├─ 4. buildSpanPrompt()       — builds Claude prompt from verbatim spans
     │
     ├─ 5. Claude Sonnet call      — generates draft answer
     │
     ├─ 6. runVerifier()           — Opus LLM checks every claim against spans
     │       └─ isVerifierBlocked() — gate logic (fail-closed)
     │
     ├─ 7. writeAnswerCache()      — UPSERT to verified_answer_cache
     │       └─ ONLY if verifier_status === 'approved'
     │
     └─ 8. Return JSON response
```

---

## 4. Data Model

### Core tables

```sql
-- One row per league
leagues (id UUID, slug TEXT, name TEXT)

-- One row per rulebook upload. Only one row per league can have status='active'.
rulebook_versions (id UUID, league_id UUID → leagues, status TEXT, created_at)

-- Verbatim continuous passages extracted from the PDF.
-- This is what gets searched by FTS.
rule_sources (id UUID, document_id UUID → rule_documents, exact_text TEXT, 
              page_start INT, section_path TEXT[])

-- One rule atom per atomic paragraph / clause extracted by the LLM ingestor.
rules (id UUID, rulebook_version_id UUID → rulebook_versions,
       rule_number TEXT, title TEXT, body TEXT, atom_key TEXT)

-- Many-to-many: which rule atoms does each source span support?
rule_source_links (id UUID, source_id UUID → rule_sources, rule_id UUID → rules)

-- PDF document metadata
rule_documents (id UUID, version_id UUID → rulebook_versions, filename TEXT, ...)

-- Cached verified answers (only approved status is written)
verified_answer_cache (id UUID, league_slug TEXT, rulebook_version_id UUID,
                        normalized_question TEXT, answer TEXT,
                        cited_source_ids UUID[], cited_rule_numbers TEXT[],
                        verifier_status TEXT, hit_count INT, last_used_at TIMESTAMP)

-- Raw question/answer log (every query)
question_logs (id UUID, question TEXT, answer TEXT, rule_ref TEXT, rulebook TEXT, created_at)

-- Evaluation test cases
eval_cases (id UUID, league_slug TEXT, question TEXT, expected_state TEXT,
            expected_rule_number TEXT, expected_source_text TEXT,
            case_type TEXT, tier TEXT, last_run_passed BOOL, last_run_at TIMESTAMP)
```

### Key FK chain for retrieval

```
rule_sources.document_id → rule_documents.id
rule_documents.version_id → rulebook_versions.id   ← version isolation enforced here
rule_source_links.source_id → rule_sources.id
rule_source_links.rule_id → rules.id
rules.rulebook_version_id → rulebook_versions.id    ← enforced again for safety
```

---

## 5. Rulebook Ingestion Pipeline

**Entry:** `node scripts/ingest-bamsbl.mjs` (one-off CLI script)

```
PDF file
   │
   ├─ lib/ingest/parse-source.mjs      — pdfjs extracts text page by page
   │
   ├─ lib/ingest/create-source-spans.mjs — splits text into SourceSpan objects
   │       (contiguous passages, stored in rule_sources)
   │
   ├─ lib/ingest/extract-rule-atoms.mjs  — calls Claude to extract RuleAtom per span
   │       - Sticky Tracker: propagates parent rule_number down to child clauses
   │       - TOC-page guard: ignores the Table of Contents pages to prevent
   │         TOC rule numbers from polluting body-text spans
   │       - Deterministic post-processing: algorithmic rule number assignment
   │
   ├─ lib/ingest/write-rulebook-version.mjs — writes to DB (rules, rule_source_links)
   │
   └─ lib/ingest/verify-coverage.mjs   — sanity checks (coverage metrics)
```

**Assumptions baked into ingest:**
- PDFs are structured with rule numbers as section headings (e.g. "305. Uniforms")
- Sticky Tracker assumes the first numbered heading on a page sets the rule number for all following un-numbered items on that page
- The LLM (Claude) reliably extracts the correct rule number from context
- Each source span is the authoritative verbatim text; rules.body may paraphrase

---

## 6. Retrieval Pipeline — `fetchSourceSpans` in Detail

The critical path. This determines what the model sees.

```javascript
// Pass 1: plainto_tsquery AND — all terms must be present
WHERE doc_vec @@ plainto_tsquery('english', question)

// Pass 2 (if Pass 1 = 0): to_tsquery OR — any content keyword matches
WHERE doc_vec @@ to_tsquery('english', 'keyword1 | keyword2 | ...')
```

**`doc_vec`** (as of latest fix) = `to_tsvector('english', exact_text || ' ' || all_linked_rule_titles)`

The OR-fallback keywords are extracted by `buildOrFallbackQuery()`, which filters words through `FTS_STOP_WORDS` before building the OR list.

---

## 7. Judgment Call Routing (State B)

Some questions can't be answered factually without knowing the play situation (obstruction vs. interference, infield fly applicability, etc.). These trigger a structured "interview":

1. `prescreenForMatrix()` — keyword list pre-screen (no LLM, fast). Also checks `DEFINITIONAL_PREFIXES` to bypass the matrix for obviously factual phrasing.
2. `classifyQuestion()` — Haiku LLM second opinion if keyword hits. Returns `{ classification, matrix_id, confidence }`.
3. If `classification === 'judgment'` and `confidence >= 0.65` → `State B` (needs_clarification). Returns one diagnostic question.
4. Client sends answers back via `matrix_state`. After all questions answered → `State C` (ruling) with play context injected into the RAG prompt.

---

## 8. Verifier Gate

Every draft answer passes through `api/verifier.js` before reaching the user.

**Fail-closed logic:**
- `approved` → passes
- `no_rule_found` → passes (model correctly says "I could not find a rule")
- `needs_fact` → passes (model accurately notes missing information)
- `unsupported` → **blocked**
- `unsupported_claims.length > 0` → **blocked** (regardless of status)
- API error or JSON parse error → **blocked**

The verifier prompt instructs Opus to:
- Check every factual claim in the draft against the provided source excerpts
- NOT mark partial answers as `unsupported` (they should be `needs_fact`)
- Reserve `unsupported` exclusively for invented facts or direct contradictions

---

## 9. Complete Bug History

### Bug 1: TOC Contamination — Rule 620 Explosion (RESOLVED)
**Symptom:** Rule 620 (3 sentences) generated 227 rule atoms.  
**Root cause:** The sticky tracker picked up a Table of Contents entry ("620. [section name]") and applied rule number "620" to every subsequent un-numbered span on following pages.  
**Fix:** Added a TOC-page guard in `lib/ingest/extract-rule-atoms.mjs`. Pages that look like TOC (high density of rule-number patterns with no body text) no longer update the sticky tracker's `currentActiveRuleNumber`.

---

### Bug 2: Legacy Ingest Endpoint Exposed (RESOLVED)
**Symptom:** `api/admin/ingest.js` was still accessible and contained the original summary-ingest prompt.  
**Fix:**
- Replaced `api/admin/ingest.js` with a minimal HTTP 410 handler
- Removed the route from `vercel.json`
- Archived original to `scripts/legacy/admin-ingest-legacy.mjs` with a hard `NODE_ENV=production` fail

---

### Bug 3: Eval Runner Used Wrong Table Name (RESOLVED)
**Symptom:** `scripts/run-evals.mjs` queries failed silently — `checkVersionIsolation` and `checkNoNullVersion` always passed vacuously.  
**Root cause:** The script queried `source_spans` (old name) and `body` (old column name). Production tables are `rule_sources` and `exact_text`.  
**Fix:** Updated all eval SQL to use correct table/column names and join through `rule_documents` for version FK chain.

---

### Bug 4: Wrong Rule Number in Eval Case (RESOLVED)
**Symptom:** Eval case expected `rule_number: '505'` (sliding rule) but citation came back as `'430'`.  
**Root cause:** Rule 505 doesn't exist in BAMSBL. The sliding rules are unnumbered. Rule 430 is the courtesy runner rule.  
**Fix:** Updated `seed-evals.mjs` to `expected_rule_number: null`.

---

### Bug 5: Judgment Routing Too Aggressive (RESOLVED)
**Symptom:** Questions phrased as "what is the award to the batter when..." triggered `needs_clarification` instead of a factual answer.  
**Root cause:** `DEFINITIONAL_PREFIXES` list in `api/judgment-matrices.js` was too short; the LLM classifier over-classified factual questions as judgment calls.  
**Fix:** Added `'what happens '`, `'what happen '`, `'what is the rule when '`, `'what is the ruling when '` to `DEFINITIONAL_PREFIXES`.

---

### Bug 6: Verifier Too Strict — Partial Answers Blocked (RESOLVED)
**Symptom:** Questions where the rulebook only partially answered (e.g., acknowledged a rule exists but didn't include every sub-bullet in the retrieved span) returned "unverifiable" to the user.  
**Root cause:** Verifier `VERIFIER_SYSTEM_PROMPT` marked any incomplete answer as `unsupported`.  
**Fix:** Updated `VERIFIER_SYSTEM_PROMPT` to explicitly distinguish `approved` (all stated claims supported), `needs_fact` (accurate but notes missing details), and `unsupported` (only for hallucinated or contradicted facts).

---

### Bug 7: FTS OR-Fallback Type Coercion Failure (RESOLVED)
**Symptom:** "Is there a uniform rule?" returned "no rule found" even after the OR-fallback was implemented in commit `d7bd15e`.  
**Root cause:** The OR fallback implementation fetched the tsquery via a separate `SELECT plainto_tsquery(...) AS q` round-trip and passed the result back to the main query as JavaScript string `$3`. PostgreSQL received it as `text` type, not `tsquery`. The `ts_rank(tsvector, text)` call hit an ambiguous overload and the error was swallowed by `catch`, returning 0 spans.  
**Fix (commit `7603158`):** Moved both `plainto_tsquery` and `to_tsquery` calls **inside the SQL** (computed inline), eliminating any JS↔PG type coercion.

---

### Bug 8: "rule" Keyword Drowns Subject-Matter Terms in OR Query (CURRENT FIX)
**Symptom:** "Is there a uniform rule?" retrieves Rule 330 ("Pitcher's Uniform") and spans about "This rule is not a must-slide rule" — completely wrong.  
**Root cause (two parts):**

**Part A — "rule" in OR query:**  
`buildOrFallbackQuery('is there a uniform rule?')` produces `'uniform | rule'`. The word "rule" appears in **every single span** in a rulebook. Any span mentioning "This rule states…" or "The League shall adopt rules…" outranks the actual uniform rule because `ts_rank` scores higher for multiple term matches. "Rule" provides zero discrimination in a rulebook corpus.

**Part B — FTS searches only `exact_text`, not rule titles:**  
Rule 305's source span reads "Every player must have a number on the jersey, matching caps, pants & jerseys in presentable condition." The word "uniform" does not appear in this text. The span is linked to a rule atom titled "Player jersey numbers and **uniform** condition requirements". With exact_text-only FTS, Rule 305 is invisible to a "uniform" query.

**Confirmed from DB:**
```
Rule 305 span 1 exact_text: "305. Uniforms"                      → matches "uniform" ✓
Rule 305 span 2 exact_text: "All teams…must meet league uniform…" → matches "uniform" ✓
Rule 305 span 3 exact_text: "Every player must have a number…"    → matches "uniform" ✗
    But: span 3 rule title = "Player jersey numbers and uniform condition requirements"
                                                                   → title matches "uniform" ✓
```

**Fix (this commit):**
1. Added `'rule'`, `'rules'`, `'ruling'`, `'rulings'`, `'league'`, `'leagues'` to `FTS_STOP_WORDS`. These are domain noise words — maximally common in a rulebook, providing zero retrieval signal.
2. Changed `fetchSourceSpans` from searching `to_tsvector('english', rs.exact_text)` to a CTE-based approach that searches `to_tsvector('english', rs.exact_text || ' ' || all_rule_titles_concatenated)`. Titles are included in the searchable document vector without being included in the response `exact_text` returned to the model.

---

## 10. Architectural Root Causes (Big Picture)

The app is built on **PostgreSQL Full-Text Search (FTS)**. FTS is keyword-based. It has a fundamental vocabulary mismatch problem when the user's terminology differs from the rulebook's exact wording. This has been the root cause of every retrieval failure:

| User says | Rulebook says | FTS result |
|---|---|---|
| "uniform rule" | "305. Uniforms" / "jersey, caps, pants" | 0 spans (AND), wrong spans (OR) |
| "collision rule" | "no collision rule" / "must slide" | partially correct |
| "jersey requirements" | "jersey, caps, pants" | correct (enough overlap) |

Every fix applied so far is a workaround for this fundamental limitation.

### What FTS cannot solve
- **Synonyms:** "uniform" ↔ "jersey/cap/pants"
- **Paraphrasing:** "Can I protest a call?" ↔ "League shall adopt rules governing procedure for protesting"
- **Implied concepts:** "Can a player use a metal bat?" ↔ [equipment rules section]
- **Negation queries:** "Is there NOT a..." constructs confuse FTS ranking

### The real fix: Embedding / Vector Search

The correct long-term architecture is a **two-stage hybrid retrieval**:

```
Query
  │
  ├─ Stage 1: Dense retrieval (pgvector / OpenAI embeddings)
  │     - Encode question as embedding vector
  │     - Find top-K spans by cosine similarity
  │     - Handles synonyms, paraphrasing, semantic intent
  │
  └─ Stage 2: FTS re-ranking (current approach)
        - Filter Stage 1 results by keyword overlap
        - Better precision on exact citations
```

**Implementation path:**
1. Add `pgvector` extension to the PostgreSQL database
2. Add `embedding VECTOR(1536)` column to `rule_sources`
3. On ingestion: call OpenAI `text-embedding-3-small` for each source span, store vector
4. On query: embed the question, use `<=>` cosine distance to find top-20 spans
5. Re-rank with FTS score, take top-8

**Cost estimate:** ~$0.002 per 1M tokens for `text-embedding-3-small`. For ~500 source spans per rulebook, ingestion cost is negligible. Query cost is one embedding per user question (~$0.0000002 per query).

---

## 11. Current FTS Workarounds in Place

| Workaround | File | Purpose |
|---|---|---|
| OR-fallback with content words | `api/ask-v2.js` `buildOrFallbackQuery()` | Retrieves spans when AND query returns 0 |
| `FTS_STOP_WORDS` list | `api/ask-v2.js` | Excludes noise words from OR query |
| Title-boosted tsvector | `api/ask-v2.js` `fetchSourceSpans()` | Includes `rules.title` in searchable text |
| `DEFINITIONAL_PREFIXES` | `api/judgment-matrices.js` | Prevents factual questions from hitting the interview flow |
| Partial-answer verifier rules | `api/verifier.js` | Prevents correct-but-incomplete answers from being blocked |
| Cache guardrail | `api/ask-v2.js` `writeAnswerCache()` | Only caches `approved` answers |

---

## 12. Eval Suite Coverage

50 deterministic test cases in `eval_cases` table, categories:

| Category | Count | Purpose |
|---|---|---|
| factual rule lookups | 10 | Core retrieval accuracy |
| judgment / needs clarification | 10 | Interview routing works |
| judgment / enough facts | 10 | Factual routing not over-triggered |
| local override / BAMSBL-specific | 8 | League-specific rules returned |
| no-rule-found / unsupported | 5 | System correctly says "I don't know" |
| misleading phrasing | 4 | Semantic robustness |
| parent-fallback | 3 | Rule hierarchy (child → parent inheritance) |

7 deterministic checks per case, no LLM judge:
1. `expected_state` matches response `state`
2. `expected_rule_number` appears in `cited_rule_numbers`
3. `expected_source_text` appears in retrieved span `exact_text`
4. Every `source_id` belongs to active version
5. No cited source has `NULL` version FK
6. `unsupported` verifier status → `state === 'unverifiable'`
7. `needs_clarification` → exactly one `current_question`

**Current status:** 50/50 passing at last run (post eval-suite cleanup).

---

## 13. Files That Matter Most

```
api/ask-v2.js           — The entire pipeline. Single most critical file.
api/verifier.js         — Blocking gate. Controls what users see.
api/judgment-matrices.js — Interview routing. Controls State B vs. State A.
lib/ingest/extract-rule-atoms.mjs — LLM atom extraction. Controls data quality.
scripts/seed-evals.mjs  — Ground truth. Defines what "correct" means.
scripts/run-evals.mjs   — Test harness. Run before every deploy.
scripts/trace-retrieval.mjs — Diagnostic tool. Use to debug any retrieval failure.
```

---

## 14. Environment Variables Required

```
DATABASE_URL              — Postgres connection string
ANTHROPIC_API_KEY         — Claude API key (Sonnet + Opus + Haiku)
ADMIN_PASSWORD            — Bearer token for /api/admin/* routes
ANTHROPIC_ANSWER_MODEL    — defaults to claude-sonnet-4-6
ANTHROPIC_VERIFY_MODEL    — defaults to claude-opus-4-8
RULEBOOK_DEBUG            — set to '1' to include _debug in responses
```

---

## 15. Recommended Next Steps (Priority Order)

### P0 — Implement Vector Search (fixes vocabulary mismatch permanently)
- Add `pgvector` to Postgres
- Embed all `rule_sources.exact_text` with OpenAI or Voyage AI
- Replace Pass 1 FTS AND with dense vector retrieval
- Keep FTS as a re-ranker / tie-breaker
- See Section 10 above

### P1 — FTS Stop Word Tuning
- Add `RULEBOOK_DEBUG=1` to Vercel env vars temporarily
- Log all failed queries (Pass 1 AND → 0, Pass 2 OR → 0)
- Expand `FTS_STOP_WORDS` as high-frequency noise terms are identified

### P2 — Run Eval Suite Before Every Deploy
```bash
node scripts/seed-evals.mjs   # idempotent — upserts, safe to re-run
node scripts/run-evals.mjs    # must exit 0 before pushing
```

### P3 — Index the Section Hierarchy
The PDF has section headings like "SECTION 3 — UNIFORM REQUIREMENTS" that don't get ingested as searchable content. Capturing these as additional `rule_sources` entries would significantly improve "is there a uniform rule?" type queries without needing vector search.

### P4 — Flush Cache After Any Ingestion Change
```bash
node scripts/evict-cache.mjs  # or DELETE FROM verified_answer_cache WHERE league_slug='bamsbl'
```

---

## 16. How to Diagnose Any Retrieval Failure

1. Run `node scripts/trace-retrieval.mjs` (edit the hardcoded question first)
2. Check `[STEP 1]` — did Pass 1 return spans? If yes, retrieval is working.
3. Check `[STEP 2]` — did Pass 2 OR-fallback trigger? What `orTerms` were generated?
4. Check `[STEP 3]` — are the retrieved spans relevant to the question?
   - If NO: retrieval is the failure. Consider adding terms to `FTS_STOP_WORDS`, improving title coverage, or adding vector search.
   - If YES: continue to Step 5.
5. Check `[STEP 5]` — is the draft answer reasonable?
   - If NO: prompt engineering issue in `buildSpanPrompt`.
6. Check `[STEP 7]` — what did the verifier return?
   - `approved` → answer should pass. Check the API route for bugs.
   - `unsupported` → verifier is blocking. Check if the claim is genuinely hallucinated.
   - `no_rule_found` → model said "I couldn't find it" despite having spans. The spans don't match the question semantically — retrieval failure (vocabulary mismatch).

---

*Report generated from active codebase state, commit `7603158` and subsequent fix. All bugs documented from conversation history and git log.*

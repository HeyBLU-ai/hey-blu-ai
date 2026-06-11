-- ============================================================
-- HeyBLU Rulebook — V3 Schema Migration
-- Accuracy is the primary directive.
--
-- Run order: execute the entire file in the Supabase SQL editor
--            or via psql. Safe to run twice (idempotent).
--
-- Prerequisites: V1/V2 migration must have run first.
--   Existing tables (leagues, rules, rule_embeddings, question_logs)
--   are NOT dropped or modified.
-- ============================================================


-- ============================================================
-- PART 1: rulebook_versions
-- One row per ingest attempt for a league.
-- status: draft → active (only one active per league) → retired
-- Never delete rows; retire old versions when activating new ones.
-- ============================================================

CREATE TABLE IF NOT EXISTS rulebook_versions (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    league_id    UUID        NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
    season       TEXT,
    source_hash  TEXT        NOT NULL,
    status       TEXT        NOT NULL DEFAULT 'draft',
    notes        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_rulebook_versions_status
        CHECK (status IN ('draft', 'active', 'retired'))
);

COMMENT ON TABLE  rulebook_versions         IS 'Versioned rulebook releases. One active version per league at a time.';
COMMENT ON COLUMN rulebook_versions.status  IS 'draft|active|retired. Only one active allowed per league_id.';
COMMENT ON COLUMN rulebook_versions.source_hash IS 'SHA-256 of the original source file. Used to detect re-uploads of unchanged content.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_rulebook_versions_one_active_per_league
    ON rulebook_versions (league_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_rulebook_versions_league_status
    ON rulebook_versions (league_id, status);


-- ============================================================
-- PART 2: rule_documents
-- One row per uploaded file attached to a rulebook version.
-- source_hash is unique per league to prevent duplicate uploads.
-- ============================================================

CREATE TABLE IF NOT EXISTS rule_documents (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    league_id      UUID        NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
    version_id     UUID        NOT NULL REFERENCES rulebook_versions(id) ON DELETE CASCADE,
    season         TEXT,
    source_file    TEXT        NOT NULL,
    source_hash    TEXT        NOT NULL,
    mime_type      TEXT,
    parse_method   TEXT        NOT NULL,
    parser_version TEXT,
    page_count     INT,
    char_count     INT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_rule_documents_league_hash UNIQUE (league_id, source_hash)
);

COMMENT ON TABLE  rule_documents              IS 'One row per source file per rulebook version. Hash prevents re-processing unchanged files.';
COMMENT ON COLUMN rule_documents.parse_method IS 'e.g. mammoth|pdf-text|jina. Records which parser produced the source spans.';
COMMENT ON COLUMN rule_documents.source_hash  IS 'SHA-256 of file bytes. Unique per league to block duplicate ingests.';

CREATE INDEX IF NOT EXISTS idx_rule_documents_version
    ON rule_documents (version_id);

CREATE INDEX IF NOT EXISTS idx_rule_documents_league
    ON rule_documents (league_id);


-- ============================================================
-- PART 3: rule_sources
-- Page-anchored verbatim source spans.
-- exact_text must come from deterministic parser output only —
-- never from AI generation.
-- Exists independently of the rules table.
-- ============================================================

CREATE TABLE IF NOT EXISTS rule_sources (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id    UUID        NOT NULL REFERENCES rule_documents(id) ON DELETE CASCADE,
    page_start     INT,
    page_end       INT,
    section_path   TEXT,
    char_start     INT,
    char_end       INT,
    exact_text     TEXT        NOT NULL,
    parse_warnings JSONB       NOT NULL DEFAULT '[]'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_rule_sources_exact_text_nonempty
        CHECK (char_length(trim(exact_text)) > 0)
);

COMMENT ON TABLE  rule_sources            IS 'Verbatim text spans extracted by deterministic parser. Never AI-authored.';
COMMENT ON COLUMN rule_sources.exact_text IS 'The only authoritative source of verbatim rule text. Cite this in answers.';
COMMENT ON COLUMN rule_sources.parse_warnings IS 'Parser warnings for this span (short text, missing page break, etc.)';

CREATE INDEX IF NOT EXISTS idx_rule_sources_document
    ON rule_sources (document_id);

-- Full-text search index on verbatim source text
CREATE INDEX IF NOT EXISTS idx_rule_sources_exact_text_fts
    ON rule_sources USING gin(to_tsvector('english', exact_text));


-- ============================================================
-- PART 4: rule_source_links
-- Many-to-many: one rule can span multiple pages/spans,
-- one source span can support multiple rule atoms.
-- ============================================================

CREATE TABLE IF NOT EXISTS rule_source_links (
    rule_id    UUID NOT NULL REFERENCES rules(id)        ON DELETE CASCADE,
    source_id  UUID NOT NULL REFERENCES rule_sources(id) ON DELETE CASCADE,
    link_type  TEXT NOT NULL DEFAULT 'supports',

    PRIMARY KEY (rule_id, source_id),

    CONSTRAINT chk_rule_source_links_type
        CHECK (link_type IN ('supports', 'exception', 'example', 'approved_ruling', 'cross_reference'))
);

COMMENT ON TABLE  rule_source_links           IS 'Links rule atoms to their verbatim source spans.';
COMMENT ON COLUMN rule_source_links.link_type IS 'supports|exception|example|approved_ruling|cross_reference';

CREATE INDEX IF NOT EXISTS idx_rule_source_links_source
    ON rule_source_links (source_id);

CREATE INDEX IF NOT EXISTS idx_rule_source_links_rule
    ON rule_source_links (rule_id);


-- ============================================================
-- PART 5: eval_cases
-- Golden test questions. References rule_number (stable text)
-- not UUID so re-ingests do not break eval history.
-- Two tiers: critical (100% required) and broad (>=95% required).
-- ============================================================

CREATE TABLE IF NOT EXISTS eval_cases (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    league_slug          TEXT        NOT NULL,
    question             TEXT        NOT NULL,
    expected_rule_number TEXT,
    expected_source_text TEXT,
    expected_state       TEXT        NOT NULL DEFAULT 'answered',
    case_type            TEXT        NOT NULL,
    tier                 TEXT        NOT NULL DEFAULT 'broad',
    source               TEXT        NOT NULL DEFAULT 'human',
    last_run_passed      BOOLEAN,
    last_run_at          TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_eval_cases_league_question UNIQUE (league_slug, question),

    CONSTRAINT chk_eval_cases_state
        CHECK (expected_state IN ('answered', 'needs_clarification', 'no_rule_found', 'league_not_found')),

    CONSTRAINT chk_eval_cases_type
        CHECK (case_type IN ('factual', 'judgment', 'override', 'no_rule', 'exception',
                             'cross_ref', 'misleading', 'parent_fallback')),

    CONSTRAINT chk_eval_cases_tier
        CHECK (tier IN ('critical', 'broad')),

    CONSTRAINT chk_eval_cases_source
        CHECK (source IN ('human', 'feedback'))
);

COMMENT ON TABLE  eval_cases                      IS 'Golden test questions for the eval runner.';
COMMENT ON COLUMN eval_cases.expected_rule_number IS 'Stable rule number string. Not a UUID, so re-ingests do not break evals.';
COMMENT ON COLUMN eval_cases.expected_source_text IS 'Substring that must appear in the cited source text.';
COMMENT ON COLUMN eval_cases.tier                 IS 'critical: 100% pass required. broad: >=95% pass required.';

CREATE INDEX IF NOT EXISTS idx_eval_cases_league_tier
    ON eval_cases (league_slug, tier);

CREATE INDEX IF NOT EXISTS idx_eval_cases_last_run
    ON eval_cases (last_run_passed, last_run_at DESC);


-- ============================================================
-- PART 6: feedback_items
-- Stores thumbs-up/down from the public rulebook UI.
-- Thumbs-down auto-creates eval_cases rows (done in application code).
-- ============================================================

CREATE TABLE IF NOT EXISTS feedback_items (
    id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    question                 TEXT        NOT NULL,
    answer                   TEXT        NOT NULL,
    league_slug              TEXT,
    rating                   TEXT        NOT NULL,
    comment                  TEXT,
    promoted_to_eval_case_id UUID        REFERENCES eval_cases(id) ON DELETE SET NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_feedback_items_rating
        CHECK (rating IN ('up', 'down'))
);

COMMENT ON TABLE  feedback_items IS 'User thumbs-up/down feedback. Thumbs-down with comment becomes an eval case.';

CREATE INDEX IF NOT EXISTS idx_feedback_items_created_at
    ON feedback_items (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_items_rating
    ON feedback_items (rating, created_at DESC);


-- ============================================================
-- VERIFICATION QUERIES
-- Run these manually after migration to confirm success.
-- ============================================================

-- Table existence check
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'rulebook_versions', 'rule_documents', 'rule_sources',
    'rule_source_links', 'eval_cases', 'feedback_items'
  )
ORDER BY table_name;

-- Index existence check
SELECT indexname, tablename
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'uq_rulebook_versions_one_active_per_league',
    'idx_rulebook_versions_league_status',
    'idx_rule_documents_version',
    'idx_rule_documents_league',
    'idx_rule_sources_document',
    'idx_rule_sources_exact_text_fts',
    'idx_rule_source_links_source',
    'idx_rule_source_links_rule',
    'idx_eval_cases_league_tier',
    'idx_eval_cases_last_run',
    'idx_feedback_items_created_at',
    'idx_feedback_items_rating'
  )
ORDER BY tablename, indexname;

-- Row counts (all should be 0 after fresh migration)
SELECT 'rulebook_versions' AS tbl, COUNT(*) FROM rulebook_versions
UNION ALL SELECT 'rule_documents',    COUNT(*) FROM rule_documents
UNION ALL SELECT 'rule_sources',      COUNT(*) FROM rule_sources
UNION ALL SELECT 'rule_source_links', COUNT(*) FROM rule_source_links
UNION ALL SELECT 'eval_cases',        COUNT(*) FROM eval_cases
UNION ALL SELECT 'feedback_items',    COUNT(*) FROM feedback_items;

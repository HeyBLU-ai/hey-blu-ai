-- ============================================================
-- HeyBLU — Canonical Rule Graph Schema Migration
-- Vendor-neutral ingestion pipeline (schema only; no adapters).
--
-- Run order: review first, then execute in Supabase SQL editor
--            or via psql. Safe to run twice (idempotent).
--
-- Prerequisites:
--   - V3 migration (rulebook_versions, rule_documents, rule_sources, …)
--   - pgvector extension enabled
--
-- DO NOT activate rulebooks from extraction_runs until canonicalization
-- warnings are reviewed and blocking issues are resolved.
-- ============================================================


-- ============================================================
-- PART 0: pgvector (required for rule_node_chunks.embedding)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;


-- ============================================================
-- PART 1: extraction_runs
-- One row per vendor extraction attempt against a rulebook version.
-- Tracks adapter metadata without coupling to a specific vendor API.
-- ============================================================

CREATE TABLE IF NOT EXISTS extraction_runs (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    rulebook_version_id UUID        NOT NULL REFERENCES rulebook_versions(id) ON DELETE CASCADE,
    rule_document_id    UUID        REFERENCES rule_documents(id) ON DELETE SET NULL,
    vendor              TEXT        NOT NULL,
    vendor_adapter      TEXT,
    vendor_version      TEXT,
    pipeline_version    TEXT        NOT NULL,
    status              TEXT        NOT NULL DEFAULT 'pending',
    input_mime_type     TEXT,
    input_source_hash   TEXT,
    page_count          INT,
    block_count         INT,
    node_count          INT,
    warning_count       INT         NOT NULL DEFAULT 0,
    blocking_warning_count INT      NOT NULL DEFAULT 0,
    metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
    error_message       TEXT,
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_extraction_runs_status
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled'))
);

COMMENT ON TABLE  extraction_runs IS 'Vendor-neutral extraction attempts. One run produces pages, blocks, and a draft rule graph.';
COMMENT ON COLUMN extraction_runs.vendor IS 'Source tool family, e.g. mammoth|pdfjs|jina|azure-di|custom.';
COMMENT ON COLUMN extraction_runs.vendor_adapter IS 'HeyBLU adapter module name that normalized vendor output.';
COMMENT ON COLUMN extraction_runs.pipeline_version IS 'HeyBLU canonicalization pipeline version string.';

CREATE INDEX IF NOT EXISTS idx_extraction_runs_version
    ON extraction_runs (rulebook_version_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_extraction_runs_document
    ON extraction_runs (rule_document_id)
    WHERE rule_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_extraction_runs_status
    ON extraction_runs (status);


-- ============================================================
-- PART 2: source_pages
-- Deterministic page-level text from an extraction run.
-- ============================================================

CREATE TABLE IF NOT EXISTS source_pages (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    extraction_run_id   UUID        NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
    rule_document_id    UUID        NOT NULL REFERENCES rule_documents(id) ON DELETE CASCADE,
    page_number         INT         NOT NULL,
    char_offset_start   INT,
    char_offset_end     INT,
    width_pt            NUMERIC,
    height_pt           NUMERIC,
    raw_text            TEXT        NOT NULL,
    layout_metadata     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_source_pages_page_number_positive
        CHECK (page_number > 0),
    CONSTRAINT chk_source_pages_raw_text_nonempty
        CHECK (char_length(trim(raw_text)) > 0),
    CONSTRAINT uq_source_pages_run_doc_page
        UNIQUE (extraction_run_id, rule_document_id, page_number)
);

COMMENT ON TABLE  source_pages IS 'Page-anchored raw text from deterministic extraction. Feeds source_blocks.';
COMMENT ON COLUMN source_pages.layout_metadata IS 'Vendor-neutral layout hints (rotation, columns, margins, etc.).';

CREATE INDEX IF NOT EXISTS idx_source_pages_run
    ON source_pages (extraction_run_id, page_number);

CREATE INDEX IF NOT EXISTS idx_source_pages_document
    ON source_pages (rule_document_id, page_number);


-- ============================================================
-- PART 3: source_blocks
-- Intermediate normalized layout blocks between pages and rule_nodes.
-- ============================================================

CREATE TABLE IF NOT EXISTS source_blocks (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    extraction_run_id   UUID        NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
    source_page_id      UUID        NOT NULL REFERENCES source_pages(id) ON DELETE CASCADE,
    block_index         INT         NOT NULL,
    block_type          TEXT        NOT NULL,
    char_offset_start   INT,
    char_offset_end     INT,
    bbox                JSONB,
    exact_text          TEXT        NOT NULL,
    style_metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_source_blocks_block_index_nonnegative
        CHECK (block_index >= 0),
    CONSTRAINT chk_source_blocks_exact_text_nonempty
        CHECK (char_length(trim(exact_text)) > 0),
    CONSTRAINT chk_source_blocks_type
        CHECK (block_type IN (
            'heading', 'paragraph', 'list_item', 'table', 'footnote',
            'caption', 'image', 'page_break', 'other'
        )),
    CONSTRAINT uq_source_blocks_page_index
        UNIQUE (source_page_id, block_index)
);

COMMENT ON TABLE  source_blocks IS 'Normalized layout blocks. Canonicalizer assigns blocks to rule_nodes.';
COMMENT ON COLUMN source_blocks.exact_text IS 'Verbatim block text from deterministic extraction only.';
COMMENT ON COLUMN source_blocks.bbox IS 'Optional bounding box: {x, y, width, height} in page coordinates.';

CREATE INDEX IF NOT EXISTS idx_source_blocks_run
    ON source_blocks (extraction_run_id);

CREATE INDEX IF NOT EXISTS idx_source_blocks_page
    ON source_blocks (source_page_id, block_index);

CREATE INDEX IF NOT EXISTS idx_source_blocks_exact_text_fts
    ON source_blocks USING gin(to_tsvector('english', exact_text));


-- ============================================================
-- PART 4: rule_nodes
-- Hierarchical canonical rule graph (tree via parent_id).
-- node_type distinguishes structural roles in the rulebook.
-- ============================================================

CREATE TABLE IF NOT EXISTS rule_nodes (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    extraction_run_id   UUID        NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
    rulebook_version_id UUID        NOT NULL REFERENCES rulebook_versions(id) ON DELETE CASCADE,
    parent_id           UUID        REFERENCES rule_nodes(id) ON DELETE CASCADE,
    node_type           TEXT        NOT NULL,
    node_key            TEXT        NOT NULL,
    rule_number         TEXT,
    title               TEXT,
    body_text           TEXT        NOT NULL DEFAULT '',
    sort_order          INT         NOT NULL DEFAULT 0,
    depth               INT         NOT NULL DEFAULT 0,
    materialized_path   TEXT,
    page_start          INT,
    page_end            INT,
    char_start          INT,
    char_end            INT,
    source_block_ids    UUID[]      NOT NULL DEFAULT '{}',
    metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_rule_nodes_type
        CHECK (node_type IN ('chapter', 'rule', 'subrule', 'comment', 'exception', 'penalty')),
    CONSTRAINT chk_rule_nodes_depth_nonnegative
        CHECK (depth >= 0),
    CONSTRAINT chk_rule_nodes_has_content
        CHECK (char_length(trim(coalesce(title, '') || coalesce(body_text, ''))) > 0)
);

COMMENT ON TABLE  rule_nodes IS 'Canonical hierarchical rule graph. One tree per extraction run.';
COMMENT ON COLUMN rule_nodes.node_key IS 'Stable key within a run, e.g. chapter:1, rule:505, subrule:505(a).';
COMMENT ON COLUMN rule_nodes.materialized_path IS 'Human-readable path for QA UI, e.g. ch1/rule505/comment1.';
COMMENT ON COLUMN rule_nodes.source_block_ids IS 'Provenance: source_blocks that contributed to this node.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_rule_nodes_run_key
    ON rule_nodes (extraction_run_id, node_key);

CREATE INDEX IF NOT EXISTS idx_rule_nodes_parent
    ON rule_nodes (parent_id)
    WHERE parent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rule_nodes_version
    ON rule_nodes (rulebook_version_id);

CREATE INDEX IF NOT EXISTS idx_rule_nodes_version_type
    ON rule_nodes (rulebook_version_id, node_type);

CREATE INDEX IF NOT EXISTS idx_rule_nodes_rule_number
    ON rule_nodes (rulebook_version_id, rule_number)
    WHERE rule_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rule_nodes_body_fts
    ON rule_nodes USING gin(
        to_tsvector('english',
            coalesce(rule_number, '') || ' ' ||
            coalesce(title, '') || ' ' ||
            coalesce(body_text, '')
        )
    );


-- ============================================================
-- PART 5: rule_node_chunks
-- Retrieval-sized text slices for hybrid FTS + vector search.
-- ============================================================

CREATE TABLE IF NOT EXISTS rule_node_chunks (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_node_id        UUID        NOT NULL REFERENCES rule_nodes(id) ON DELETE CASCADE,
    extraction_run_id   UUID        NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
    chunk_index         INT         NOT NULL,
    chunk_text          TEXT        NOT NULL,
    char_start          INT,
    char_end            INT,
    source_block_ids    UUID[]      NOT NULL DEFAULT '{}',
    token_count         INT,
    search_vector       tsvector    GENERATED ALWAYS AS (
        to_tsvector('english', chunk_text)
    ) STORED,
    embedding           vector(1536),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_rule_node_chunks_index_nonnegative
        CHECK (chunk_index >= 0),
    CONSTRAINT chk_rule_node_chunks_text_nonempty
        CHECK (char_length(trim(chunk_text)) > 0),
    CONSTRAINT uq_rule_node_chunks_node_index
        UNIQUE (rule_node_id, chunk_index)
);

COMMENT ON TABLE  rule_node_chunks IS 'Search/embeddings layer over rule_nodes. One node may have multiple chunks.';
COMMENT ON COLUMN rule_node_chunks.embedding IS 'OpenAI text-embedding-3-small (1536 dims) or compatible.';

CREATE INDEX IF NOT EXISTS idx_rule_node_chunks_node
    ON rule_node_chunks (rule_node_id, chunk_index);

CREATE INDEX IF NOT EXISTS idx_rule_node_chunks_run
    ON rule_node_chunks (extraction_run_id);

CREATE INDEX IF NOT EXISTS idx_rule_node_chunks_search_vector
    ON rule_node_chunks USING gin(search_vector);

-- Create after embeddings are populated; ivfflat/hnsw require non-empty tables on some PG versions.
-- Uncomment when ready:
-- CREATE INDEX IF NOT EXISTS idx_rule_node_chunks_embedding
--     ON rule_node_chunks USING hnsw (embedding vector_cosine_ops);


-- ============================================================
-- PART 6: canonicalization_warnings
-- Exception-based QA surface for human review before activation.
-- ============================================================

CREATE TABLE IF NOT EXISTS canonicalization_warnings (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    extraction_run_id   UUID        NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
    rulebook_version_id UUID        NOT NULL REFERENCES rulebook_versions(id) ON DELETE CASCADE,
    rule_node_id        UUID        REFERENCES rule_nodes(id) ON DELETE CASCADE,
    source_block_id     UUID        REFERENCES source_blocks(id) ON DELETE SET NULL,
    source_page_id      UUID        REFERENCES source_pages(id) ON DELETE SET NULL,
    warning_code        TEXT        NOT NULL,
    severity            TEXT        NOT NULL DEFAULT 'warning',
    message             TEXT        NOT NULL,
    details             JSONB       NOT NULL DEFAULT '{}'::jsonb,
    is_blocking         BOOLEAN     NOT NULL DEFAULT false,
    resolved_at         TIMESTAMPTZ,
    resolved_by         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_canonicalization_warnings_severity
        CHECK (severity IN ('info', 'warning', 'error', 'blocking'))
);

COMMENT ON TABLE  canonicalization_warnings IS 'Canonicalization QA exceptions. Blocking warnings prevent version activation.';
COMMENT ON COLUMN canonicalization_warnings.warning_code IS 'Machine-readable code, e.g. ORPHAN_BODY, DUPLICATE_RULE, MISSING_PARENT.';

CREATE INDEX IF NOT EXISTS idx_canonicalization_warnings_run
    ON canonicalization_warnings (extraction_run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_canonicalization_warnings_version
    ON canonicalization_warnings (rulebook_version_id);

CREATE INDEX IF NOT EXISTS idx_canonicalization_warnings_unresolved_blocking
    ON canonicalization_warnings (extraction_run_id)
    WHERE is_blocking AND resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_canonicalization_warnings_node
    ON canonicalization_warnings (rule_node_id)
    WHERE rule_node_id IS NOT NULL;


-- ============================================================
-- PART 7: updated_at trigger for extraction_runs / rule_nodes
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_extraction_runs_updated_at ON extraction_runs;
CREATE TRIGGER trg_extraction_runs_updated_at
    BEFORE UPDATE ON extraction_runs
    FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

DROP TRIGGER IF EXISTS trg_rule_nodes_updated_at ON rule_nodes;
CREATE TRIGGER trg_rule_nodes_updated_at
    BEFORE UPDATE ON rule_nodes
    FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

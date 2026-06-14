-- ============================================================
-- HeyBLU — Verified Answer Cache v2 Migration
--
-- Secures cache keys against prompt changes and negative caching.
-- Review first, then execute. Safe to run twice (idempotent).
--
-- After this migration runs, only verifier_status = 'approved' rows
-- are meaningful; all legacy rows are flushed.
-- ============================================================


-- ============================================================
-- PART 1: Add prompt_version to cache key
-- rulebook_version_id remains the rulebook version dimension.
-- ============================================================

ALTER TABLE verified_answer_cache
    ADD COLUMN IF NOT EXISTS prompt_version TEXT;

UPDATE verified_answer_cache
SET    prompt_version = 'legacy-pre-v2'
WHERE  prompt_version IS NULL;

ALTER TABLE verified_answer_cache
    ALTER COLUMN prompt_version SET NOT NULL;

ALTER TABLE verified_answer_cache
    ALTER COLUMN prompt_version SET DEFAULT '2026-06-13';


-- ============================================================
-- PART 2: Replace unique constraint with 4-column key
-- (league_slug, rulebook_version_id, prompt_version, normalized_question)
-- ============================================================

DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    SELECT c.conname
    INTO   constraint_name
    FROM   pg_constraint c
    JOIN   pg_class t ON c.conrelid = t.oid
    WHERE  t.relname = 'verified_answer_cache'
      AND  c.contype = 'u'
      AND  pg_get_constraintdef(c.oid) LIKE '%league_slug%'
      AND  pg_get_constraintdef(c.oid) LIKE '%normalized_question%'
      AND  pg_get_constraintdef(c.oid) NOT LIKE '%prompt_version%';

    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE verified_answer_cache DROP CONSTRAINT %I', constraint_name);
    END IF;
END $$;

DROP INDEX IF EXISTS uq_verified_answer_cache_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_verified_answer_cache_key
    ON verified_answer_cache (league_slug, rulebook_version_id, prompt_version, normalized_question);

CREATE INDEX IF NOT EXISTS idx_vac_prompt_version
    ON verified_answer_cache (prompt_version);


-- ============================================================
-- PART 3: Flush poisoned / stale cache rows
-- ============================================================

DELETE FROM verified_answer_cache
WHERE  verifier_status IS DISTINCT FROM 'approved';

TRUNCATE verified_answer_cache;

COMMENT ON COLUMN verified_answer_cache.prompt_version IS
    'Answer/verifier prompt version. Bump to invalidate cached answers without changing rulebook_version_id.';

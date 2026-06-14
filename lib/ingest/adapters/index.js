/**
 * lib/ingest/adapters/index.js
 *
 * Public exports for vendor extraction adapters.
 */

export {
  BaseAdapter,
  AdapterError,
  BLOCK_ROLE,
  BLOCK_TYPE,
  ROLE_TO_BLOCK_TYPE,
  clampConfidence,
  normalizeBbox,
  roleToBlockType,
  isNonEmptyText,
} from './base-adapter.js';

export {
  GoogleDocAiAdapter,
  transformGoogleDocAi,
} from './google-doc-ai.js';

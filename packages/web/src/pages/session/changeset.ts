/**
 * Session changeset derivation re-exported from the shared package (it moved
 * there so the server can extract `file_edits` rows at index time from the
 * same collector the Files-changed tab renders).
 */

export { buildChangeset, fileStats } from '@claudescope/shared';
export type { FileChange, FileEdit } from '@claudescope/shared';

/** A normalized tool category for cross-agent comparison. Mapping is maintained
 *  here (not in the index), so the taxonomy can evolve without re-indexing. */
export type ToolCategory =
  | 'Edit'
  | 'Read'
  | 'Search'
  | 'Shell'
  | 'Web'
  | 'Subagent'
  | 'Other';

const EDIT = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'apply_patch', 'str_replace', 'str_replace_editor', 'create_file']);
const READ = new Set(['read', 'view', 'read_file']);
const SEARCH = new Set(['grep', 'glob', 'search', 'codebase_search', 'file_search', 'find', 'list_dir', 'ls']);
const SHELL = new Set(['bash', 'shell', 'exec_command', 'run_terminal_cmd', 'terminal', 'execute_command']);
const WEB = new Set(['webfetch', 'websearch', 'web_search', 'fetch', 'browser']);
const SUBAGENT = new Set(['task', 'agent', 'subagent', 'dispatch_agent']);

/** Map a raw (already connector-canonicalized) tool name to a category. */
export function toolCategory(name: string): ToolCategory {
  const n = name.trim().toLowerCase();
  if (n === '') return 'Other';
  if (EDIT.has(n)) return 'Edit';
  if (READ.has(n)) return 'Read';
  if (SEARCH.has(n)) return 'Search';
  if (SHELL.has(n)) return 'Shell';
  if (WEB.has(n)) return 'Web';
  if (SUBAGENT.has(n)) return 'Subagent';
  return 'Other';
}

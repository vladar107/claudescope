import { createContext } from 'react';
import type { RevealSets } from './search.js';

/**
 * Reveal sets for the active in-session search, consumed by collapsible blocks
 * (thinking/tool/subagent) to force themselves open when they contain a match.
 */
export const SessionSearchContext = createContext<RevealSets>({
  blockIds: new Set<string>(),
  subagentIds: new Set<string>(),
});

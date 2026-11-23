import type { SourceId } from './types';

// One hue per source. Kept in sync with --src-* in global.css (canvas needs literal values).
export const SOURCE_COLORS: Record<SourceId, string> = {
  graph: '#9b8cff',
  az: '#4cb3ff',
  entra: '#2fd0b5',
  exchange: '#f2b33d',
  mecm: '#7fd45a',
  errors: '#ff7a6b',
};
export const ALL_COLOR = '#b9c3d6';

export const sourceColor = (s: SourceId | 'all' | string) => (SOURCE_COLORS as Record<string, string>)[s] ?? ALL_COLOR;

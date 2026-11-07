export const OUTPUT = { width: 1920, height: 1080, fps: 30, duration: 60 };
export const VIEWPORT = { desktop: { width: 1280, height: 844 }, mobile: { width: 390, height: 844 } };
export const CHAPTERS = [
  { id: 'browse', start: 0, end: 8, title: 'Browse the changes' },
  { id: 'find', start: 8, end: 15, title: 'Find the file' },
  { id: 'read', start: 15, end: 25, title: 'Read without losing your place' },
  { id: 'compare', start: 25, end: 33, title: 'Compare with an earlier commit' },
  { id: 'markdown', start: 33, end: 41, title: 'Read the documentation too' },
  { id: 'comment', start: 41, end: 53, title: 'Turn a line into feedback' },
  { id: 'result', start: 53, end: 60, title: 'Feedback stays linked to its source' },
] as const;

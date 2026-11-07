import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function fixtureScript(): string {
  const greeting = [
    '/** A warmer welcome. */',
    'export function greeting(name: string) {',
    '  return `Hello, ${name}!`;',
    '}', '',
    'export const examples = [',
    '  "Alex",', '  "Sam",', '  "Taylor",', '];', '',
    '/** Welcome screen copy. */',
    'export const welcome = {',
    '  title: "Welcome back",',
    '  subtitle: "Make yourself at home",',
    '  action: "Get started",',
    '};', '',
    '/** Consistent visitor names. */',
    'export function displayName(name: string) {',
    '  return name.trim();',
    '}', '',
    '/** Short mobile copy. */',
    'export const compact = {',
    '  title: "Welcome",',
    '  action: "Start",',
    '};', '',
    '/** A friendly sign-off. */',
    'export function farewell(name: string) {',
    '  return `See you soon, ${name}!`;',
    '}', '',
  ].join('\n');
  const markdown = '# A warmer welcome\n\nPersonal greetings, wherever you review.\n\n## What changed\n\n- Use a friendlier welcome message\n- Trim spaces from visitor names\n- Keep the mobile copy short\n\n```ts\ngreeting("Alex");\n// Hello, Alex!\n```\n\n## Review checklist\n\n- [x] Read the updated copy\n- [ ] Check empty names\n';
  const files: Record<string, { old: string; current: string; earlier: string; patch?: string; earlierPatch?: string }> = {
    'src/greeting.ts': { current: greeting, old: greeting.replace('Hello, ${name}!', 'Hi, ${name}').replace('See you soon, ${name}!', 'Bye, ${name}.'), earlier: greeting.replace('Hello, ${name}!', 'Hi!').replace('name.trim()', 'name').replace('See you soon, ${name}!', 'Goodbye!') },
    'src/welcome.ts': { current: 'export const welcome = {\n  title: "Welcome back",\n  action: "Get started",\n  compact: "Start",\n};\n', old: 'export const welcome = {\n  title: "Welcome",\n  action: "Continue",\n  compact: "Go",\n};\n', earlier: 'export const welcome = {\n  title: "Welcome",\n  action: "Continue",\n  compact: "Go",\n};\n' },
    'docs/greeting.md': { current: markdown, old: '# Welcome\n\nA greeting for each visitor.\n', earlier: '# Welcome\n\nA greeting for each visitor.\n' },
    'README.md': { current: '# Review demo\n\nA small application with a warmer welcome.\n', old: '', earlier: '' },
    'package.json': { current: '{\n  "name": "review-demo",\n  "private": true\n}\n', old: '', earlier: '' },
  };
  const dir = mkdtempSync(join(tmpdir(), 'showcase-patch-'));
  try {
    for (const [path, file] of Object.entries(files)) {
      for (const [key, before] of [['patch', file.old], ['earlierPatch', file.earlier]] as const) {
        writeFileSync(join(dir, 'before'), before); writeFileSync(join(dir, 'after'), file.current);
        const proc = Bun.spawnSync(['git', 'diff', '--no-index', '--no-ext-diff', '--unified=3', 'before', 'after'], { cwd: dir });
        if (proc.exitCode !== 1) throw new Error(`fixture diff failed for ${path}`);
        const output = new TextDecoder().decode(proc.stdout);
        file[key] = output.replace('a/before b/after', `a/${path} b/${path}`).replace('--- a/before', `--- a/${path}`).replace('+++ b/after', `+++ b/${path}`);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return `(${runtime.toString()})(${JSON.stringify(files)});`;
}

// Runs only after the committed fictional transport and before the real client.
function runtime(files: Record<string, any>) {
  const demoFetch = window.fetch;
  const base = 'b'.repeat(40);
  const changed = ['src/greeting.ts', 'src/welcome.ts', 'docs/greeting.md'];
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    const endpoint = url.pathname;
    if (endpoint.endsWith('/pane/plan')) return Response.json({ plan: null, server_time: '2026-10-19T10:00:00Z' });
    if (endpoint.endsWith('/pane/conversation')) return Response.json({ source: 'claude-transcript', cursor: null, metadata: { model: 'claude-opus-5-5', reasoning_effort: 'medium' }, turns: [
      { role: 'user', ts: '2026-10-19T10:00:00Z', parts: [{ kind: 'text', text: 'Make the welcome copy friendlier and update the guide.' }] },
      { role: 'assistant', ts: '2026-10-19T10:00:02Z', end_ts: '2026-10-19T10:01:00Z', parts: [{ kind: 'text', text: 'Updated the greeting, welcome copy, and documentation. Ready for your review.' }] },
    ] });
    const path = url.searchParams.get('path') || '';
    const filePath = Object.keys(files).find(key => path === key || path.endsWith('/' + key));
    const file = filePath ? files[filePath] : null;
    if (endpoint.endsWith('/workspace/commits')) return Response.json({ commits: [
      { id: 'a'.repeat(40), subject: 'Polish welcome copy', author: 'Alex Demo', date: '2026-10-18T12:00:00Z' },
      { id: base, subject: 'Before greeting update', author: 'Sam Example', date: '2026-10-17T12:00:00Z' },
    ], truncated: false });
    if (endpoint.endsWith('/workspace/changes') || endpoint.endsWith('/workspace/diff') || endpoint.endsWith('/workspace/files')) {
      const lookup = new URL(url); lookup.pathname = '/api/workspace/changes'; lookup.searchParams.delete('base_commit');
      const original = await (await demoFetch(lookup.href)).json();
      const root = original.root;
      const earlier = url.searchParams.has('base_commit');
      const identity = { root, revision: earlier ? 'showcase-earlier' : 'showcase-current', ...(earlier ? { base_commit: base } : {}) };
      if (endpoint.endsWith('/files')) return Response.json({ root, files: Object.keys(files).filter(key => key.toLowerCase().includes((url.searchParams.get('query') || '').toLowerCase())), truncated: false });
      if (endpoint.endsWith('/changes')) return Response.json({ ...identity, files: changed.map(path => ({ path, status: 'modified' })) });
      if (!file) return Response.json({ error: { code: 'not_found', message: 'No fixture file' } }, { status: 404 });
      return Response.json({ ...identity, path: filePath, binary: false, old_file: { name: filePath, contents: earlier ? file.earlier : file.old }, new_file: { name: filePath, contents: file.current }, patch: earlier ? file.earlierPatch : file.patch });
    }
    if (endpoint.endsWith('/workspace/directories')) {
      const data = await (await demoFetch(input, init)).json();
      const sub = path.endsWith('/src') ? 'src' : path.endsWith('/docs') ? 'docs' : path.endsWith('/node_modules') ? 'node_modules' : '';
      data.directories = sub ? [] : ['src', 'docs', 'node_modules'];
      data.ignored_directories = sub ? [] : ['node_modules'];
      data.files = Object.keys(files).filter(key => sub ? key.startsWith(sub + '/') : !key.includes('/')).map(key => ({ name: key.split('/').pop(), size: files[key].current.length }));
      return Response.json(data);
    }
    if (endpoint.endsWith('/fs/stat') && file) return Response.json({ path, name: filePath!.split('/').pop(), size: file.current.length, modified: '2026-10-19T10:00:00Z', mime: filePath!.endsWith('.md') ? 'text/markdown' : 'text/plain', kind: 'text' });
    if (endpoint.endsWith('/fs/file') && file) return new Response(file.current, { headers: { 'content-type': filePath!.endsWith('.md') ? 'text/markdown' : 'text/plain' } });
    return demoFetch(input, init);
  }) as typeof window.fetch;
}

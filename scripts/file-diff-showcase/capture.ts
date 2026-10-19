import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Locator, type Page } from 'playwright-core';
import { buildDemoApp } from '../demo-build.ts';
import { Hand } from '../film/hand.ts';
import { fixtureScript } from './fixture.ts';
import { VIEWPORT } from './timeline.ts';

const root = join(import.meta.dir, '../..');
const out = join(root, '_film/file-diff-showcase');
const device = process.argv[2] === 'mobile' ? 'mobile' : 'desktop';
const probe = process.argv.includes('--probe');
const app = mkdtempSync(join(tmpdir(), 'file-diff-showcase-'));
const dest = join(out, 'takes', device);
mkdirSync(dest, { recursive: true });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let page: Page | undefined;
try {
  await buildDemoApp(app, '');
  writeFileSync(join(app, 'showcase.js'), fixtureScript());
  const index = join(app, 'index.html');
  writeFileSync(index, readFileSync(index, 'utf8').replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n<script src="./showcase.js"></script>\n<script type="module"'));
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/') || path === '/ws' || path.includes('..')) return new Response('No live API', { status: 404 });
    const file = Bun.file(join(app, path === '/' ? 'index.html' : path));
    return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
  } });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--force-device-scale-factor=2'] });
  const context = await browser.newContext({ viewport: VIEWPORT[device], deviceScaleFactor: 2, isMobile: device === 'mobile', hasTouch: device === 'mobile', locale: 'en-US', serviceWorkers: 'block' });
  await context.addInitScript(() => {
    localStorage.setItem('ovis:settings', JSON.stringify({ language: 'en', comments: true, view: 'chat', theme: 'dark', uiFontSize: 16, diffStyle: 'unified', wrapCode: true }));
  });
  page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}/?pane=w1C%3Ap1`);
  await page.locator('.composer-browse').waitFor();
  await page.evaluate(async () => {
    const response = await fetch('/api/pane/rename', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pane_id: 'w1C:p1', label: 'Review the greeting' }) });
    if (!response.ok) throw new Error('Demo pane rename failed');
  });
  await page.getByText('Review the greeting', { exact: true }).first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  const hand = new Hand(page, VIEWPORT[device].width, VIEWPORT[device].height, 2);
  const touches: { t: number; kind: string; x: number; y: number }[] = [];
  const marks: { label: string; t: number }[] = [];
  const checks: string[] = [];
  const mark = (label: string) => { marks.push({ label, t: Date.now() / 1000 }); console.log(`${device}: ${label}`); };
  const hold = (ms = 400) => Bun.sleep(ms); // Intentional film pacing, never a readiness check.
  const click = async (locator: Locator) => {
    await locator.click({ trial: true });
    const box = await locator.evaluate(node => { const b = node.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; });
    assert.ok(box.width > 0 && box.height > 0, 'stable action target');
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    if (device === 'desktop') { await hand.moveTo(x, y, 360); await hand.press(); }
    else {
      const prev = touches.at(-1) || { x: 280, y: 650 };
      const start = Date.now() / 1000;
      for (let i = 0; i <= 12; i++) touches.push({ t: start + i / 12 * 0.36, kind: 'guide', x: prev.x + (x - prev.x) * i / 12, y: prev.y + (y - prev.y) * i / 12 });
      await hold(360); // fixed wait: pacing the recorded showcase for the viewer
      touches.push({ t: Date.now() / 1000, kind: 'tap', x, y });
      await locator.tap();
    }
    await hold(140); // fixed wait: pacing the recorded showcase for the viewer
  };
  const btn = (name: string) => page!.getByRole('button', { name, exact: true });
  const tree = (path: string) => page!.locator(`.workspace-tree-row[title="${path}"]`);
  const section = (path = 'src/greeting.ts') => page!.locator(`[data-diff-path="${path}"]`);
  const back = async () => { if (device === 'mobile' && await btn('Back to files').isVisible()) await click(btn('Back to files')); };
  const openFile = async (path: string) => {
    await back();
    const dir = path.split('/')[0]!;
    if (await tree(dir).getAttribute('aria-expanded') !== 'true') await click(tree(dir));
    await click(tree(path));
  };
  const screenshot = async (name: string) => { if (probe) await page!.screenshot({ path: join(dest, `${name}.png`) }); };
  const scroll = async (distance: number) => {
    const box = await page!.locator('.changes-detail').boundingBox(); assert.ok(box);
    const x = device === 'mobile' ? box.x + box.width * .72 : box.x + box.width * .8;
    if (device === 'desktop') {
      await hand.moveTo(x, box.y + box.height * .55, 300);
      for (let i = 0; i < 16; i++) { await page!.mouse.wheel(0, distance / 16); await hold(30); } // fixed wait: pacing the recorded showcase for the viewer
    } else {
      const cdp = await context.newCDPSession(page!);
      const y0 = box.y + box.height * .7, travel = Math.min(distance, box.height * .5);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
      touches.push({ t: Date.now() / 1000, kind: 'contact', x, y: y0 });
      for (let i = 1; i <= 20; i++) {
        const y = y0 - travel * i / 20;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
        touches.push({ t: Date.now() / 1000, kind: 'contact', x, y }); await hold(30); // fixed wait: pacing the recorded showcase for the viewer
      }
      await hold(100); // fixed wait: pacing the recorded showcase for the viewer
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      touches.push({ t: Date.now() / 1000, kind: 'release', x, y: y0 - travel });
      await cdp.detach();
    }
    await hold(250); // fixed wait: pacing the recorded showcase for the viewer
  };
  await hand.begin();
  mark('browse:start');
  await hold(550); // fixed wait: pacing the recorded showcase for the viewer
  await click(page.locator('.composer-browse'));
  await page.getByRole('dialog', { name: 'Files', exact: true }).waitFor();
  await click(tree('src'));
  assert.equal(await tree('src/greeting.ts').getAttribute('data-status'), 'modified');
  checks.push('browse: changed source and ancestor visible');
  mark('browse:result'); await screenshot('browse'); await hold(600); // fixed wait: pacing the recorded showcase for the viewer
  mark('find:start');
  await click(btn('Find files…'));
  const finder = page.getByRole('combobox', { name: 'Find files…', exact: true });
  await finder.waitFor(); await finder.pressSequentially('greeting', { delay: 65 }); await hold(350); // fixed wait: pacing the recorded showcase for the viewer
  await click(page.getByRole('option', { name: 'src/greeting.ts', exact: true }));
  await section().locator('[data-diff-type]').waitFor();
  checks.push('find: src/greeting.ts diff visible');
  mark('find:result'); await screenshot('find'); await hold(500); // fixed wait: pacing the recorded showcase for the viewer
  if (probe) { console.log('probe complete'); await hand.end(); }
  else {
    mark('read:start');
    const expand = section().locator('[data-expand-button]').first();
    if (await expand.count()) await click(expand);
    else {
      writeFileSync(join(dest, 'diff-dom.html'), await section().evaluate(node => node.outerHTML + Array.from(node.querySelectorAll('*')).map(el => el.shadowRoot?.innerHTML || '').join('\n')));
      throw new Error('context expansion control not found');
    }
    assert.ok(await section().locator('[data-column-number="10"]').count() > 0, 'expanded context reveals line 10');
    await scroll(350);
    assert.ok(await page.locator('.changes-detail').evaluate(node => node.scrollTop) > 30, 'real gesture scrolls the diff');
    const headerBox = await section().locator('.changes-diff-header').boundingBox();
    const detailBox = await page.locator('.changes-detail').boundingBox();
    assert.ok(headerBox && detailBox && Math.abs(headerBox.y - detailBox.y) < 4, 'filename remains pinned while scrolling');
    await screenshot('scroll');
    await click(section().getByRole('button', { name: 'Reveal in file tree', exact: true }));
    assert.equal(await tree('src/greeting.ts').getAttribute('aria-current'), 'true');
    if (device === 'mobile') await click(tree('src/greeting.ts'));
    checks.push('read: context expanded; sticky header reveal selects source');
    mark('read:result'); await hold(400); // fixed wait: pacing the recorded showcase for the viewer
    mark('compare:start');
    await click(btn('Compare with…'));
    await click(page.locator('.commit-picker-option').filter({ hasText: 'Before greeting update' }));
    await section().locator('[data-diff-type]').waitFor();
    assert.equal(await btn('Compare with…').getAttribute('data-base-commit'), 'b'.repeat(40));
    checks.push('compare: prior commit selected');
    mark('compare:result'); await screenshot('compare'); await hold(700); // fixed wait: pacing the recorded showcase for the viewer
    mark('markdown:start');
    await openFile('docs/greeting.md');
    await click(page.getByRole('group', { name: 'Markdown view', exact: true }).getByRole('button', { name: 'Preview', exact: true }));
    await page.locator('.file-viewer-markdown').getByRole('heading', { name: 'A warmer welcome', exact: true }).waitFor();
    await screenshot('preview'); await hold(850); // fixed wait: pacing the recorded showcase for the viewer
    await click(page.getByRole('group', { name: 'Markdown view', exact: true }).getByRole('button', { name: 'Diff', exact: true }));
    await section('docs/greeting.md').locator('[data-diff-type]').waitFor();
    checks.push('markdown: rendered Preview then Diff');
    mark('markdown:result'); await screenshot('markdown'); await hold(450); // fixed wait: pacing the recorded showcase for the viewer
    mark('comment:start');
    await openFile('src/greeting.ts');
    await section().locator('[data-diff-type]').waitFor();
    const line = section().locator('[data-code][data-additions] [data-column-number="3"], [data-code][data-unified] [data-line-type="change-addition"][data-column-number="3"]').first();
    await click(line);
    const field = page.locator('.diff-comment-editor').getByRole('textbox', { name: 'Comment', exact: true });
    await field.waitFor();
    await field.pressSequentially('Handle empty names.', { delay: 65 });
    await screenshot('comment'); await hold(600); // fixed wait: pacing the recorded showcase for the viewer
    await click(btn('Save comment'));
    await field.waitFor({ state: 'detached' });
    await section().locator('.diff-comment-card').filter({ hasText: 'Handle empty names.' }).waitFor();
    await click(btn('Close files'));
    await page.getByRole('dialog', { name: 'Files', exact: true }).waitFor({ state: 'detached' });
    await page.locator('.composer-comments-bar').waitFor();
    assert.equal((await page.locator('.composer-comments-bar').innerText()).trim(), '1 comment');
    checks.push('comment: line 3, new side, saved feedback in composer');
    mark('comment:result'); await screenshot('result'); await hold(400); // fixed wait: pacing the recorded showcase for the viewer
    mark('result:start');
    await click(page.locator('.composer-comments-walk'));
    await field.waitFor(); assert.equal(await field.inputValue(), 'Handle empty names.');
    assert.match(await page.locator('.diff-comment-heading').innerText(), /greeting.ts:3/);
    await hold(700); // fixed wait: pacing the recorded showcase for the viewer
    checks.push('result: composer link reopens exact saved source and comment');
    mark('result:result'); await hold(400); // fixed wait: pacing the recorded showcase for the viewer
    const recording = await hand.end();
    // Check the disclosure after filming so the two device timelines stay matched.
    const hint = page.locator('.diff-comment-hint');
    const info = page.locator('.diff-comment-info');
    assert.equal(await hint.isVisible(), device === 'desktop');
    assert.equal(await info.isVisible(), device === 'mobile');
    if (device === 'mobile') {
      const actions = page.locator('.diff-comment-actions');
      const compactHeight = (await actions.boundingBox())!.height;
      assert.ok(compactHeight <= 48, 'mobile comment actions fit on one touch-height row');
      await field.fill('Keep this unsaved edit.');
      await info.tap();
      assert.equal(await info.getAttribute('aria-expanded'), 'true');
      assert.equal(await hint.isVisible(), true);
      assert.equal(await hint.innerText(), 'Saved comments are included with your next chat message.');
      await info.tap();
      assert.equal(await info.getAttribute('aria-expanded'), 'false');
      assert.equal(await hint.isVisible(), false);
      assert.equal(await field.inputValue(), 'Keep this unsaved edit.');
      assert.equal((await actions.boundingBox())!.height, compactHeight);
      await info.focus();
      await info.press('Enter');
      assert.equal(await hint.isVisible(), true, 'keyboard activation expands help');
      await info.press('Space');
      assert.equal(await hint.isVisible(), false, 'keyboard activation collapses help');
    }
    checks.push('comment hint: desktop text or compact touch and keyboard disclosure; draft preserved');
    assert.deepEqual(errors, [], 'no application exceptions');
    const framesDir = join(dest, 'frames'); mkdirSync(framesDir, { recursive: true });
    recording.frames.forEach((frame, i) => writeFileSync(join(framesDir, `${String(i).padStart(6, '0')}.jpg`), frame.jpeg));
    writeFileSync(join(dest, 'frames.json'), JSON.stringify({ width: recording.width, height: recording.height, start: recording.start, end: recording.end, frames: recording.frames.map((f, i) => ({ t: f.t - recording.start, file: `${String(i).padStart(6, '0')}.jpg` })) }));
    writeFileSync(join(dest, 'cues.json'), JSON.stringify([...recording.cues, ...touches].sort((a,b) => a.t-b.t).map(c => ({ ...c, t: c.t - recording.start }))));
    writeFileSync(join(dest, 'marks.json'), JSON.stringify(marks.map(m => ({ ...m, t: m.t - recording.start }))));
    writeFileSync(join(dest, 'verification.json'), JSON.stringify({ device, checks, errors, viewport: VIEWPORT[device] }, null, 2));
    console.log(`PASS ${device}: ${checks.length} workflow checks; ${recording.frames.length} frames`);
  }
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(dest, 'failure.png') }).catch(() => {});
    writeFileSync(join(dest, 'failure.txt'), await page.locator('body').innerText().catch(() => ''));
  }
  throw error;
} finally {
  await browser?.close(); server?.stop(true); rmSync(app, { recursive: true, force: true });
}

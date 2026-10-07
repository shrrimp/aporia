// Desktop editor check: opens a workspace file in the real Electron app (Monaco, its worker, the
// app's CSP), types, saves, and fails on any page error or renderer crash.
// Usage: node e2e/editor.ts   (build the UI and the shell first, as for smoke.ts)
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { brand } from '@app/brand';

const here = path.dirname(fileURLToPath(import.meta.url));
const data = await mkdtemp(path.join(tmpdir(), 'desktop-editor-'));
const ws = await mkdtemp(path.join(tmpdir(), 'desktop-editor-ws-'));
await mkdir(path.join(ws, 'physics'));
await writeFile(path.join(ws, 'physics', 'Joint.cpp'), 'void integratePosition() {\n    // TODO\n}\n');
// One of each kind a C++ project holds: each loads its own syntax colouring.
const others = { 'README.md': '# Engine\n\nNotes.\n', 'CMakeLists.txt': 'project(engine)\n', 'build_linux.sh': '#!/bin/sh\ncmake -S . -B build\n', 'notes.txt': 'plain\n', 'imgui.ini': '[Window]\nPos=0,0\n', 'data.json': '{"a": 1}\n', 'Joint.h': '#pragma once\n' };
for (const [name, content] of Object.entries(others)) await writeFile(path.join(ws, name), content);
const app = await electron.launch({
  args: [path.join(here, '..')],
  // VISIBLE=1 shows the window: the GPU and window-system paths only run then.
  env: { ...process.env, [`${brand.envPrefix}_DATA_DIR`]: data, ...(process.env['VISIBLE'] ? {} : { [`${brand.envPrefix}_HIDDEN_WINDOW`]: '1' }) },
});
const problems: string[] = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('crash', () => problems.push('renderer crashed'));
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  await page.getByPlaceholder('Your name').fill('Editor');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: '+ Start a new project' }).click();
  await page.getByLabel(/What do you want/).fill('Engine');
  await page.getByLabel('Describe the goal').fill('Edit a file');
  await page.getByLabel('Workspace folder').fill(ws);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: 'Editor' }).click();
  await page.getByRole('button', { name: 'physics/' }).click();
  await page.getByRole('button', { name: 'Joint.cpp' }).click();
  await page.locator('.monaco-editor .view-lines').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('// saved from the app');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(800);
  const saved = await readFile(path.join(ws, 'physics', 'Joint.cpp'), 'utf8');
  if (!saved.includes('// saved from the app')) problems.push('the edit was not saved');
  // Every other kind of file, back and forth, then the editor closed and opened again.
  await page.getByRole('button', { name: 'workspace' }).click().catch(() => undefined);
  await page.getByRole('button', { name: '← up' }).click();
  for (const name of [...Object.keys(others), 'README.md', 'notes.txt']) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.locator('.editor-path', { hasText: name }).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(300);
  }
  await page.getByRole('button', { name: 'Editor' }).click();
  await page.getByRole('button', { name: 'Editor' }).click();
  await page.getByRole('button', { name: 'README.md', exact: true }).click();
  await page.locator('.monaco-editor .view-lines').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  if (await page.locator('#root').evaluate((r) => r.childElementCount === 0)) problems.push('the window is blank');
} catch (err) {
  problems.push(`step failed: ${(err as Error).message.split('\n').slice(0, 4).join(' / ')}`);
} finally {
  await app.close();
  await rm(data, { recursive: true, force: true });
  await rm(ws, { recursive: true, force: true });
}
if (problems.length) {
  console.error(`desktop editor: FAILED\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('desktop editor: OK');

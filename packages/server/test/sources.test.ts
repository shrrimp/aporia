import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentHost, genericAgent } from '@app/agent-host';
import { ManualClock } from '@app/core';
import { AppService } from '../src/index.ts';
import { decodeText, extract, htmlToText, MAX_TEXT_CHARS } from '../src/extract.ts';
import { MAX_CHUNK_BYTES, Uploads, cleanName } from '../src/sources.ts';
import { fakeTeacherAgent } from './fake-teacher-agent.ts';
import { makePdf } from './fixtures/pdf.ts';

const enc = (s: string) => new TextEncoder().encode(s);

describe('extracting text', () => {
  it('reads text, code and Markdown as they are', async () => {
    expect(await extract('notes.md', enc('# Title\r\nBody'))).toEqual({ kind: 'markdown', text: '# Title\nBody' });
    expect(await extract('Joint.cpp', enc('\uFEFFvoid f();'))).toEqual({ kind: 'code', text: 'void f();' });
    expect(await extract('CMakeLists.txt', enc('project(x)'))).toMatchObject({ kind: 'code' });
    expect(await extract('data.csv', enc('a,b'))).toMatchObject({ kind: 'text' });
    expect(await extract('README', enc('plain'))).toMatchObject({ kind: 'text', text: 'plain' });
    expect(await extract('icon.svg', enc('<svg/>'))).toMatchObject({ kind: 'text' });
  });

  it('turns HTML into readable text with its structure', async () => {
    const html = `<!doctype html><html><head><title>Four Numbers</title><style>p{}</style></head><body>
      <h1>Four &amp; Three</h1><p>A <code>quat</code> has four&nbsp;numbers &#8212; &#x3b8; &unknown;</p>
      <script>alert(1)</script><!-- hidden --><ul><li>one</li><li>two</li></ul>
      <pre><code class="cpp">if (a &lt; b) {
  <span>x</span> = 1;
}</code></pre><table><tr><td>q</td><td>v</td></tr></table><br/>end</body></html>`;
    const r = await extract('lesson.html', enc(html));
    expect(r.kind).toBe('html');
    expect(r.text).toContain('# Four Numbers');
    expect(r.text).toContain('# Four & Three');
    expect(r.text).toContain('A `quat` has four numbers — θ &unknown;');
    expect(r.text).toContain('- one\n- two');
    expect(r.text).toContain('```\nif (a < b) {\n  x = 1;\n}\n```');
    expect(r.text).toContain('| q | v |');
    expect(r.text).not.toMatch(/alert|hidden|p\{\}/);
    expect((await extract('page', enc('<!DOCTYPE html><p>x</p>'))).kind).toBe('html');
    expect(htmlToText('<p>&#0; &#99999999;</p>')).toBe('&#0; &#99999999;');
    expect(htmlToText('<p>v<sub>i</sub> = X<sub>i←λ</sub> v<sub>&lambda;</sub>, w<sup>2</sup>, e<sup><b>iθ</b></sup>, x<sub> </sub></p>')).toBe('v_i = X_{i←λ} v_λ, w^2, e^{iθ}, x');
    expect(htmlToText('<p>&ldquo;q&rdquo; &omega;&sup2; &frac12; &sect;4.5 &AMP; &notreal;</p>')).toBe('“q” ω² ½ §4.5 & &notreal;');
    expect(htmlToText('<div>\n    indented\n    <pre>  kept\n    as is</pre></div>')).toBe('indented\n\n```\n  kept\n    as is\n```');
  });

  it('reads PDFs page by page, and says when it cannot', async () => {
    const r = await extract('paper.pdf', makePdf(['Featherstone articulated bodies', 'Spatial algebra (6D)']));
    expect(r).toMatchObject({ kind: 'pdf', pages: 2 });
    expect(r.text).toMatch(/^\[page 1\]\nFeatherstone articulated bodies\n\n\[page 2\]\nSpatial algebra \(6D\)$/);
    expect(await extract('blank.pdf', makePdf(['']))).toMatchObject({ kind: 'pdf', text: '', note: expect.stringMatching(/no text layer/) });
    expect(await extract('broken.pdf', enc('%PDF-1.4 garbage'))).toMatchObject({ kind: 'pdf', text: '', note: expect.stringMatching(/could not be read/) });
  });

  it('keeps binary files without text, and bounds very long text', async () => {
    expect(await extract('photo.png', new Uint8Array([137, 80, 78, 71]))).toMatchObject({ kind: 'image', text: '' });
    expect(await extract('blob.bin', new Uint8Array([1, 0, 2]))).toMatchObject({ kind: 'other', text: '' });
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x41]))).toBeUndefined();
    const long = await extract('big.txt', enc('x'.repeat(MAX_TEXT_CHARS + 10)));
    expect(long.text).toMatch(/the rest of this file was not kept/);
  });

  it('cleans file names', () => {
    expect(cleanName('C:\\Users\\me\\paper.pdf')).toBe('paper.pdf');
    expect(cleanName('/home/me/notes\u0007.md')).toBe('notes.md');
    expect(cleanName('dir/')).toBe('file');
  });
});

describe('uploads', () => {
  it('assembles chunks in order, within the announced size, and forgets old ones', () => {
    let now = 0;
    const u = new Uploads(() => now);
    const id = u.begin('p', 'a.txt', 5);
    expect(() => u.chunk(id, 1, 'aGk=')).toThrow(/expected chunk 0/);
    expect(u.chunk(id, 0, Buffer.from('hel').toString('base64'))).toBe(3);
    expect(u.chunk(id, 1, Buffer.from('lo').toString('base64'))).toBe(5);
    expect(u.finish(id)).toMatchObject({ projectId: 'p', name: 'a.txt', data: Buffer.from('hello') });
    expect(() => u.finish(id)).toThrow(/unknown or expired/);

    const short = u.begin('p', 'b.txt', 4);
    u.chunk(short, 0, Buffer.from('ab').toString('base64'));
    expect(() => u.finish(short)).toThrow(/incomplete/);
    const over = u.begin('p', 'c.txt', 1);
    expect(() => u.chunk(over, 0, Buffer.from('ab').toString('base64'))).toThrow(/larger than announced/);
    const big = u.begin('p', 'd.txt', 10 * MAX_CHUNK_BYTES);
    expect(() => u.chunk(big, 0, Buffer.alloc(MAX_CHUNK_BYTES + 1).toString('base64'))).toThrow(/chunk too large/);
    expect(() => u.begin('p', 'e.txt', 60 * 1024 * 1024)).toThrow(/larger than 50 MB/);

    const stale = u.begin('p', 'f.txt', 1);
    now += 11 * 60_000;
    expect(() => u.chunk(stale, 0, 'YQ==')).toThrow(/expired/);
    for (let i = 0; i < 16; i++) u.begin('p', `${i}.txt`, 1);
    expect(() => u.begin('p', 'one-too-many.txt', 1)).toThrow(/Too many files/);
  });
});

describe('sources in a project', () => {
  let root: string;
  let app: AppService;
  let clock: ManualClock;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sources-'));
    clock = new ManualClock('2026-10-07T10:00:00.000Z');
    app = new AppService({
      dataRoot: root,
      clock,
      agent: genericAgent('fake', 'Fake', { command: 'unused', args: [] }),
      hostFactory: (s) => AgentHost.inProcess(fakeTeacherAgent(), s),
    });
  });
  afterEach(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  async function upload(projectId: string, name: string, data: Uint8Array) {
    clock.advance(1000);
    const { uploadId } = await app.call('sources.begin', { projectId, name, size: data.length });
    for (let i = 0, off = 0; off < data.length || i === 0; i++, off += MAX_CHUNK_BYTES) {
      await app.call('sources.chunk', { uploadId, index: i, data: Buffer.from(data.subarray(off, off + MAX_CHUNK_BYTES)).toString('base64') });
    }
    return app.call('sources.finish', { uploadId });
  }

  it('copies files in, keeps one copy of identical content, and lets the learner remove and restore them', async () => {
    const p = await app.call('profiles.create', { displayName: 'Ada' });
    await app.call('profiles.open', { profileId: p.id });
    const { id: projectId } = await app.call('projects.create', { title: 'HMP', goal: 'g' });
    expect(await app.call('sources.list', { projectId })).toEqual([]);

    const paper = await upload(projectId, '/home/me/Downloads/paper.pdf', makePdf(['Spatial vectors']));
    expect(paper).toMatchObject({ name: 'paper.pdf', kind: 'pdf', pages: 1, existed: false });
    const big = new Uint8Array(MAX_CHUNK_BYTES * 2 + 5).fill(0x61);
    const notes = await upload(projectId, 'notes.txt', big);
    expect(notes).toMatchObject({ kind: 'text', size: big.length, chars: big.length });
    expect(await upload(projectId, 'copy-of-notes.txt', big)).toMatchObject({ id: notes.id, existed: true });
    expect((await app.call('sources.list', { projectId })).map((s) => s.name)).toEqual(['paper.pdf', 'notes.txt']);
    expect(await app.call('sources.text', { projectId, sourceId: paper.id })).toEqual({ text: '[page 1]\nSpatial vectors', truncated: false });
    expect((await app.call('sources.text', { projectId, sourceId: notes.id })).truncated).toBe(true);
    // The original is kept as it was.
    const dir = path.join(root, 'profiles', p.id, 'projects', projectId, 'sources', notes.id);
    expect((await readFile(path.join(dir, 'original'))).length).toBe(big.length);

    await app.call('sources.remove', { projectId, sourceId: paper.id });
    expect((await app.call('sources.list', { projectId })).map((s) => s.name)).toEqual(['notes.txt']);
    const removal = (await app.call('history.list', {})).find((h) => h.summary === 'removed the file "paper.pdf"')!;
    await app.call('history.undo', { id: removal.id });
    expect((await app.call('sources.list', { projectId })).map((s) => s.name)).toEqual(['paper.pdf', 'notes.txt']);

    await expect(app.call('sources.remove', { projectId, sourceId: 'src_nope' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(app.call('sources.text', { projectId, sourceId: 'src_nope' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(app.call('sources.text', { projectId, sourceId: '../../x' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(app.call('sources.begin', { projectId: 'nope', name: 'x', size: 1 })).rejects.toMatchObject({ code: 'not_found' });
  });
});

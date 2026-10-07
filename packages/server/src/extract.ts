import path from 'node:path';
import { characterEntities } from 'character-entities';

/**
 * Text from an imported file, made locally (teaching-engine §6: imported files never leave the
 * machine except when the tutor reads them). PDFs get `[page N]` markers, so the tutor can say
 * where an idea comes from.
 */
export interface Extracted {
  readonly kind: 'text' | 'markdown' | 'html' | 'code' | 'pdf' | 'image' | 'other';
  /** Empty when there is no text to take (an image, an unknown binary). */
  readonly text: string;
  readonly pages?: number;
  /** Why there is no text, when there is none. */
  readonly note?: string;
}

/** Text kept per file: enough for a book chapter, bounded so a huge file cannot fill the profile. */
export const MAX_TEXT_CHARS = 4_000_000;

const CODE = new Set([
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'inl', 'ipp', 'cu', 'py', 'rs', 'go', 'java', 'kt', 'cs', 'swift', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'rb', 'php', 'lua', 'zig', 'jl', 'm', 'r', 'scala', 'hs', 'ml', 'glsl', 'vert', 'frag', 'comp', 'hlsl', 'wgsl', 'metal', 'sh', 'bash', 'zsh', 'ps1', 'cmake',
  'sql', 'proto',
]);
const TEXT = new Set(['txt', 'text', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'tex', 'bib', 'rst', 'adoc', 'org']);
const MARKDOWN = new Set(['md', 'markdown', 'mdx']);
const HTML = new Set(['html', 'htm', 'xhtml']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);
const NAMED_CODE = new Set(['makefile', 'cmakelists.txt', 'dockerfile', 'justfile', 'meson.build', 'build.zig']);

export function extensionOf(name: string): string {
  return path.extname(name).slice(1).toLowerCase();
}

/** UTF-8 text, or undefined for binary data (NUL bytes, invalid UTF-8). */
export function decodeText(data: Uint8Array): string | undefined {
  if (data.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  } catch {
    return undefined;
  }
}

/** Every named HTML entity (&ldquo;, &omega;, &sup2;…), numeric ones too; unknown names are kept as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    const named = characterEntities[e];
    return named === undefined ? m : named === '\u00a0' ? ' ' : named;
  });
}

/**
 * HTML as readable text with its structure kept (headings, lists, code, paragraphs), Markdown-
 * style. Scripts and styles are dropped. Not a full HTML parser; a page's words, in order, is the
 * goal. Every pattern is linear: tags are matched by their own delimiters.
 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, (m) => {
      const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(m);
      return title ? `\n# ${title[1]!.trim()}\n` : '';
    });
  // Code blocks keep their text exactly (tags inside them stripped, entities decoded later).
  const blocks: string[] = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, body: string) => {
    blocks.push(body.replace(/<[^>]*>/g, ''));
    return `\n\u0000${blocks.length - 1}\u0000\n`;
  });
  // Sub- and superscripts keep their meaning in the text: v<sub>i</sub> → v_i, X<sub>i←λ</sub> → X_{i←λ}.
  const script = (mark: string) => (_: string, body: string) => {
    const t = decodeEntities(body.replace(/<[^>]*>/g, '')).trim();
    return t === '' ? '' : `${mark}${[...t].length === 1 ? t : `{${t}}`}`;
  };
  s = s.replace(/<sub\b[^>]*>([\s\S]*?)<\/sub\s*>/gi, script('_')).replace(/<sup\b[^>]*>([\s\S]*?)<\/sup\s*>/gi, script('^'));
  s = s
    .replace(/<h([1-6])\b[^>]*>/gi, (_, n: string) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<\/h[1-6]\s*>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/tr\s*>/gi, ' |\n')
    .replace(/<(td|th)\b[^>]*>/gi, '| ')
    .replace(/<\/(td|th)\s*>/gi, ' ')
    .replace(/<\/?(p|div|section|article|header|footer|main|aside|nav|ul|ol|table|tr|thead|tbody|blockquote|figure|figcaption|details|summary|dl|dt|dd)\b[^>]*>/gi, '\n')
    .replace(/<code\b[^>]*>/gi, '`')
    .replace(/<\/code\s*>/gi, '`')
    .replace(/<[^>]*>/g, '');
  s = decodeEntities(s)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n') // the page's source indentation, not the text's (code blocks are kept aside)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `\`\`\`\n${decodeEntities(blocks[Number(i)]!).replace(/\n+$/, '')}\n\`\`\``);
  return s.trim();
}

/** Text of a PDF, page by page. Uses pdf.js (bundled; no network, no scripts run). */
async function pdfText(data: Uint8Array): Promise<{ text: string; pages: number }> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(data));
  const { totalPages, text } = await extractText(doc, { mergePages: false });
  return { pages: totalPages, text: text.map((t, i) => `[page ${i + 1}]\n${t.trim()}`).join('\n\n') };
}

const clip = (t: string) => (t.length > MAX_TEXT_CHARS ? `${t.slice(0, MAX_TEXT_CHARS)}\n\n[… the rest of this file was not kept: it is longer than ${MAX_TEXT_CHARS} characters]` : t);

export async function extract(name: string, data: Uint8Array): Promise<Extracted> {
  const ext = extensionOf(name);
  if (ext === 'pdf' || (data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46)) {
    try {
      const { text, pages } = await pdfText(data);
      return text.replace(/\[page \d+\]/g, '').trim() === ''
        ? { kind: 'pdf', text: '', pages, note: 'This PDF has no text layer (a scan?). Text recognition is not supported yet.' }
        : { kind: 'pdf', text: clip(text), pages };
    } catch (err) {
      return { kind: 'pdf', text: '', note: `The PDF could not be read: ${(err as Error).message}` };
    }
  }
  if (IMAGE.has(ext) && ext !== 'svg') return { kind: 'image', text: '', note: 'An image: kept as it is, with no text taken from it.' };
  const text = decodeText(data);
  if (text === undefined) return { kind: 'other', text: '', note: 'Not a text file: kept as it is, with no text taken from it.' };
  if (HTML.has(ext) || (ext === '' && /^\s*<(!doctype html|html)\b/i.test(text))) return { kind: 'html', text: clip(htmlToText(text)) };
  if (MARKDOWN.has(ext)) return { kind: 'markdown', text: clip(text) };
  if (CODE.has(ext) || NAMED_CODE.has(path.basename(name).toLowerCase())) return { kind: 'code', text: clip(text) };
  if (TEXT.has(ext) || ext === 'svg') return { kind: 'text', text: clip(text) };
  return { kind: 'text', text: clip(text) };
}

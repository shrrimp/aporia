import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { SourceDTO } from '@app/server/protocol';
import type { RpcClient } from './rpc.ts';

/** Bytes per chunk sent to the app (its socket messages are capped at 4 MB, base64 adds a third). */
export const CHUNK_BYTES = 1024 * 1024;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Copy one file into the project. The file is read here and sent in chunks: the project keeps
 * its own copy, so where the file was on disk never matters again.
 */
export async function uploadFile(rpc: RpcClient, projectId: string, file: File, onProgress?: (sent: number) => void): Promise<SourceDTO & { existed: boolean }> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`"${file.name}" is larger than 50 MB`);
  const data = new Uint8Array(await file.arrayBuffer());
  const { uploadId } = await rpc.call('sources.begin', { projectId, name: file.name, size: data.length });
  let index = 0;
  for (let off = 0; off < data.length || index === 0; off += CHUNK_BYTES) {
    await rpc.call('sources.chunk', { uploadId, index: index++, data: toBase64(data.subarray(off, off + CHUNK_BYTES)) });
    onProgress?.(Math.min(data.length, off + CHUNK_BYTES));
  }
  return rpc.call('sources.finish', { uploadId });
}

export const formatSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** A button that opens the system's file picker (several files at once). */
export function AddFilesButton({ onFiles, label = 'Add files' }: { onFiles: (files: File[]) => void; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="text add-files" onClick={() => input.current?.click()}>
        {label}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label={label}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

/** Files can be dropped anywhere on its children; a frame shows while a file is dragged over. */
export function FileDrop({ onFiles, children, className = '' }: { onFiles: (files: File[]) => void; children?: ReactNode; className?: string }) {
  const [over, setOver] = useState(false);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  return (
    <div
      className={`file-drop ${over ? 'over' : ''} ${className}`}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) onFiles(files);
      }}
    >
      {children}
      {over && <div className="drop-hint" aria-hidden>Drop to add to this project</div>}
    </div>
  );
}

/** Upload files one after another, reporting each as a chip. */
export function useAttach(rpc: RpcClient, projectId: string | undefined) {
  const [items, setItems] = useState<Attached[]>([]);
  const add = async (files: File[]) => {
    if (!projectId) return;
    for (const file of files) {
      const key = `${file.name}:${file.size}:${Math.random()}`;
      setItems((xs) => [...xs, { key, name: file.name, state: 'sending' }]);
      try {
        const source = await uploadFile(rpc, projectId, file);
        setItems((xs) => xs.map((x) => (x.key === key ? { ...x, state: 'done', source } : x)));
      } catch (err) {
        setItems((xs) => xs.map((x) => (x.key === key ? { ...x, state: 'error', error: (err as Error).message } : x)));
      }
    }
  };
  return { items, add, remove: (key: string) => setItems((xs) => xs.filter((x) => x.key !== key)), clear: () => setItems([]) };
}

export interface Attached {
  readonly key: string;
  readonly name: string;
  readonly state: 'sending' | 'done' | 'error';
  readonly source?: SourceDTO;
  readonly error?: string;
}

/** Files on their way into the project, or just added, shown as chips. */
export function AttachedList({ items, onRemove }: { items: readonly Attached[]; onRemove?: (key: string) => void }) {
  if (items.length === 0) return null;
  return (
    <ul className="attached" aria-label="Added files">
      {items.map((a) => (
        <li key={a.key} className={`state-${a.state}`}>
          <span className="name">{a.name}</span>
          <span className="quiet">
            {a.state === 'sending' ? ' adding…' : a.state === 'error' ? ` ${a.error}` : a.source?.note ? ` ${a.source.note}` : a.source ? ` ${formatSize(a.source.size)}` : ''}
          </span>
          {onRemove && (
            <button type="button" className="text" aria-label={`Do not mention ${a.name}`} onClick={() => onRemove(a.key)}>
              ×
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

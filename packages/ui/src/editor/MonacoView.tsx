import { useEffect, useRef } from 'react';
import { monaco } from './monaco.ts';
import type { CodeViewProps } from './Editor.tsx';

let themed = false;

/** The app's dark look, from the same tokens as styles.css. */
function defineTheme(): void {
  if (themed) return;
  themed = true;
  monaco.editor.defineTheme('aporia', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '5f646d', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'a7b8cf' },
      { token: 'string', foreground: '8fbf9f' },
      { token: 'number', foreground: 'cbb27a' },
    ],
    colors: {
      'editor.background': '#070708',
      'editor.foreground': '#cfd2d7',
      'editorLineNumber.foreground': '#3c4048',
      'editorLineNumber.activeForeground': '#9399a3',
      'editor.lineHighlightBackground': '#0d0e10',
      'editor.selectionBackground': '#a7b8cf33',
      'editorCursor.foreground': '#c9d5e5',
      'editorIndentGuide.background1': '#1c1e22',
      'editorWidget.background': '#0d0e10',
      'editorWidget.border': '#2a2d33',
    },
  });
}

/**
 * Monaco for one file. One model per path, kept while the pane is open, so undo history survives
 * switching files. Only the real app loads this (lazily); tests use a plain textarea instead.
 */
export default function MonacoView({ path, value, revision, onChange, onSave, readOnly }: CodeViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<ReturnType<typeof monaco.editor.create>>(undefined);
  const latest = useRef({ onChange, onSave });
  latest.current = { onChange, onSave };

  useEffect(() => {
    defineTheme();
    const e = monaco.editor.create(host.current!, {
      theme: 'aporia',
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: 'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      tabSize: 4,
    });
    e.onDidChangeModelContent(() => latest.current.onChange(e.getValue()));
    e.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => latest.current.onSave(e.getValue()));
    editor.current = e;
    return () => {
      for (const m of monaco.editor.getModels()) m.dispose();
      e.dispose();
    };
  }, []);

  const valueRef = useRef(value);
  valueRef.current = value;
  // Only when a file is opened or reloaded from disk: see CodeViewProps.revision.
  useEffect(() => {
    const e = editor.current!;
    const uri = monaco.Uri.file(`/${path}`);
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(valueRef.current, undefined, uri);
    if (model.getValue() !== valueRef.current) model.setValue(valueRef.current);
    e.setModel(model);
  }, [path, revision]);

  useEffect(() => {
    editor.current!.updateOptions({ readOnly });
  }, [readOnly]);

  return <div className="monaco-host" ref={host} />;
}

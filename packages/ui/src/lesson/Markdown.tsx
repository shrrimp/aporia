import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

/** Lesson text: CommonMark + TeX. react-markdown never renders raw HTML, so agent text cannot inject markup. */
export function Markdown({ md, inline = false }: { md: string; inline?: boolean }) {
  return (
    <div className={inline ? 'md md-inline' : 'md'}>
      <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]} skipHtml>
        {md}
      </ReactMarkdown>
    </div>
  );
}

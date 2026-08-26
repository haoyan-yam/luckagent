import { marked } from 'marked';

/**
 * 只读 Markdown 渲染（记忆/SKILL.md 明细用）。
 * 内容来自本机自家 bot 的文件，信任级别高；仍先转义类标签的 `<` 防止
 * 意外的原生 HTML 注入（代码块里的 <xxx> 会显示为字面量，可接受）。
 */
export function renderMarkdown(md: string): { __html: string } {
  const escaped = md.replace(/<(?=[a-zA-Z/!])/g, '&lt;');
  return { __html: marked.parse(escaped, { async: false, breaks: true }) as string };
}

export function MarkdownView({ text }: { text: string }) {
  return (
    <div
      className="md-view"
      style={{ lineHeight: 1.7, wordBreak: 'break-word' }}
      dangerouslySetInnerHTML={renderMarkdown(text)}
    />
  );
}

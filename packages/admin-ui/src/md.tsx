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

/**
 * onLinkClick：拦截正文里的链接点击（如记忆之间的互相引用）；返回 true 表示已处理、
 * 不再走浏览器默认跳转。
 */
export function MarkdownView({ text, onLinkClick }: { text: string; onLinkClick?: (href: string) => boolean }) {
  return (
    <div
      className="md-view"
      style={{ lineHeight: 1.7, wordBreak: 'break-word' }}
      dangerouslySetInnerHTML={renderMarkdown(text)}
      onClick={(e) => {
        if (!onLinkClick) return;
        const a = (e.target as HTMLElement).closest('a');
        const href = a?.getAttribute('href');
        if (href && onLinkClick(href)) e.preventDefault();
      }}
    />
  );
}

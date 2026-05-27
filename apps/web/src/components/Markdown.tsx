import { Component, useCallback, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";

/**
 * Assistant-message markdown renderer — ChatGPT/Claude-style.
 *
 * Stack: react-markdown + remark-gfm (tables, task lists, strikethrough,
 * autolinks) + remark-math/rehype-katex (LaTeX) + rehype-highlight (syntax
 * highlighting via highlight.js token classes; the theme colors live in
 * styles.css so they follow the app's light/dark theme).
 *
 * Security: raw HTML is OFF (no rehype-raw / dangerouslySetInnerHTML). Model
 * answers carry untrusted scraped/tool text, so markdown alone does all the
 * formatting. Links always open in a new tab with noopener/noreferrer.
 *
 * Streaming: content grows token-by-token while `streaming` is true, so the
 * markdown is frequently unbalanced mid-stream (open ``` fences, half tables).
 * react-markdown parses these without throwing, but an error boundary guards
 * against any transient parse so a partial message can never blank the chat.
 */

interface Props {
  content: string;
}

/** Pull plain text out of react-markdown children for the copy button. */
function childrenToText(children: ReactNode): string {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(childrenToText).join("");
  // React element with its own children (e.g. highlighted <span> tokens).
  if (typeof children === "object" && "props" in children) {
    const props = (children as { props?: { children?: ReactNode } }).props;
    return childrenToText(props?.children);
  }
  return "";
}

/** A fenced code block: language label + copy button + highlighted body. */
function CodeBlock({ language, children }: { language: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    const text = childrenToText(children);
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => {});
    } else {
      done();
    }
  }, [children]);

  return (
    <div className="md-code">
      <div className="md-code__bar">
        <span className="md-code__lang">{language || "text"}</span>
        <button type="button" className="md-code__copy" onClick={onCopy} aria-label="Copy code">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="md-code__pre">
        <code className={language ? `hljs language-${language}` : "hljs"}>{children}</code>
      </pre>
    </div>
  );
}

const FENCE_LANG = /(?:^|\s)language-([\w+-]+)/;

const components: Components = {
  // Render fenced blocks via <code> so we can read the language class and the
  // already-highlighted token children. react-markdown wraps fenced code in a
  // <pre><code>; we replace the <pre> with a no-op pass-through and let the
  // <code> handler decide block vs. inline.
  pre({ children }) {
    return <>{children}</>;
  },
  code({ className, children, node }) {
    // A fenced block: rehype tags it with a `language-*` class, OR the source
    // node spans multiple lines (a fence with no language). Inline code has
    // neither. `node.position` lets us detect multi-line even without a lang.
    const langMatch = FENCE_LANG.exec(className ?? "");
    const pos = node?.position;
    const multiline = pos ? pos.end.line > pos.start.line : false;
    const isBlock = langMatch != null || multiline || (className?.includes("hljs") ?? false);

    if (!isBlock) {
      return <code className="md-inline-code">{children}</code>;
    }
    return <CodeBlock language={langMatch?.[1] ?? ""}>{children}</CodeBlock>;
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
};

const remarkPlugins = [remarkGfm, remarkMath];
// throwOnError keeps a malformed LaTeX fragment (common mid-stream) from
// crashing — KaTeX renders the raw source instead.
const rehypePlugins = [
  [rehypeKatex, { throwOnError: false }],
  [rehypeHighlight, { detect: true, ignoreMissing: true }],
] as const;

function MarkdownInner({ content }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      // rehype plugin tuples are typed loosely upstream; the runtime shape is correct.
      rehypePlugins={rehypePlugins as never}
      components={components}
      // Defense in depth: never emit javascript:/data: URLs even though raw
      // HTML is already off (this is react-markdown's default transform).
      skipHtml
    >
      {content}
    </ReactMarkdown>
  );
}

interface BoundaryState {
  failed: boolean;
}

/**
 * Guards a transient parse error during streaming. If react-markdown ever
 * throws on a half-written token, we fall back to the raw text (preserving
 * whitespace) instead of blanking the message. resetKey clears the error as
 * soon as new content arrives, so the next stable chunk re-renders rich.
 */
class MarkdownBoundary extends Component<{ content: string; children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override componentDidUpdate(prev: { content: string }) {
    if (this.state.failed && prev.content !== this.props.content) {
      this.setState({ failed: false });
    }
  }

  override render() {
    if (this.state.failed) {
      return <div className="md-fallback">{this.props.content}</div>;
    }
    return this.props.children;
  }
}

export function Markdown({ content }: Props) {
  return (
    <div className="md">
      <MarkdownBoundary content={content}>
        <MarkdownInner content={content} />
      </MarkdownBoundary>
    </div>
  );
}

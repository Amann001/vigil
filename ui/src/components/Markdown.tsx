import { Fragment } from "react";

/**
 * Just enough Markdown for the agents' writing: headings, lists, bold, inline code and
 * paragraphs. Rendered as React elements, never as raw HTML, so nothing in a report can inject
 * markup into the page.
 */
function inline(text: string, key: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={`${key}-${i}`}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={`${key}-${i}`}>{part.slice(1, -1)}</code>;
    if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) return <em key={`${key}-${i}`}>{part.slice(1, -1)}</em>;
    return <Fragment key={`${key}-${i}`}>{part}</Fragment>;
  });
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) {
      blocks.push(<p key={`p${blocks.length}`}>{inline(paragraph.join(" "), `p${blocks.length}`)}</p>);
      paragraph = [];
    }
    if (list.length) {
      const items = list;
      blocks.push(
        <ul key={`u${blocks.length}`}>
          {items.map((item, i) => (
            <li key={i}>{inline(item, `l${blocks.length}-${i}`)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const heading = line.match(/^#{1,4}\s+(.*)/);
    const bullet = line.match(/^(?:[-*•]|\d+\.)\s+(.*)/);
    if (!line || /^[-*_]{3,}$/.test(line) || line.startsWith("|")) {
      flush();
    } else if (heading) {
      flush();
      blocks.push(<h4 key={`h${blocks.length}`}>{inline(heading[1], `h${blocks.length}`)}</h4>);
    } else if (bullet) {
      if (paragraph.length) flush();
      list.push(bullet[1]);
    } else {
      if (list.length) flush();
      paragraph.push(line);
    }
  }
  flush();
  return <div className={`markdown ${className ?? ""}`}>{blocks}</div>;
}

import { jsx as _jsx } from "react/jsx-runtime";
import { Fragment } from "react";
/**
 * Just enough Markdown for the agents' writing: headings, lists, bold, inline code and
 * paragraphs. Rendered as React elements, never as raw HTML, so nothing in a report can inject
 * markup into the page.
 */
function inline(text, key) {
    const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g);
    return parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**"))
            return _jsx("strong", { children: part.slice(2, -2) }, `${key}-${i}`);
        if (part.startsWith("`") && part.endsWith("`"))
            return _jsx("code", { children: part.slice(1, -1) }, `${key}-${i}`);
        if (part.length > 2 && part.startsWith("*") && part.endsWith("*"))
            return _jsx("em", { children: part.slice(1, -1) }, `${key}-${i}`);
        return _jsx(Fragment, { children: part }, `${key}-${i}`);
    });
}
export function Markdown({ text, className }) {
    const blocks = [];
    let list = [];
    let paragraph = [];
    const flush = () => {
        if (paragraph.length) {
            blocks.push(_jsx("p", { children: inline(paragraph.join(" "), `p${blocks.length}`) }, `p${blocks.length}`));
            paragraph = [];
        }
        if (list.length) {
            const items = list;
            blocks.push(_jsx("ul", { children: items.map((item, i) => (_jsx("li", { children: inline(item, `l${blocks.length}-${i}`) }, i))) }, `u${blocks.length}`));
            list = [];
        }
    };
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        const heading = line.match(/^#{1,4}\s+(.*)/);
        const bullet = line.match(/^(?:[-*•]|\d+\.)\s+(.*)/);
        if (!line || /^[-*_]{3,}$/.test(line) || line.startsWith("|")) {
            flush();
        }
        else if (heading) {
            flush();
            blocks.push(_jsx("h4", { children: inline(heading[1], `h${blocks.length}`) }, `h${blocks.length}`));
        }
        else if (bullet) {
            if (paragraph.length)
                flush();
            list.push(bullet[1]);
        }
        else {
            if (list.length)
                flush();
            paragraph.push(line);
        }
    }
    flush();
    return _jsx("div", { className: `markdown ${className ?? ""}`, children: blocks });
}

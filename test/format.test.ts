import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/http/format.js";

describe("renderMarkdown", () => {
  it("gives fenced and indented code blocks a copy button, inline code none", () => {
    const html = renderMarkdown("a `x` b\n\n```ts\nconst a = 1;\n```\n\n    indented\n");
    expect(html.match(/data-copy-code/g)).toHaveLength(2);
    expect(html).toContain(
      '<div class="codeblock"><button type="button" class="copy small" data-copy-code title="Copy to clipboard">Copy</button><pre><code class="language-ts">const a = 1;\n</code></pre>\n</div>',
    );
    expect(html).toContain("<code>x</code>");
  });

  it("keeps raw HTML escaped and checklists as checkboxes", () => {
    expect(renderMarkdown("<b>x</b>")).toContain("&lt;b&gt;");
    expect(renderMarkdown("- [x] done")).toContain('<input type="checkbox" disabled checked>');
  });
});

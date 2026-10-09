import { describe, expect, test } from "bun:test";
import { highlightCode } from "../server/code-highlight";
import { renderMarkdown } from "../server/markdown";

describe("code highlighting", () => {
	test("colors the code of a named language", () => {
		expect(highlightCode("const total = 1;", "ts")).toBe('<span class="hljs-keyword">const</span> total = <span class="hljs-number">1</span>;');
		expect(highlightCode(".card { color: red; }", "css")).toContain('<span class="hljs-selector-class">.card</span>');
	});

	test("escapes code in an unknown or missing language and leaves it uncolored", () => {
		expect(highlightCode('<b onclick="x()">', "nonsense")).toBe("&lt;b onclick=&quot;x()&quot;&gt;");
		expect(highlightCode("<script>", "")).toBe("&lt;script&gt;");
	});

	test("never lets markup out of highlighted code", () => {
		const colored = highlightCode('const html = "<img src=x onerror=alert(1)>";', "js");
		expect(colored).not.toContain("<img");
		expect(colored).toContain("&lt;img");
	});

	test("colors fenced blocks in markdown and keeps the language class", () => {
		const html = renderMarkdown("```ts\nconst a = 1 < 2;\n```\n\n```\nplain <x>\n```");
		expect(html).toContain('<pre><code class="language-ts"><span class="hljs-keyword">const</span>');
		expect(html).toContain("<pre><code>plain &lt;x&gt;</code></pre>");
	});
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import MarkdownIt from "markdown-it";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(`${root}scripts/.share-preview-`);
try {
  const fixturesPath = `${temp}/fixtures.json`;
  const destinationsPath = `${temp}/destinations.json`;
  const referencesPath = `${temp}/references.json`;
  execFileSync("go", ["test", "./internal/server", "-run", "^TestShare(PreviewRendering|InlineDestinationCompatibility|ReferenceDefinitionCompatibility)$", "-count=1"], {
    cwd: `${root}backend`,
    encoding: "utf8",
    env: { ...process.env, KOINOTE_SHARE_PREVIEW_FIXTURES: fixturesPath, KOINOTE_SHARE_DESTINATION_FIXTURES: destinationsPath, KOINOTE_SHARE_REFERENCE_FIXTURES: referencesPath },
    timeout: 300_000,
  });
  const { window: baseWindow } = parseHTML("<html><head></head><body></body></html>");
  class FragmentDOMParser extends baseWindow.DOMParser {
    parseFromString(value, type) {
      return super.parseFromString(`<html>${value}</html>`, type);
    }
  }
  const testWindow = Object.create(baseWindow);
  Object.defineProperty(testWindow, "DOMParser", { value: FragmentDOMParser });
  globalThis.window = testWindow;
  globalThis.document = baseWindow.document;
  globalThis.Node = baseWindow.Node;
  globalThis.requestAnimationFrame = (callback) => { callback(0); return 0; };

  const bundle = await build({
    entryPoints: [`${root}spa/src/components/editor/markdownImage.ts`],
    bundle: true, write: false, format: "esm", platform: "node", packages: "external", logLevel: "error",
  });
  const bundlePath = `${temp}/image.mjs`;
  writeFileSync(bundlePath, bundle.outputFiles[0].text);
  const [{ Editor }, { default: StarterKit }, { Markdown }, { BlockMarkdownImage }] = await Promise.all([
    import("@tiptap/core"), import("@tiptap/starter-kit"), import("tiptap-markdown"), import(pathToFileURL(bundlePath).href),
  ]);
  const options = { html: false, linkify: true, breaks: false };
  const md = new MarkdownIt(options);
  function renderedLinks(source) {
    // 图片 alt 的子 token 可以含有 link_open，但它们不会渲染成链接。
    const { document } = parseHTML(`<html><body>${md.render(source)}</body></html>`);
    return [...document.querySelectorAll("a[href]")].map((link) => link.getAttribute("href"));
  }
  function editorState(source) {
    const editor = new Editor({
      element: null,
      extensions: [StarterKit, BlockMarkdownImage, Markdown.configure(options)],
      content: source,
    });
    const links = new Set(), images = [];
    let text = "";
    function walk(node) {
      text += node.text ?? "";
      for (const mark of node.marks ?? []) if (mark.type === "link") links.add(mark.attrs.href);
      if (node.type === "image") images.push(node.attrs.src);
      for (const child of node.content ?? []) walk(child);
    }
    walk(editor.getJSON());
    editor.destroy();
    return { links: [...links].sort(), images, text: text.replace(/后+/g, "") };
  }

  const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8"));
  for (const row of fixtures) {
    const preview = editorState(row.Preview);
    if (row.Expected !== null) {
      assert.deepEqual(preview, editorState(row.Expected), `${row.Name}: expected editor output`);
      assert.deepEqual(renderedLinks(row.Preview), renderedLinks(row.Expected), `${row.Name}: expected Markdown links`);
    } else if (row.Hidden) {
      const expectedLinks = Array(row.OuterLinks).fill("/outer");
      assert.deepEqual(renderedLinks(row.Preview), expectedLinks, `${row.Name}: Markdown links`);
      assert.deepEqual(preview.links, [...new Set(expectedLinks)], `${row.Name}: editor links`);
      assert.ok(!preview.images.some((src) => src.startsWith("/hidden")), `${row.Name}: hidden image`);
      assert.ok(row.OuterLinks <= renderedLinks(row.Source).filter((href) => href === "/outer").length,
        `${row.Name}: preview must not invent an outer link`);
    } else {
      assert.deepEqual(preview, editorState(row.Source), `${row.Name}: visible definitions must render unchanged`);
    }
  }
  const destinations = JSON.parse(readFileSync(destinationsPath, "utf8"));
  for (const row of destinations) {
    const { document } = parseHTML(`<html><body>${md.render(row.Source)}</body></html>`);
    const accepted = [...document.querySelectorAll("a")].some((link) => link.textContent === "x");
    assert.equal(accepted, row.Accepted, `destination parser differs from Markdown-it: ${row.Source}`);
  }
  const references = JSON.parse(readFileSync(referencesPath, "utf8"));
  for (const row of references) {
    const env = {};
    md.parse(row.Source, env);
    const reference = env.references?.[md.utils.normalizeReference(row.Label)];
    assert.equal(Boolean(reference), row.Accepted, `reference acceptance differs: ${row.Source}`);
    if (reference) {
      assert.equal(reference.href, md.normalizeLink(md.utils.unescapeAll(row.Destination)), `reference destination differs: ${row.Source}`);
      assert.equal(reference.title, md.utils.unescapeAll(row.Title), `reference title differs: ${row.Source}`);
    }
  }
  console.log(`share preview rendering checks passed (${fixtures.length} backend/Markdown-it/TipTap cases, ${destinations.length} destination comparisons, ${references.length} reference comparisons)`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

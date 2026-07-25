#!/usr/bin/env node
// Build public/guides.json from the markdown in tools/guides/.
//
//   node tools/build_guides.mjs
//
// Same split as the rest of tools/: the markdown is human judgement — what to do
// in the first hour, how far a latrine goes from a well, which drugs are
// dangerous to stop — and this script only reformats it. Edit the markdown,
// never the JSON. public/guides.json is generated and is overwritten on every
// run.
//
// OUTPUT SHAPE — deliberately the same idea as public/handbook.json, so the
// Handbook panel can render a guide through the code path it already has for a
// field-manual chapter (see chapterBodyHtml in src/handbook.ts):
//
//   { source, guides: [{ slug, title, kind, summary, text }] }
//
// `text` is PLAIN TEXT, never HTML. Every line is either a paragraph or a
// bullet beginning with "• ", and there are no blank lines. The renderer escapes
// it, so anything that looks like markup here would show up literally.
//
// ORDERING is the filename prefix, and the array is written in that order — the
// consumer should not sort it. 01–07 are the playbooks (what to do, in
// sequence), 08–21 the domains (one subject each). The script fails if a domain
// ever sorts ahead of a playbook, because "the first hour" appearing under
// "dental" would be a real defect and a silent one. The prefix is stripped from
// the slug: 09-sanitation.md is slug "sanitation". Slugs are the stable
// identifier — renumber files freely, rename them never.
//
// MARKDOWN SUPPORTED, and nothing else:
//
//   # heading        → its own line, prefixed "§ " (see the renderer)
//   - item / * item  → "• item" (nested items are flattened; one bullet style)
//   **bold** *em*    → markers dropped, text kept
//   `code`           → backticks dropped
//   [text](url)      → "text" (a URL is useless in an offline app)
//   > quote          → plain line
//   wrapped lines    → a blank-line-separated block joins into ONE line
//
// Ordered lists, tables and fenced code have no representation in the output
// format; they pass through as paragraph text and the script warns, because
// silently flattening "1. 2. 3." into unordered bullets would lose the ordering
// that was the point of writing them.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

const SRC_DIR = new URL("./guides/", import.meta.url).pathname;
const OUT = new URL("../public/guides.json", import.meta.url).pathname;
const SOURCE = "GridDown guides";
const KINDS = new Set(["playbook", "domain"]);
/** Advisory only, and generous at the top end: the authoring target is 250–600
 *  words, but sanitation is deliberately the longest guide in the corpus —
 *  diarrhoeal disease is what actually kills people after a disaster and it
 *  earns the space. Warn at the point where a guide has stopped being a field
 *  reference, not at the point where it exceeds the average. */
const WORDS_MIN = 250;
const WORDS_MAX = 800;

const warnings = [];
const warn = (file, msg) => warnings.push(`${file}: ${msg}`);
const fail = (file, msg) => {
  console.error(`error  ${file}: ${msg}`);
  process.exitCode = 1;
};

/** Split "---\nkey: value\n---\nbody" into its two halves. Flat key/value only:
 *  no lists, no nesting, no YAML parser. Quotes around a value are optional and
 *  stripped, which is how a summary containing a colon gets written. */
function frontmatter(raw, file) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) {
    fail(file, "no --- frontmatter block at the top of the file");
    return [{}, raw];
  }
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!kv) {
      fail(file, `frontmatter line is not "key: value": ${line}`);
      continue;
    }
    meta[kv[1]] = kv[2].trim().replace(/^["'](.*)["']$/, "$1");
  }
  return [meta, raw.slice(m[0].length)];
}

/** Drop the inline markers, keep the words. Order matters: strongest first. */
function inline(s) {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images: keep the alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links: keep the label
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<![A-Za-z0-9_])__([^_]+)__(?![A-Za-z0-9_])/g, "$1")
    .replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, "$1")
    .replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\\([*_`[\]#])/g, "$1") // escaped markers: keep the character
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Markdown body → the plain-text line format described in the header.
 *
 * Paragraphs are joined onto one line because the renderer treats every line as
 * its own <p>; a paragraph wrapped at 80 columns in the source would otherwise
 * render as eight one-line paragraphs.
 */
function toPlainText(body, file) {
  const out = [];
  let para = []; // lines of the paragraph currently being accumulated
  const flush = () => {
    if (para.length) out.push(inline(para.join(" ")));
    para = [];
  };

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    const t = line.trim();

    if (!t) {
      flush();
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flush(); // horizontal rule: a separator, not content
      continue;
    }
    if (/^```/.test(t) || /^\|/.test(t)) {
      warn(file, `fenced code or a table has no plain-text form: ${t.slice(0, 40)}`);
    }
    if (/^#{1,6}\s+/.test(t)) {
      flush();
      // "§ " marks a heading, the way "• " marks a bullet. Without a marker a
      // heading arrives as an ordinary paragraph and a 700-word guide becomes
      // an undifferentiated wall — the renderer has no other way to tell them
      // apart, and guessing from length and punctuation would be a heuristic
      // that fails on the first short sentence.
      out.push(`§ ${inline(t.replace(/^#{1,6}\s+/, "").replace(/\s+#+$/, ""))}`);
      continue;
    }
    if (/^[-*+]\s+/.test(t)) {
      flush();
      out.push(`• ${inline(t.replace(/^[-*+]\s+/, ""))}`);
      continue;
    }
    if (/^\d+[.)]\s+/.test(t)) {
      // Kept as a paragraph on purpose: turning it into a bullet would drop the
      // number, and the number is why it was an ordered list.
      warn(file, `ordered list item renders as a paragraph: ${t.slice(0, 40)}`);
      flush();
      out.push(inline(t));
      continue;
    }
    if (/^>\s?/.test(t)) {
      flush();
      out.push(inline(t.replace(/^>\s?/, "")));
      continue;
    }
    if (t.startsWith("• ")) {
      // Already in output form. Harmless, but it means the source is drifting
      // towards being written in the output format rather than markdown.
      warn(file, "source line already begins with a bullet character");
    }
    para.push(t);
  }
  flush();
  return out.filter(Boolean).join("\n");
}

const files = readdirSync(SRC_DIR)
  .filter((f) => f.endsWith(".md"))
  .sort(); // zero-padded numeric prefixes, so lexical order is the intended order

if (files.length === 0) {
  console.error(`error  no .md files in ${SRC_DIR}`);
  process.exit(1);
}

const guides = [];
const seen = new Map();

for (const file of files) {
  if (!/^\d{2}-[a-z0-9]+(-[a-z0-9]+)*\.md$/.test(file)) {
    fail(file, "filename must be NN-kebab-case.md");
    continue;
  }
  const raw = readFileSync(join(SRC_DIR, file), "utf8");
  const [meta, body] = frontmatter(raw, file);
  const slug = basename(file, ".md").replace(/^\d{2}-/, "");

  for (const key of ["title", "kind", "summary"]) {
    if (!meta[key]) fail(file, `frontmatter is missing "${key}"`);
  }
  if (meta.kind && !KINDS.has(meta.kind)) {
    fail(file, `kind must be one of ${[...KINDS].join(", ")}, got "${meta.kind}"`);
  }
  if (seen.has(slug)) fail(file, `duplicate slug "${slug}" (also ${seen.get(slug)})`);
  seen.set(slug, file);

  const text = toPlainText(body, file);
  const words = text.split(/\s+/).filter((w) => w && w !== "•").length;
  if (!text) fail(file, "body is empty");
  if (words < WORDS_MIN) warn(file, `${words} words — under ${WORDS_MIN}, likely a stub`);
  if (words > WORDS_MAX) warn(file, `${words} words — over ${WORDS_MAX}, consider splitting`);
  if (meta.summary && meta.summary.length > 160) {
    warn(file, `summary is ${meta.summary.length} chars; it is a one-liner in a list`);
  }
  for (const line of text.split("\n")) {
    if (/<[a-z/!]/i.test(line)) warn(file, `looks like HTML, which will render literally: ${line.slice(0, 40)}`);
  }

  guides.push({ slug, title: meta.title, kind: meta.kind, summary: meta.summary, text, words });
}

// Playbooks are the sequence a reader follows; domains are reference. The file
// numbering is what puts them in that order, so check the numbering held.
const firstDomain = guides.findIndex((g) => g.kind === "domain");
const lastPlaybook = guides.map((g) => g.kind).lastIndexOf("playbook");
if (firstDomain !== -1 && lastPlaybook > firstDomain) {
  fail(
    seen.get(guides[lastPlaybook].slug),
    `playbook "${guides[lastPlaybook].slug}" sorts after domain "${guides[firstDomain].slug}" — renumber`
  );
}

if (process.exitCode) {
  console.error("\nnothing written.");
  process.exit(1);
}

const out = {
  source: SOURCE,
  guides: guides.map(({ words, ...g }) => g), // `words` is a build-time check only
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");

const pad = (s, n) => String(s).padEnd(n);
for (const g of guides) {
  console.log(`  ${pad(g.kind, 9)} ${pad(g.slug, 24)} ${String(g.words).padStart(4)} words`);
}
for (const w of warnings) console.log(`  warn  ${w}`);
const counts = guides.reduce((a, g) => ({ ...a, [g.kind]: (a[g.kind] || 0) + 1 }), {});
console.log(
  `\n${guides.length} guides (${counts.playbook || 0} playbooks, ${counts.domain || 0} domains), ` +
    `${guides.reduce((n, g) => n + g.words, 0)} words → public/guides.json ` +
    `(${(Buffer.byteLength(JSON.stringify(out)) / 1024).toFixed(0)} KB)`
);

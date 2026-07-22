#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_TOKENS = 600000;
const EXPOSITION_DIR = "Exposition";
const EXPOSITION_READING_ORDER = [
  "Exposition/Preamble.md",
  "Exposition/Contents.md",
  "Exposition/Theory.md",
  "Exposition/Theorems.md",
  "Exposition/Identification.md",
  "Exposition/Assumptions.md",
  "Exposition/Glossary.md",
  "Exposition/Reading.md"
];
const SNAPSHOT_MODULES = [
  { id: "code", label: "Code" },
  { id: "exposition", label: "Exposition" },
  { id: "glossary", label: "Glossary" },
  { id: "reading", label: "Reading" }
];
const DEFAULT_SNAPSHOT_SELECTION = ["code", "exposition"];
const CODE_DIRECTORY_ORDER = ["Signature", "Consequences", "Doctrines", "Identification", "Meta", "Gen"];
const SNAPSHOT_GLOSSARY_ORDER = ["Exposition/Glossary.md"];
const SNAPSHOT_READING_ORDER = ["Exposition/Reading.md"];

function usage() {
  console.error(
    "Usage: node scripts/build-context.mjs --source <path> --out src/context.generated.ts [--max-tokens 600000] [--repo-url https://github.com/OWNER/weld-and-arrow]"
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = { maxTokens: DEFAULT_MAX_TOKENS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source") args.source = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--max-tokens") args.maxTokens = Number(argv[++i]);
    else if (arg === "--repo-url") args.repoUrl = argv[++i];
    else usage();
  }
  if (!args.source || !args.out || !Number.isFinite(args.maxTokens)) usage();
  return args;
}

function stripGitSuffix(value) {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

function normalizeRepoUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return `https://github.com/${ssh[1]}/${stripGitSuffix(ssh[2])}`;

  try {
    const url = new URL(trimmed);
    if (url.hostname === "github.com") {
      url.username = "";
      url.password = "";
    }
    url.search = "";
    url.hash = "";
    return stripGitSuffix(url.toString().replace(/\/$/, ""));
  } catch {
    return stripGitSuffix(trimmed);
  }
}

function inferRepoUrl(sourcePath, explicitUrl) {
  if (explicitUrl) return normalizeRepoUrl(explicitUrl);

  try {
    const remoteUrl = execFileSync("git", ["-C", sourcePath, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const normalized = normalizeRepoUrl(remoteUrl);
    if (normalized) return normalized;
  } catch {
    // Fall through to the CI owner convention or project default.
  }

  const owner = process.env.GITHUB_REPOSITORY_OWNER;
  if (owner) return `https://github.com/${owner}/weld-and-arrow`;
  return "https://github.com/weld-and-arrow/weld-and-arrow";
}

function walk(dir, root, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replaceAll(path.sep, "/");
    if (entry.isDirectory()) {
      if (rel === ".lake" || rel === "lake-packages" || rel.startsWith(".lake/") || rel.startsWith("lake-packages/")) {
        continue;
      }
      walk(full, root, out);
    } else if (entry.isFile() && rel.endsWith(".lean")) {
      out.push(rel);
    }
  }
}

function walkMarkdown(dir, root, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replaceAll(path.sep, "/");
    if (entry.isDirectory()) {
      walkMarkdown(full, root, out);
    } else if (entry.isFile() && rel.endsWith(".md")) {
      out.push(rel);
    }
  }
}

function moduleFileEntry(root, rel, displayRel = rel) {
  return { root, rel, displayRel };
}

function collectExpositionFiles(root) {
  const files = [];
  const expositionRoot = path.join(root, EXPOSITION_DIR);
  if (existsSync(expositionRoot) && statSync(expositionRoot).isDirectory()) {
    walkMarkdown(expositionRoot, root, files);
  }
  if (files.length > 0) return files.sort(compareExpositionFiles);
  return [];
}

function expositionOrder(rel) {
  const normalizedRel = rel.toLowerCase();
  const index = EXPOSITION_READING_ORDER.findIndex((entry) => entry.toLowerCase() === normalizedRel);
  return index === -1 ? EXPOSITION_READING_ORDER.length : index;
}

function compareExpositionFiles(a, b) {
  const order = expositionOrder(a) - expositionOrder(b);
  if (order !== 0) return order;
  return a.localeCompare(b);
}

function isExcludedCodePath(rel) {
  return rel.startsWith("WeldAndArrow/Exposition/");
}

function codeDirectoryRank(rel) {
  const parts = rel.split("/");
  const topLevel = parts[1] ?? "";
  const index = CODE_DIRECTORY_ORDER.indexOf(topLevel);
  return index === -1 ? CODE_DIRECTORY_ORDER.length : index;
}

function compareCodeFiles(a, b) {
  const rank = codeDirectoryRank(a) - codeDirectoryRank(b);
  if (rank !== 0) return rank;
  return a.localeCompare(b);
}

function collectCodeFiles(source) {
  const root = path.join(source, "WeldAndArrow");
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];

  const files = [];
  walk(root, source, files);
  return files
    .filter((rel) => !isExcludedCodePath(rel))
    .sort(compareCodeFiles)
    .map((rel) => moduleFileEntry(source, rel));
}

function collectMarkdownModuleFiles(expositionRoot, expositionFiles, orderedPaths) {
  const available = new Set(expositionFiles);
  return orderedPaths
    .filter((rel) => available.has(rel))
    .map((rel) => moduleFileEntry(expositionRoot, rel));
}

function buildSnapshotModules(source, expositionRoot, expositionFiles) {
  const excludedFromExposition = new Set([...SNAPSHOT_GLOSSARY_ORDER, ...SNAPSHOT_READING_ORDER]);
  return {
    code: collectCodeFiles(source),
    exposition: expositionFiles
      .filter((rel) => !excludedFromExposition.has(rel))
      .map((rel) => moduleFileEntry(expositionRoot, rel)),
    glossary: collectMarkdownModuleFiles(expositionRoot, expositionFiles, SNAPSHOT_GLOSSARY_ORDER),
    reading: collectMarkdownModuleFiles(expositionRoot, expositionFiles, SNAPSHOT_READING_ORDER)
  };
}

function readEntryText(entry) {
  const text = readFileSync(path.join(entry.root, entry.rel), "utf8").replace(/\r\n/g, "\n");
  if (!entry.rel.endsWith(".md")) return text;
  return text
    .split("\n")
    .filter((line) => !/\bGENERATED\b/.test(line))
    .join("\n");
}

function renderContext(files) {
  return files
    .map((entry) => `===== FILE: ${entry.displayRel ?? entry.rel} =====\n${readEntryText(entry)}`)
    .join("\n\n");
}

function selectedSnapshotFiles(modules, selectedIds) {
  return selectedIds.flatMap((id) => modules[id] ?? []);
}

function snapshotSlug(selectedIds) {
  return selectedIds.length > 0 ? selectedIds.join("-") : "empty";
}

function snapshotFileName(selectedIds) {
  const slug = snapshotSlug(selectedIds);
  return slug === "code-exposition" ? "weld-and-arrow.txt" : `weld-and-arrow-${slug}.txt`;
}

function moduleSelectionMask(index) {
  return SNAPSHOT_MODULES.filter((_module, bit) => (index & (1 << bit)) !== 0).map(({ id }) => id);
}

function allSnapshotSelections() {
  const selections = [];
  const count = 1 << SNAPSHOT_MODULES.length;
  for (let index = 0; index < count; index += 1) selections.push(moduleSelectionMask(index));
  return selections;
}

function snapshotHeader({ commit, builtAt, repoUrl, files, selectedIds }) {
  const selectedLabels = SNAPSHOT_MODULES.filter(({ id }) => selectedIds.includes(id)).map(({ label }) => label);
  return [
    "Weld & Arrow context snapshot",
    `Source commit: ${commit}`,
    `Built at: ${builtAt}`,
    `Frozen snapshot of ${repoUrl}.`,
    `Selected modules: ${selectedLabels.length > 0 ? selectedLabels.join(", ") : "none"}`,
    "",
    "Files:",
    ...(files.length > 0 ? files.map((entry) => `- ${entry.displayRel ?? entry.rel}`) : ["- none"]),
    "",
    "===== CONTEXT =====",
    ""
  ].join("\n");
}

function buildSnapshotText({ commit, builtAt, repoUrl, files, selectedIds }) {
  const context = renderContext(files);
  const body = context ? `${context}\n` : "";
  return `${snapshotHeader({ commit, builtAt, repoUrl, files, selectedIds })}${body}`;
}

function snapshotStats(text) {
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    approxTokens: Math.ceil(text.length / 3.5)
  };
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function sanitizeLinkTarget(value) {
  const target = value.trim();
  const lower = target.toLowerCase();
  if (lower.startsWith("javascript:") || lower.startsWith("data:")) return "#";
  return target;
}

function resolveMarkdownLink(value, currentRel) {
  const target = sanitizeLinkTarget(value);
  const match = target.match(/^([^?#]+\.md)(#[^?]+)?$/i);
  if (!match || !currentRel) return target;

  if (match[2]) return match[2];
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(currentRel), match[1]));
  return `#markdown-${slugify(resolved)}`;
}

function slugify(value) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "markdown"
  );
}

function renderInline(value, currentRel) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_match, alt, src) => {
      const safeSrc = escapeAttribute(sanitizeLinkTarget(src));
      return `<img src="${safeSrc}" alt="${alt}">`;
    })
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_match, text, href) => {
      const safeHref = escapeAttribute(resolveMarkdownLink(href, currentRel));
      return `<a href="${safeHref}" rel="noreferrer">${text}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function isBlank(line) {
  return line.trim() === "";
}

function isHorizontalRule(line) {
  return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

function isListItem(line) {
  return /^\s*(?:[-*+]\s+|\d+\.\s+)/.test(line);
}

function isTableDivider(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function isTableStart(lines, index) {
  return index + 1 < lines.length && lines[index].includes("|") && isTableDivider(lines[index + 1]);
}

function isBlockStart(lines, index) {
  const line = lines[index];
  return (
    /^(```+|~~~+)/.test(line) ||
    /^\s{0,3}#{1,6}\s+/.test(line) ||
    /^\s{0,3}>/.test(line) ||
    isHorizontalRule(line) ||
    isListItem(line) ||
    isTableStart(lines, index)
  );
}

function tableCells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderTable(lines, start, currentRel) {
  const header = tableCells(lines[start]);
  let index = start + 2;
  const rows = [];
  while (index < lines.length && lines[index].includes("|") && !isBlank(lines[index])) {
    rows.push(tableCells(lines[index]));
    index += 1;
  }

  const head = `<thead><tr>${header.map((cell) => `<th>${renderInline(cell, currentRel)}</th>`).join("")}</tr></thead>`;
  const bodyRows = rows.map((row) => {
    const cells = header
      .map((_cell, cellIndex) => `<td>${renderInline(row[cellIndex] ?? "", currentRel)}</td>`)
      .join("");
    return `<tr>${cells}</tr>`;
  });
  const body = bodyRows.length > 0 ? `<tbody>${bodyRows.join("")}</tbody>` : "";
  return { html: `<table>${head}${body}</table>`, next: index };
}

function renderMarkdown(markdown, currentRel) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (isBlank(line)) {
      index += 1;
      continue;
    }

    const fence = line.match(/^(```+|~~~+)\s*(.*)$/);
    if (fence) {
      const marker = fence[1][0].repeat(3);
      const language = fence[2].trim().split(/\s+/)[0] ?? "";
      index += 1;
      const code = [];
      while (index < lines.length && !lines[index].startsWith(marker)) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const className = language ? ` class="language-${escapeAttribute(language)}"` : "";
      out.push(`<pre><code${className}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2], currentRel)}</h${level}>`);
      index += 1;
      continue;
    }

    if (isHorizontalRule(line)) {
      out.push("<hr>");
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const table = renderTable(lines, index, currentRel);
      out.push(table.html);
      index = table.next;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const quoted = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s{0,3}>\s?/, ""));
        index += 1;
      }
      out.push(`<blockquote>${renderMarkdown(quoted.join("\n"), currentRel)}</blockquote>`);
      continue;
    }

    if (isListItem(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const itemPattern = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/;
      const items = [];
      while (index < lines.length && itemPattern.test(lines[index])) {
        items.push(lines[index].replace(itemPattern, ""));
        index += 1;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((item) => `<li>${renderInline(item, currentRel)}</li>`).join("")}</${tag}>`);
      continue;
    }

    const paragraph = [];
    while (index < lines.length && !isBlank(lines[index]) && !isBlockStart(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    if (paragraph.length > 0) {
      out.push(`<p>${renderInline(paragraph.join(" "), currentRel)}</p>`);
    }
  }

  return out.join("\n");
}

function renderMarkdownFiles(root, files) {
  return files
    .map((rel) => {
      const text = readGeneratedMarkdown(root, rel);
      const id = `markdown-${slugify(rel)}`;
      return [
        `<section class="markdown-file" id="${id}">`,
        `<p class="markdown-file-path">${escapeHtml(rel)}</p>`,
        renderMarkdown(text, rel),
        "</section>"
      ].join("\n");
    })
    .join("\n");
}

function readGeneratedMarkdown(root, rel) {
  return readFileSync(path.join(root, rel), "utf8")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/\bGENERATED\b/.test(line))
    .join("\n");
}

const { source, out, maxTokens, repoUrl: repoUrlArg } = parseArgs(process.argv.slice(2));
const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.dirname(path.dirname(scriptPath));
const sourcePath = path.resolve(source);
if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) {
  throw new Error(`Source checkout does not exist or is not a directory: ${sourcePath}`);
}

const expositionRoot = sourcePath;
const expositionFiles = collectExpositionFiles(expositionRoot);
if (expositionFiles.length === 0) {
  throw new Error(`Exposition Markdown was not found under ${path.join(expositionRoot, EXPOSITION_DIR)}/`);
}

const snapshotModules = buildSnapshotModules(sourcePath, expositionRoot, expositionFiles);
const defaultFiles = selectedSnapshotFiles(snapshotModules, DEFAULT_SNAPSHOT_SELECTION);
if (defaultFiles.length === 0) {
  throw new Error(`No context files found in ${sourcePath}`);
}

const context = renderContext(defaultFiles);

const approxTokens = Math.ceil(context.length / 3.5);
if (approxTokens > maxTokens) {
  throw new Error(`Context estimate ${approxTokens} exceeds guard ${maxTokens}`);
}

const commit = execFileSync("git", ["-C", sourcePath, "rev-parse", "--short", "HEAD"], {
  encoding: "utf8"
}).trim();
const repoUrl = inferRepoUrl(sourcePath, repoUrlArg);
const builtAt = new Date().toISOString();

const outPath = path.resolve(out);
const moduleText = [
  "// Generated by scripts/build-context.mjs. Do not edit by hand.",
  `export const CONTEXT: string = ${JSON.stringify(context)};`,
  `export const SOURCE_COMMIT = ${JSON.stringify(commit)};`,
  `export const CONTEXT_APPROX_TOKENS = ${approxTokens};`,
  ""
].join("\n");

writeFileSync(outPath, moduleText, "utf8");

const contextDir = path.join(projectRoot, "public", "context");
mkdirSync(contextDir, { recursive: true });

const snapshotPath = path.join(contextDir, "weld-and-arrow.txt");
const expositionPath = path.join(contextDir, "exposition.md");
const expositionHtmlPath = path.join(contextDir, "exposition.html");
const manifestPath = path.join(contextDir, "manifest.json");
const snapshots = {};
let defaultSnapshot = null;
for (const selectedIds of allSnapshotSelections()) {
  const selectedFiles = selectedSnapshotFiles(snapshotModules, selectedIds);
  const text = buildSnapshotText({ commit, builtAt, repoUrl, files: selectedFiles, selectedIds });
  const fileName = snapshotFileName(selectedIds);
  const stats = snapshotStats(text);
  writeFileSync(path.join(contextDir, fileName), text, "utf8");
  snapshots[snapshotSlug(selectedIds)] = {
    file: `/context/${fileName}`,
    modules: selectedIds,
    files: selectedFiles.map((entry) => entry.displayRel ?? entry.rel),
    ...stats
  };
  if (selectedIds.join(",") === DEFAULT_SNAPSHOT_SELECTION.join(",")) defaultSnapshot = snapshots[snapshotSlug(selectedIds)];
}
const snapshotBytes = defaultSnapshot?.bytes ?? 0;
const expositionText = expositionFiles
  .map((rel) => {
    const text = readGeneratedMarkdown(expositionRoot, rel);
    return `===== FILE: ${rel} =====\n${text}`;
  })
  .join("\n\n");
writeFileSync(expositionPath, expositionText, "utf8");
writeFileSync(expositionHtmlPath, `${renderMarkdownFiles(expositionRoot, expositionFiles)}\n`, "utf8");
writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      commit,
      builtAt,
      bytes: snapshotBytes,
      approxTokens: defaultSnapshot?.approxTokens ?? approxTokens,
      repoUrl,
      expositionPaths: expositionFiles,
      snapshotModules: SNAPSHOT_MODULES.map(({ id, label }) => ({
        id,
        label,
        files: (snapshotModules[id] ?? []).map((entry) => entry.displayRel ?? entry.rel)
      })),
      defaultSnapshotModules: DEFAULT_SNAPSHOT_SELECTION,
      snapshots
    },
    null,
    2
  )}\n`,
  "utf8"
);

const relativeOut = path.relative(path.dirname(scriptPath), outPath).replaceAll(path.sep, "/");
const relativeSnapshot = path.relative(path.dirname(scriptPath), snapshotPath).replaceAll(path.sep, "/");
const relativeExposition = path.relative(path.dirname(scriptPath), expositionPath).replaceAll(path.sep, "/");
const relativeExpositionHtml = path.relative(path.dirname(scriptPath), expositionHtmlPath).replaceAll(path.sep, "/");
const relativeManifest = path.relative(path.dirname(scriptPath), manifestPath).replaceAll(path.sep, "/");
console.log(`WeldAndArrow context written to ${relativeOut}`);
console.log(`SOURCE_COMMIT=${commit}`);
console.log(`CONTEXT_APPROX_TOKENS=${approxTokens}`);
console.log(`CONTEXT_SNAPSHOT=${relativeSnapshot}`);
console.log(`CONTEXT_SNAPSHOT_BYTES=${snapshotBytes}`);
console.log(`EXPOSITION_MARKDOWN=${relativeExposition}`);
console.log(`EXPOSITION_HTML=${relativeExpositionHtml}`);
console.log(`CONTEXT_MANIFEST=${relativeManifest}`);

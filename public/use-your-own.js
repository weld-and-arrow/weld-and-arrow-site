const snapshotMeta = document.querySelector("#snapshotMeta");
const snapshotDownload = document.querySelector("#snapshotDownload");
const snapshotPromptHint = document.querySelector("#snapshotPromptHint");
const copySnapshotButton = document.querySelector("#copySnapshotButton");
const copySnapshotStatus = document.querySelector("#copySnapshotStatus");
const snapshotModuleInputs = Array.from(document.querySelectorAll('input[name="snapshot-module"]'));
const repoLink = document.querySelector("#repoLink");
const artifactLink = document.querySelector("#artifactLink");
const expositionContent = document.querySelector("#expositionContent");
const expositionTocList = document.querySelector("#expositionTocList");
const copyRepoButton = document.querySelector("#copyRepoButton");
const copyRepoStatus = document.querySelector("#copyRepoStatus");
const commitShort = document.querySelector("#commitShort");

let resetCopyTimer = 0;
let resetSnapshotCopyTimer = 0;
let headingObserver = null;
let snapshotManifest = null;

init();

async function init() {
  wireCopyButton();
  wireSnapshotCopyButton();
  wireSnapshotPicker();
  const results = await Promise.allSettled([loadManifest(), loadConfig(), loadExposition()]);
  for (const result of results) {
    if (result.status === "rejected") console.warn(result.reason);
  }
}

async function loadManifest() {
  const response = await fetch("/context/manifest.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Context manifest could not be loaded.");

  const manifest = await response.json();
  const commit = typeof manifest.commit === "string" ? manifest.commit : "";
  snapshotManifest = manifest;

  applyDefaultSnapshotSelection(manifest);
  updateSnapshotSelection();
  if (commitShort && commit) commitShort.textContent = shortCommit(commit);

  if (repoLink && typeof manifest.repoUrl === "string" && manifest.repoUrl.trim()) {
    repoLink.href = manifest.repoUrl;
    repoLink.textContent = manifest.repoUrl;
  }
}

function wireSnapshotPicker() {
  for (const input of snapshotModuleInputs) {
    input.addEventListener("change", (event) => {
      const target = event.currentTarget;
      if (target instanceof HTMLInputElement && target.value === "code" && target.checked) {
        setSnapshotModuleChecked("reading", false);
      }
      updateSnapshotSelection();
    });
  }
}

function wireSnapshotCopyButton() {
  if (!copySnapshotButton) return;
  copySnapshotButton.addEventListener("click", copySelectedSnapshot);
}

async function copySelectedSnapshot() {
  if (!copySnapshotButton || !snapshotDownload?.href) return;

  const originalLabel = copySnapshotButton.dataset.label || copySnapshotButton.textContent || "Copy to clipboard";
  copySnapshotButton.dataset.label = originalLabel;
  copySnapshotButton.disabled = true;
  copySnapshotButton.textContent = "Copying";
  if (copySnapshotStatus) copySnapshotStatus.textContent = "";

  try {
    const response = await fetch(snapshotDownload.href, { cache: "no-store" });
    if (!response.ok) throw new Error("Snapshot could not be loaded.");

    await navigator.clipboard.writeText(await response.text());
    showSnapshotCopyState("Copied", "Copied");
  } catch (error) {
    console.warn(error);
    showSnapshotCopyState("Copy failed", "Copy failed");
  }
}

function showSnapshotCopyState(buttonLabel, statusText) {
  window.clearTimeout(resetSnapshotCopyTimer);
  const originalLabel = copySnapshotButton.dataset.label || "Copy to clipboard";
  copySnapshotButton.disabled = false;
  copySnapshotButton.textContent = buttonLabel;
  if (copySnapshotStatus) copySnapshotStatus.textContent = statusText;

  resetSnapshotCopyTimer = window.setTimeout(() => {
    copySnapshotButton.textContent = originalLabel;
    if (copySnapshotStatus) copySnapshotStatus.textContent = "";
  }, 2000);
}

function applyDefaultSnapshotSelection(manifest) {
  if (!snapshotModuleInputs.length || !Array.isArray(manifest.defaultSnapshotModules)) return;

  const defaults = new Set(manifest.defaultSnapshotModules);
  for (const input of snapshotModuleInputs) input.checked = defaults.has(input.value);
}

function setSnapshotModuleChecked(value, checked) {
  const input = snapshotModuleInputs.find((candidate) => candidate.value === value);
  if (input) input.checked = checked;
}

function selectedSnapshotModules() {
  return snapshotModuleInputs.filter((input) => input.checked).map((input) => input.value);
}

function snapshotKey(modules) {
  return modules.length > 0 ? modules.join("-") : "empty";
}

function updateSnapshotSelection() {
  if (!snapshotManifest) return;

  const modules = selectedSnapshotModules();
  updateSnapshotPromptHint(modules);
  const snapshot = snapshotManifest.snapshots?.[snapshotKey(modules)];
  const commit = typeof snapshotManifest.commit === "string" ? snapshotManifest.commit : "";
  const builtAt = formatDate(snapshotManifest.builtAt);
  const bytes = formatBytes(snapshot?.bytes);
  const tokens = formatTokens(snapshot?.approxTokens);

  const details = [
    commit ? `commit ${commit}` : "",
    builtAt ? `built ${builtAt}` : "",
    bytes,
    tokens
  ].filter(Boolean);

  if (snapshotMeta) {
    snapshotMeta.textContent =
      details.length > 0 ? details.join(" · ") : "snapshot size pending · token estimate pending";
  }

  if (!snapshotDownload) return;
  if (snapshot && typeof snapshot.file === "string" && snapshot.file) {
    snapshotDownload.href = snapshot.file;
    snapshotDownload.removeAttribute("aria-disabled");
    snapshotDownload.classList.remove("disabled-action");
  } else {
    snapshotDownload.removeAttribute("href");
    snapshotDownload.setAttribute("aria-disabled", "true");
    snapshotDownload.classList.add("disabled-action");
  }
}

function updateSnapshotPromptHint(modules) {
  if (!snapshotPromptHint) return;

  const topics = modules
    .map((module) => {
      if (module === "exposition") return "theory";
      if (module === "code") return "code";
      if (module === "glossary") return "glossary";
      if (module === "reading") return "reading";
      return "";
    })
    .filter(Boolean);

  const topicList = formatPlainList(topics);
  snapshotPromptHint.textContent = topicList
    ? `Ask about the Weld & Arrow ${topicList}.`
    : "Ask about Weld & Arrow.";
}

function formatPlainList(items) {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

async function loadConfig() {
  const response = await fetch("/api/config", { cache: "no-store" });
  if (!response.ok) throw new Error("Site config could not be loaded.");

  const config = await response.json();
  if (artifactLink && typeof config.artifactUrl === "string" && config.artifactUrl.trim()) {
    artifactLink.href = config.artifactUrl;
    artifactLink.textContent = config.artifactUrl;
  }
}

async function loadExposition() {
  if (!expositionContent) return;

  try {
    const response = await fetch("/context/exposition.html", { cache: "no-store" });
    if (!response.ok) throw new Error("Exposition HTML could not be loaded.");

    const html = await response.text();
    if (html.trim()) {
      expositionContent.innerHTML = html;
      prepareExpositionReader();
    } else {
      setExpositionStatus("Exposition is empty in this build. The snapshot download still includes the repository context.");
    }
  } catch (error) {
    setExpositionStatus("Exposition is not available in this build. The snapshot download still includes it.");
    throw error;
  }
}

function prepareExpositionReader() {
  const headings = Array.from(expositionContent.querySelectorAll("h1, h2, h3"));
  assignHeadingIds(headings);
  addHeadingAnchors(headings);
  wrapTables();
  buildToc(headings);
  setupScrollSpy(headings);
}

function wrapTables() {
  const tables = Array.from(expositionContent.querySelectorAll("table"));

  for (const [index, table] of tables.entries()) {
    if (table.parentElement?.classList.contains("markdown-table-scroll")) continue;

    const hint = document.createElement("p");
    hint.className = "markdown-table-hint";
    hint.id = `markdown-table-hint-${index + 1}`;
    hint.textContent = "Scroll horizontally to read all columns";
    hint.hidden = true;

    const wrapper = document.createElement("div");
    wrapper.className = "markdown-table-scroll";
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", `Scrollable table ${index + 1}`);
    wrapper.setAttribute("aria-describedby", hint.id);
    table.replaceWith(hint, wrapper);
    wrapper.append(table);

    const updateOverflow = () => {
      const overflows = wrapper.scrollWidth > wrapper.clientWidth + 1;
      hint.hidden = !overflows;
      wrapper.tabIndex = overflows ? 0 : -1;
    };

    requestAnimationFrame(updateOverflow);
    if ("ResizeObserver" in window) {
      new ResizeObserver(updateOverflow).observe(wrapper);
    }
  }
}

function assignHeadingIds(headings) {
  const used = new Map();
  for (const heading of headings) {
    const base = slugify(heading.textContent || "section");
    const count = used.get(base) || 0;
    used.set(base, count + 1);
    heading.id = count === 0 ? base : `${base}-${count + 1}`;
  }
}

function addHeadingAnchors(headings) {
  for (const heading of headings) {
    const anchor = document.createElement("a");
    anchor.className = "heading-anchor";
    anchor.href = `#${heading.id}`;
    anchor.setAttribute("aria-label", `Link to ${heading.textContent || "section"}`);
    anchor.textContent = "#";
    heading.append(" ", anchor);
  }
}

function buildToc(headings) {
  if (!expositionTocList) return;
  expositionTocList.textContent = "";
  expositionTocList.append(renderTopTocNode());

  if (headings.length === 0) {
    const item = document.createElement("li");
    item.className = "toc-placeholder";
    item.textContent = "No headings in this exposition.";
    expositionTocList.append(item);
    return;
  }

  const tree = buildHeadingTree(headings);
  for (const node of tree) expositionTocList.append(renderTocNode(node));

  setActiveToc(headings[0].id);
}

function renderTopTocNode() {
  const item = document.createElement("li");
  item.className = "toc-depth-1";

  const row = document.createElement("div");
  row.className = "toc-row";

  const spacer = document.createElement("span");
  spacer.className = "toc-toggle-spacer";
  spacer.setAttribute("aria-hidden", "true");

  const link = document.createElement("a");
  link.href = "#";
  link.dataset.targetId = "";
  link.addEventListener("click", () => setActiveToc(""));

  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrow.setAttribute("class", "toc-arrow");
  arrow.setAttribute("viewBox", "0 0 10 10");
  arrow.setAttribute("aria-hidden", "true");

  const arrowPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  arrowPath.setAttribute("d", "M2 1 L8 5 L2 9 Z");
  arrowPath.setAttribute("fill", "currentColor");
  arrow.append(arrowPath);

  const label = document.createElement("span");
  label.textContent = "Top";

  link.append(arrow, label);
  row.append(spacer, link);
  item.append(row);
  return item;
}

function buildHeadingTree(headings) {
  const root = [];
  const stack = [];

  for (const heading of headings) {
    const node = { heading, children: [] };
    const level = headingLevel(heading);

    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();

    if (stack.length === 0) root.push(node);
    else stack[stack.length - 1].node.children.push(node);

    stack.push({ level, node });
  }

  return root;
}

function renderTocNode(node) {
  const item = document.createElement("li");
  const level = headingLevel(node.heading);
  const hasChildren = node.children.length > 0;
  item.className = `toc-depth-${level}`;
  if (hasChildren) item.classList.add("toc-has-children");

  const row = document.createElement("div");
  row.className = "toc-row";

  if (hasChildren) {
    const childListId = `${node.heading.id}-toc-children`;
    const toggle = document.createElement("button");
    toggle.className = "toc-toggle";
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-controls", childListId);
    toggle.setAttribute("aria-label", `Collapse ${cleanHeadingLabel(node.heading)}`);
    toggle.addEventListener("click", () => toggleTocChildren(item, toggle, node.heading));
    row.append(toggle);
  } else {
    const spacer = document.createElement("span");
    spacer.className = "toc-toggle-spacer";
    spacer.setAttribute("aria-hidden", "true");
    row.append(spacer);
  }

  row.append(createTocLink(node.heading));
  item.append(row);

  if (hasChildren) {
    const childList = document.createElement("ol");
    childList.className = "toc-list toc-child-list";
    childList.id = `${node.heading.id}-toc-children`;
    for (const child of node.children) childList.append(renderTocNode(child));
    item.append(childList);
  }

  return item;
}

function createTocLink(heading) {
  const link = document.createElement("a");
  link.href = `#${heading.id}`;
  link.dataset.targetId = heading.id;
  link.addEventListener("click", () => setActiveToc(heading.id));

  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrow.setAttribute("class", "toc-arrow");
  arrow.setAttribute("viewBox", "0 0 10 10");
  arrow.setAttribute("aria-hidden", "true");

  const arrowPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  arrowPath.setAttribute("d", "M2 1 L8 5 L2 9 Z");
  arrowPath.setAttribute("fill", "currentColor");
  arrow.append(arrowPath);

  const label = document.createElement("span");
  label.textContent = cleanHeadingLabel(heading);

  link.append(arrow, label);
  return link;
}

function toggleTocChildren(item, toggle, heading) {
  const isExpanded = toggle.getAttribute("aria-expanded") === "true";
  toggle.setAttribute("aria-expanded", String(!isExpanded));
  toggle.setAttribute("aria-label", `${isExpanded ? "Expand" : "Collapse"} ${cleanHeadingLabel(heading)}`);
  item.classList.toggle("toc-collapsed", isExpanded);
}

function setupScrollSpy(headings) {
  if (!headings.length) return;
  if (headingObserver) headingObserver.disconnect();

  if (!("IntersectionObserver" in window)) return;

  const visible = new Set();
  headingObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      }

      const active = headings.filter((heading) => visible.has(heading.id)).pop();
      if (active) setActiveToc(active.id);
    },
    {
      rootMargin: "0px 0px -40% 0px",
      threshold: 0
    }
  );

  for (const heading of headings) headingObserver.observe(heading);
}

function setActiveToc(id) {
  if (!expositionTocList) return;
  for (const link of expositionTocList.querySelectorAll("a")) {
    link.classList.toggle("active", link.dataset.targetId === id);
  }

  const activeLink = expositionTocList.querySelector(`a[data-target-id="${escapeAttributeSelector(id)}"]`);
  if (!activeLink) return;

  for (const collapsed of tocAncestors(activeLink, "li.toc-collapsed")) setTocExpanded(collapsed, true);
}

function setTocExpanded(item, expanded) {
  item.classList.toggle("toc-collapsed", !expanded);
  const toggle = item.querySelector(":scope > .toc-row > .toc-toggle");
  const link = item.querySelector(":scope > .toc-row > a");
  if (!toggle || !link) return;
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${link.textContent.trim() || "section"}`);
}

function tocAncestors(element, selector) {
  const matches = [];
  let parent = element.parentElement;

  while (parent && parent !== expositionTocList) {
    if (parent.matches(selector)) matches.push(parent);
    parent = parent.parentElement;
  }

  return matches;
}

function escapeAttributeSelector(value) {
  if (window.CSS?.escape) return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

function wireCopyButton() {
  if (!copyRepoButton || !repoLink) return;
  copyRepoButton.addEventListener("click", copyRepoUrl);
}

async function copyRepoUrl() {
  const url = repoLink.href || repoLink.textContent || "";
  if (!url) return;

  try {
    await navigator.clipboard.writeText(url);
    showCopyState("Copied", "Copied");
  } catch {
    selectRepoUrl();
    if (copySelectedText()) {
      showCopyState("Copied", "Copied");
    } else {
      showCopyState("Select URL", "Copy the selected URL.");
    }
  }
}

function selectRepoUrl() {
  const selection = window.getSelection();
  if (!selection || !repoLink) return;
  const range = document.createRange();
  range.selectNodeContents(repoLink);
  selection.removeAllRanges();
  selection.addRange(range);
}

function copySelectedText() {
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  }
}

function showCopyState(buttonLabel, statusText) {
  window.clearTimeout(resetCopyTimer);
  const originalLabel = copyRepoButton.dataset.label || copyRepoButton.textContent || "Copy repo URL";
  copyRepoButton.dataset.label = originalLabel;
  copyRepoButton.textContent = buttonLabel;
  if (copyRepoStatus) copyRepoStatus.textContent = statusText;

  resetCopyTimer = window.setTimeout(() => {
    copyRepoButton.textContent = originalLabel;
    if (copyRepoStatus) copyRepoStatus.textContent = "";
  }, 2000);
}

function setExpositionStatus(message) {
  expositionContent.textContent = "";
  const status = document.createElement("p");
  status.className = "markdown-status";
  status.textContent = message;
  expositionContent.append(status);

  if (expositionTocList) {
    expositionTocList.textContent = "";
    const item = document.createElement("li");
    item.className = "toc-placeholder";
    item.textContent = "Exposition unavailable.";
    expositionTocList.append(item);
  }
}

function cleanHeadingLabel(heading) {
  return Array.from(heading.childNodes)
    .filter((node) => !(node.nodeType === Node.ELEMENT_NODE && node.classList?.contains("heading-anchor")))
    .map((node) => node.textContent || "")
    .join("")
    .trim();
}

function headingLevel(heading) {
  return Number(heading.tagName.slice(1));
}

function slugify(value) {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

function shortCommit(value) {
  return value.length > 12 ? value.slice(0, 12) : value;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return `${Math.round(value).toLocaleString()} bytes`;
}

function formatTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return `~${Math.round(value).toLocaleString()} tokens`;
}

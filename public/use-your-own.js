const snapshotMeta = document.querySelector("#snapshotMeta");
const repoLink = document.querySelector("#repoLink");
const artifactLink = document.querySelector("#artifactLink");
const expositionContent = document.querySelector("#expositionContent");

init();

async function init() {
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
  const builtAt = formatDate(manifest.builtAt);
  const bytes = formatBytes(manifest.bytes);
  const tokens = formatTokens(manifest.approxTokens);

  const details = [
    commit ? `commit ${commit}` : "",
    builtAt ? `built ${builtAt}` : "",
    bytes,
    tokens
  ].filter(Boolean);
  if (snapshotMeta && details.length > 0) snapshotMeta.textContent = `Pinned to ${details.join(", ")}.`;

  if (repoLink && typeof manifest.repoUrl === "string" && manifest.repoUrl.trim()) {
    repoLink.href = manifest.repoUrl;
    repoLink.textContent = manifest.repoUrl;
  }
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
    expositionContent.innerHTML = html.trim()
      ? html
      : '<p class="markdown-status">Exposition is empty for this build.</p>';
  } catch (error) {
    expositionContent.innerHTML = '<p class="markdown-status">Exposition is unavailable for this build.</p>';
    throw error;
  }
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
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function formatTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value >= 1000) return `~${Math.round(value / 1000)}K tokens`;
  return `~${Math.round(value).toLocaleString()} tokens`;
}

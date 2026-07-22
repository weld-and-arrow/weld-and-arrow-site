const state = {
  config: null,
  sessionId: sessionStorage.getItem("wa.sessionId") || "",
  history: loadHistory(),
  turnstileToken: "",
  sending: false
};

const els = {
  consentPanel: document.querySelector("#consentPanel"),
  consentButton: document.querySelector("#consentButton"),
  turnstileBox: document.querySelector("#turnstileBox"),
  configWarning: document.querySelector("#configWarning"),
  messages: document.querySelector("#messages"),
  composer: document.querySelector("#composer"),
  messageInput: document.querySelector("#messageInput"),
  sendButton: document.querySelector("#sendButton"),
  sessionChip: document.querySelector("#sessionChip"),
  sessionIdText: document.querySelector("#sessionIdText"),
  selfServeConsentLink: document.querySelector("#selfServeConsentLink"),
  selfServeBannerLink: document.querySelector("#selfServeBannerLink"),
  commitText: document.querySelector("#commitText")
};

init();

async function init() {
  try {
    state.config = await fetchJson("/api/config");
    setConfigText();
    if (state.config.chatEnabled === false) {
      showConfigWarning("The hosted chat is disabled. Use the self-serve options on the home page instead.");
      return;
    }
    await setupTurnstile();
    if (state.sessionId) showChat();
  } catch (error) {
    showConfigWarning("The site is not configured yet. Please try again later.");
    console.error(error);
  }

  els.consentButton.addEventListener("click", startSession);
  els.sendButton.addEventListener("click", sendMessage);
  els.messageInput.addEventListener("input", autosizeInput);
  els.messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
}

function loadHistory() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem("wa.history") || "[]");
    return Array.isArray(parsed) ? parsed.filter(isChatMessage) : [];
  } catch {
    return [];
  }
}

function saveState() {
  sessionStorage.setItem("wa.sessionId", state.sessionId);
  sessionStorage.setItem("wa.history", JSON.stringify(state.history));
}

function isChatMessage(value) {
  return value && (value.role === "user" || value.role === "assistant") && typeof value.content === "string";
}

function setConfigText() {
  const selfServeUrl = state.config.selfServeUrl || "/";
  els.selfServeConsentLink.href = selfServeUrl;
  els.selfServeBannerLink.href = selfServeUrl;
  els.commitText.textContent = `Grounded in WeldAndArrow @ ${state.config.commit || "dev"}`;
}

function showConfigWarning(message) {
  els.configWarning.textContent = message;
  els.configWarning.classList.remove("hidden");
}

async function setupTurnstile() {
  if (!state.config.turnstileSiteKey) {
    showConfigWarning("Turnstile is not configured, so new sessions cannot start.");
    return;
  }

  await waitForTurnstile();
  window.turnstile.render(els.turnstileBox, {
    sitekey: state.config.turnstileSiteKey,
    callback(token) {
      state.turnstileToken = token;
      els.consentButton.disabled = false;
    },
    "expired-callback"() {
      state.turnstileToken = "";
      els.consentButton.disabled = true;
    },
    "error-callback"() {
      state.turnstileToken = "";
      els.consentButton.disabled = true;
      showConfigWarning("Turnstile could not verify this browser. Please refresh and try again.");
    }
  });
}

function waitForTurnstile() {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (window.turnstile) resolve();
      else if (Date.now() - started > 8000) {
        showConfigWarning("Turnstile did not load. Please refresh and try again.");
        resolve();
      }
      else setTimeout(tick, 100);
    };
    tick();
  });
}

async function startSession() {
  if (!state.turnstileToken || state.sending) return;
  state.sending = true;
  els.consentButton.disabled = true;

  try {
    const session = await fetchJson("/api/session", {
      method: "POST",
      body: JSON.stringify({
        consent: true,
        turnstileToken: state.turnstileToken
      })
    });
    state.sessionId = session.sessionId;
    state.history = [];
    saveState();
    showChat();
  } catch (error) {
    showConfigWarning("Consent could not be recorded. Please refresh and try again.");
    console.error(error);
  } finally {
    state.sending = false;
    els.consentButton.disabled = !state.turnstileToken;
  }
}

function showChat() {
  els.consentPanel.classList.add("hidden");
  els.messages.classList.remove("hidden");
  els.composer.classList.remove("hidden");
  els.sessionChip.classList.remove("hidden");
  els.sessionIdText.textContent = state.sessionId;
  renderHistory();
  els.messageInput.focus();
}

async function sendMessage() {
  const text = els.messageInput.value.trim();
  if (!text || state.sending) return;

  if (state.history.length >= (state.config.maxTurns || 40)) {
    renderNotice("This session has reached its turn limit. Start a new session to continue.");
    return;
  }

  state.sending = true;
  els.sendButton.disabled = true;
  els.messageInput.value = "";
  autosizeInput();

  state.history.push({ role: "user", content: text });
  saveState();
  renderHistory();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: state.sessionId,
        messages: state.history
      })
    });

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const body = await response.json();
      handleJsonChatResponse(response, body);
    } else {
      await handleStream(response);
    }
  } catch (error) {
    renderNotice("The message could not be sent. Please try again.");
    console.error(error);
  } finally {
    state.sending = false;
    els.sendButton.disabled = false;
    els.messageInput.focus();
  }
}

function handleJsonChatResponse(response, body) {
  if (body.mu) {
    state.history.push({ role: "assistant", content: "Mu" });
    saveState();
    renderHistory();
    return;
  }

  if (body.limited) {
    const reset = formatReset(body.resetsAt);
    renderLimitNotice(reset, body.artifactUrl, body.selfServeUrl || state.config.selfServeUrl || "/");
    return;
  }

  if (!response.ok) {
    renderNotice("The server could not answer this message.");
  }
}

async function handleStream(response) {
  if (!response.ok || !response.body) {
    renderNotice("The server could not start the chat stream.");
    return;
  }

  const assistant = { role: "assistant", content: "" };
  state.history.push(assistant);
  renderHistory();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      applySSE(rawEvent, assistant);
      boundary = buffer.indexOf("\n\n");
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) applySSE(buffer, assistant);
  saveState();
}

function applySSE(rawEvent, assistant) {
  const lines = rawEvent.split("\n");
  let eventName = "message";
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return;
  const data = JSON.parse(dataLines.join("\n"));

  if (eventName === "delta") {
    assistant.content += data.text || "";
    renderHistory();
  }

  if (eventName === "error") {
    assistant.content = data.message || "The chat stream failed.";
    renderHistory();
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || response.statusText);
  return body;
}

function renderHistory() {
  els.messages.textContent = "";
  if (state.history.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Ask about the Weld and Arrow theory, paper, or Lean repository.";
    els.messages.append(empty);
    return;
  }

  for (const message of state.history) {
    const node = document.createElement("article");
    node.className = `message ${message.role}`;
    const label = document.createElement("div");
    label.className = "message-label";
    label.textContent = message.role === "user" ? "You" : "Weld and Arrow";
    const body = document.createElement("div");
    body.className = "message-body";
    body.textContent = message.content || " ";
    node.append(label, body);
    els.messages.append(node);
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderNotice(text) {
  const node = document.createElement("article");
  node.className = "message assistant notice";
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = "Weld and Arrow";
  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = text;
  node.append(label, body);
  els.messages.append(node);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderLimitNotice(reset, artifactUrl, selfServeUrl) {
  const node = document.createElement("article");
  node.className = "message assistant notice";
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = "Weld and Arrow";
  const body = document.createElement("div");
  body.className = "message-body";
  body.append("The spend limit resets at ", reset, ". Meanwhile, use the public artifact on your own Claude account: ");
  const link = document.createElement("a");
  link.href = artifactUrl;
  link.rel = "noreferrer";
  link.textContent = artifactUrl;
  const selfServeLink = document.createElement("a");
  selfServeLink.href = selfServeUrl;
  selfServeLink.textContent = "take the repo to your own account";
  body.append(link, " or ", selfServeLink, ".");
  node.append(label, body);
  els.messages.append(node);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function autosizeInput() {
  els.messageInput.style.height = "auto";
  els.messageInput.style.height = `${Math.min(160, els.messageInput.scrollHeight)}px`;
}

function formatReset(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

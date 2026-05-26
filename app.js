const config = window.SHOPPING_APP_CONFIG || {};
const BOUGHT_RETENTION_DAYS = 3;
const BOUGHT_RETENTION_MS = BOUGHT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const BOUGHT_HIDE_MS = 24 * 60 * 60 * 1000;
const LIST_MOVE_DURATION = 260;
const CARD_FLIGHT_DURATION = 820;
const CARD_DEPART_DELAY = 340;
const UNDO_TIMEOUT = 5000;
const READ_SYNC_TIMEOUT_MS = 12000;
const WRITE_SYNC_TIMEOUT_MS = 30000;
const APP_VERSION = "121";
const PRODUCT_HISTORY_KEY = "unda.productHistory.v1";
const PROFANITY_MESSAGE = "Ай-ай-ай, давай без ругани";
const PROFANITY_PATTERNS = [
  /бля(?:д|т)?/u,
  /пизд/u,
  /пздц/u,
  /ху[йяеёию]/u,
  /йоб/u,
  /еб[аилнуоё]/u,
  /муд[аоие]/u,
  /залуп/u,
  /пид[оа]р/u,
  /су[кч][аиуы]/u,
  /говн/u
];
const THEME_COLORS = {
  default: "#fbf8fb",
  store: "#f7fff8"
};
const params = new URLSearchParams(window.location.search);
const state = {
  items: [],
  products: [],
  sort: localStorage.getItem("shopping.sort") || "alpha",
  activeSuggestionIndex: -1,
  editingQuantityId: "",
  editingItemId: "",
  listId: "",
  pendingMutations: 0,
  pendingUndo: 0
};

const device = buildDeviceInfo();

const dom = {
  form: document.querySelector("#entry-form"),
  themeColor: document.querySelector('meta[name="theme-color"]'),
  input: document.querySelector("#product-input"),
  duplicateNote: document.querySelector("#duplicate-note"),
  suggestions: document.querySelector("#suggestions"),
  list: document.querySelector("#shopping-list"),
  empty: document.querySelector("#empty-state"),
  status: document.querySelector("#status-text"),
  syncStatus: document.querySelector("#sync-status"),
  sync: document.querySelector("#sync-button"),
  clear: document.querySelector("#clear-button"),
  share: document.querySelector("#share-button"),
  help: document.querySelector("#help-button"),
  helpModal: document.querySelector("#help-modal"),
  helpClose: document.querySelector("#help-close"),
  shareModal: document.querySelector("#share-modal"),
  shareInput: document.querySelector("#share-link-input"),
  shareCopy: document.querySelector("#share-copy"),
  shareClose: document.querySelector("#share-close"),
  clearModal: document.querySelector("#clear-modal"),
  clearCancel: document.querySelector("#clear-cancel"),
  clearConfirm: document.querySelector("#clear-confirm"),
  toast: document.querySelector("#toast"),
  undoBar: document.querySelector("#undo-bar"),
  undoText: document.querySelector("#undo-text"),
  undoButton: document.querySelector("#undo-button"),
  quantityModal: document.querySelector("#quantity-modal"),
  quantityForm: document.querySelector("#quantity-form"),
  quantityInput: document.querySelector("#quantity-input"),
  quantityItemName: document.querySelector("#quantity-item-name"),
  quantityCancel: document.querySelector("#quantity-cancel"),
  itemModal: document.querySelector("#item-modal"),
  itemForm: document.querySelector("#item-form"),
  itemNameInput: document.querySelector("#item-name-input"),
  itemQuantityInput: document.querySelector("#item-quantity-input"),
  itemCancel: document.querySelector("#item-cancel"),
  markerOptions: [...document.querySelectorAll(".marker-option")],
  segments: [...document.querySelectorAll(".segment")],
  template: document.querySelector("#item-template")
};

const fallbackProducts = [
  "Авокадо", "Апельсины", "Бананы", "Батон", "Вода", "Гречка", "Йогурт",
  "Картофель", "Кефир", "Курица", "Лимоны", "Лук", "Молоко", "Морковь",
  "Овсянка", "Огурцы", "Помидоры", "Рис", "Сыр", "Творог", "Хлеб", "Яйца"
];

const syncMessages = {
  idle: "Сохранено",
  syncing: "Синхронизация",
  queued: "Ждет синхронизации",
  offline: "Офлайн",
  error: "Ошибка"
};

const storage = {
  get key() {
    return `unda.demo.${state.listId || "main"}`;
  },
  read() {
    return JSON.parse(localStorage.getItem(this.key) || "null") || {
      products: fallbackProducts,
      items: []
    };
  },
  write(data) {
    localStorage.setItem(this.key, JSON.stringify(data));
  }
};

const api = {
  get enabled() {
    return Boolean(config.appsScriptUrl);
  },
  async request(action, payload = {}) {
    if (!this.enabled) {
      return demoRequest(action, payload);
    }

    const controller = new AbortController();
    const timeoutMs = action === "bootstrap" ? READ_SYNC_TIMEOUT_MS : WRITE_SYNC_TIMEOUT_MS;
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(config.appsScriptUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, listId: state.listId, device, ...payload }),
      signal: controller.signal
    }).finally(() => window.clearTimeout(timeout));

    const data = await response.json();
    if (!data.ok) {
      throw new Error(data.error || "Ошибка Google Sheets");
    }
    return data;
  }
};

function demoRequest(action, payload) {
  const data = storage.read();
  cleanupData(data);

  if (action === "bootstrap") {
    storage.write(data);
    return Promise.resolve({ ok: true, ...data });
  }

  if (action === "addItem") {
    if (data.items.some((item) => !isLocallyHiddenBought(item) && sameName(item.name, payload.item.name))) {
      return Promise.resolve({ ok: false, error: "Этот товар уже есть в списке" });
    }

    data.items.push(payload.item);
    if (!data.products.some((product) => sameName(productName(product), payload.item.name))) {
      data.products.push(payload.item.name);
    }
  }

  if (action === "updateItem") {
    data.items = data.items.map((item) =>
      item.id === payload.id ? { ...item, ...payload.patch } : item
    );
  }

  if (action === "updateOrder") {
    data.items = data.items.map((item) => ({
      ...item,
      sortOrder: payload.order[item.id] ?? item.sortOrder
    }));
  }

  if (action === "deleteItem") {
    data.items = data.items.filter((item) => item.id !== payload.id);
  }

  if (action === "clearItems") {
    data.items = hasScopedIds(payload)
      ? data.items.filter((item) => !payload.ids.includes(item.id))
      : [];
  }

  if (action === "clearBoughtItems") {
    data.items = hasScopedIds(payload)
      ? data.items.filter((item) => !payload.ids.includes(item.id))
      : data.items.filter((item) => !item.bought);
  }

  if (action === "addProduct" && !data.products.some((product) => sameName(productName(product), payload.name))) {
    data.products.push(payload.name);
  }

  storage.write(data);
  return Promise.resolve({ ok: true, ...data });
}

function queuedMutationsKey() {
  return `unda.queue.${state.listId || "main"}`;
}

function readQueuedMutations() {
  return JSON.parse(localStorage.getItem(queuedMutationsKey()) || "[]");
}

function hasScopedIds(payload) {
  return Array.isArray(payload?.ids) && payload.ids.length > 0;
}

function hasUnsavedChanges() {
  return state.pendingMutations > 0 || state.pendingUndo > 0 || readQueuedMutations().length > 0;
}

function hasBlockingUnsavedChanges() {
  return state.pendingUndo > 0;
}

function writeQueuedMutations(queue) {
  localStorage.setItem(queuedMutationsKey(), JSON.stringify(queue));
  updateQueuedSyncState();
}

function createQueuedMutation(action, payload) {
  return {
    id: createId(),
    action,
    payload,
    createdAt: new Date().toISOString()
  };
}

function queueMutation(action, payload, options = {}) {
  const queue = readQueuedMutations();
  const entry = createQueuedMutation(action, payload);
  queue.push(entry);
  writeQueuedMutations(queue);
  if (options.status) setSyncStatus(options.status);
  return entry;
}

function removeQueuedMutation(id) {
  if (!id) return;
  writeQueuedMutations(readQueuedMutations().filter((entry) => entry.id !== id));
}

function queuedMutationCount() {
  return readQueuedMutations().length;
}

function isNetworkError(error) {
  return !navigator.onLine || error instanceof TypeError || error?.name === "AbortError";
}

async function flushQueuedMutations() {
  if (!api.enabled || !navigator.onLine || state.pendingMutations > 0) return;
  const queue = readQueuedMutations();
  if (!queue.length) return;

  setSyncStatus("syncing");
  while (queue.length) {
    const entry = queue[0];
    if ((entry.action === "clearItems" || entry.action === "clearBoughtItems") && !hasScopedIds(entry.payload)) {
      queue.shift();
      writeQueuedMutations(queue);
      continue;
    }
    try {
      await api.request(entry.action, entry.payload);
      queue.shift();
      writeQueuedMutations(queue);
    } catch (error) {
      if (!isNetworkError(error)) {
        queue.shift();
        writeQueuedMutations(queue);
      }
      setSyncStatus(isNetworkError(error) ? "queued" : "error");
      return;
    }
  }
  setSyncStatus("idle");
  bootstrap({ silent: true });
}

function cleanListId(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-z0-9_-]/gi, "")
    .slice(0, 40);
}

function createListId() {
  const random = Math.random().toString(36).slice(2, 8);
  return `list-${Date.now().toString(36)}-${random}`;
}

function getDeviceId() {
  const saved = localStorage.getItem("unda.deviceId");
  if (saved) return saved;

  const id = createId();
  localStorage.setItem("unda.deviceId", id);
  return id;
}

function browserName(userAgent) {
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/OPR\//.test(userAgent)) return "Opera";
  if (/CriOS|Chrome\//.test(userAgent)) return "Chrome";
  if (/FxiOS|Firefox\//.test(userAgent)) return "Firefox";
  if (/Safari\//.test(userAgent)) return "Safari";
  return "Browser";
}

function deviceName(userAgent, platform) {
  const source = `${userAgent} ${platform}`;
  const browser = browserName(userAgent);
  if (/iPhone/i.test(source)) return `iPhone ${browser}`;
  if (/iPad/i.test(source) || (platform === "MacIntel" && navigator.maxTouchPoints > 1)) return `iPad ${browser}`;
  if (/Android/i.test(source)) return `Android ${browser}`;
  if (/Mac/i.test(source)) return `Mac ${browser}`;
  if (/Win/i.test(source)) return `Windows ${browser}`;
  if (/Linux/i.test(source)) return `Linux ${browser}`;
  return browser;
}

function buildDeviceInfo() {
  const userAgent = navigator.userAgent || "";
  const platform = navigator.platform || "";
  return {
    id: getDeviceId(),
    name: deviceName(userAgent, platform),
    platform,
    browser: browserName(userAgent),
    language: navigator.language || "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    screen: `${window.screen?.width || 0}x${window.screen?.height || 0}`,
    userAgent
  };
}

function setupListId() {
  const requested = cleanListId(params.get("list"));
  const saved = cleanListId(localStorage.getItem("unda.listId"));
  state.listId = requested || saved || createListId();
  localStorage.setItem("unda.listId", state.listId);

  if (!requested || params.has("role")) {
    const url = new URL(window.location.href);
    url.searchParams.delete("role");
    url.searchParams.set("list", state.listId);
    window.history.replaceState({}, "", url);
  }
}

function localDataKey() {
  return `unda.local.${state.listId || "main"}`;
}

function saveLocalData() {
  localStorage.setItem(localDataKey(), JSON.stringify({
    products: state.products,
    items: state.items
  }));
}

function restoreLocalData() {
  const data = JSON.parse(localStorage.getItem(localDataKey()) || "null");
  if (!data) return false;
  state.products = (data.products?.length ? data.products : fallbackProducts)
    .map(normalizeProduct)
    .filter(Boolean);
  state.items = (data.items || []).map((item) => ({
    ...item,
    name: displayName(item.name),
    quantity: displayQuantity(item.quantity),
    marker: item.marker === "important" || item.marker === "maybe" ? item.marker : "",
    sortOrder: item.sortOrder || new Date(item.createdAt).getTime()
  }));
  renderSort();
  render();
  return true;
}

function cleanupData(data) {
  const now = Date.now();
  for (const item of data.items) {
    if (!data.products.some((product) => sameName(productName(product), item.name))) {
      data.products.push(displayName(item.name));
    }
  }

  data.items = data.items.filter((item) => {
    if (!item.bought || !item.boughtAt) return true;
    const boughtAt = new Date(item.boughtAt).getTime();
    if (!Number.isFinite(boughtAt)) return true;
    return now - boughtAt < BOUGHT_RETENTION_MS;
  });
}

function isLocallyHiddenBought(item) {
  if (!item.bought || !item.boughtAt) return false;
  const boughtAt = new Date(item.boughtAt).getTime();
  return Number.isFinite(boughtAt) && Date.now() - boughtAt >= BOUGHT_HIDE_MS;
}

function visibleItems() {
  return state.items.filter((item) => !isLocallyHiddenBought(item));
}

function sameName(a, b) {
  return normalize(a) === normalize(b);
}

function normalize(value) {
  return String(value).trim().toLocaleLowerCase("ru");
}

function normalizeSmartText(value) {
  return String(value)
    .trim()
    .replace(/\s+/g, " ")
    .replace(/(\d+)\s*([,.])\s*(\d+)/gu, "$1$2$3")
    .replace(/(\d+[,.]\d+)\s*%/gu, "$1%");
}

function displayName(value) {
  const clean = normalizeSmartText(value)
    .replace(/([^\d\s,.])(\d+[,.]?\d*%)/giu, "$1 $2")
    .replace(/(%)([^\s])/gu, "$1 $2")
    .replace(/\s+/g, " ");
  if (!clean) return "";
  return clean.charAt(0).toLocaleUpperCase("ru") + clean.slice(1);
}

function profanityText(value) {
  return normalize(value)
    .replace(/ё/gu, "е")
    .replace(/[3з]/gu, "з")
    .replace(/[0о]/gu, "о")
    .replace(/[1!iіl]/gu, "и")
    .replace(/[@a]/gu, "а")
    .replace(/[$s]/gu, "с")
    .replace(/[xх]/gu, "х")
    .replace(/[yу]/gu, "у")
    .replace(/[eе]/gu, "е")
    .replace(/(.)\1{2,}/gu, "$1$1")
    .replace(/[^a-zа-яё]+/giu, "");
}

function hasProfanity(value) {
  const text = profanityText(value);
  if (!text) return false;
  return PROFANITY_PATTERNS.some((pattern) => pattern.test(text));
}

function rejectProfanity(target = dom.input) {
  target?.classList.add("is-shaking");
  window.setTimeout(() => target?.classList.remove("is-shaking"), 360);
  showToast(PROFANITY_MESSAGE);
  setStatus(PROFANITY_MESSAGE);
}

function productName(product) {
  return typeof product === "string" ? product : product?.name || "";
}

function normalizeProduct(product) {
  return displayName(productName(product));
}

function productHistoryKey(name) {
  return normalizeProduct(name);
}

function readProductHistory() {
  return JSON.parse(localStorage.getItem(PRODUCT_HISTORY_KEY) || "{}");
}

function writeProductHistory(history) {
  localStorage.setItem(PRODUCT_HISTORY_KEY, JSON.stringify(history));
}

function recordProductUsage(name, quantity = "") {
  const key = productHistoryKey(name);
  if (!key) return;

  const cleanQuantity = displayQuantity(quantity);
  const history = readProductHistory();
  const entry = history[key] || { total: 0, quantities: {}, lastUsed: "" };
  entry.total += 1;
  entry.lastUsed = new Date().toISOString();
  if (cleanQuantity) {
    entry.quantities[cleanQuantity] = (entry.quantities[cleanQuantity] || 0) + 1;
  }
  history[key] = entry;
  writeProductHistory(history);
}

function preferredQuantityForProduct(name) {
  const key = productHistoryKey(name);
  const quantities = readProductHistory()[key]?.quantities || {};
  for (const item of state.items) {
    if (sameName(item.name, name) && item.quantity) {
      quantities[item.quantity] = Math.max(quantities[item.quantity] || 0, 1);
    }
  }
  let best = "";
  let bestCount = 0;
  for (const [quantity, count] of Object.entries(quantities)) {
    if (count > bestCount || (count === bestCount && quantity.length > best.length)) {
      best = quantity;
      bestCount = count;
    }
  }
  return best;
}

function displayQuantity(value) {
  return normalizeSmartText(value || "")
    .replace(/(\d+[,.]?\d*|[¼½¾])\s*([a-zа-яё]+\.?)/giu, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function parseProductInput(value) {
  const marked = normalizeSmartText(value);
  const marker = marked.includes("!") ? "important" : marked.includes("?") ? "maybe" : "";
  const clean = normalizeSmartText(marked.replace(/[!?]+/g, " "));
  if (!clean) {
    return { name: "", quantity: "", marker: "" };
  }

  const withUnit = clean.match(/^(.+?)(\d+[,.]?\d*|[¼½¾])\s*([^\d\s%]+\.?(?:\s+[^\d\s%]+\.?)?)$/iu);
  if (withUnit) {
    const name = displayName(withUnit[1]);
    const quantity = displayQuantity(`${withUnit[2]}${withUnit[3]}`);
    if (name.length >= 2) return { name, quantity, marker };
  }

  const numberOnly = clean.match(/^(.+?)(\d+[,.]?\d*)$/iu);
  if (numberOnly && !numberOnly[1].trim().endsWith("%")) {
    const name = displayName(numberOnly[1]);
    if (name.length >= 2) return { name, quantity: displayQuantity(numberOnly[2]), marker };
  }

  return { name: displayName(clean), quantity: "", marker };
}

function compactName(value) {
  return normalize(value).replace(/[^a-zа-яё0-9%]+/giu, "");
}

function editDistance(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let before = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = previous[j];
      previous[j] = a[i - 1] === b[j - 1]
        ? before
        : Math.min(previous[j] + 1, previous[j - 1] + 1, before + 1);
      before = saved;
    }
  }
  return previous[b.length];
}

function findAutocorrectName(name) {
  const source = compactName(name);
  if (source.length < 4) return "";

  let best = null;
  for (const product of state.products.map(normalizeProduct).filter(Boolean)) {
    if (sameName(product, name)) return "";
    const target = compactName(product);
    if (!target || source[0] !== target[0] || Math.abs(source.length - target.length) > 2) continue;
    const distance = editDistance(source, target);
    const limit = source.length <= 6 ? 1 : 2;
    if (distance <= limit && (!best || distance < best.distance || target.length > best.target.length)) {
      best = { name: product, target, distance };
    }
  }

  return best?.name || "";
}

function startsWithWord(name, query) {
  return normalize(name)
    .split(/[\s-]+/)
    .some((word) => word.startsWith(query));
}

function itemOrder(item) {
  return Number(item.sortOrder || new Date(item.createdAt).getTime() || 0);
}

function pluralize(count, one, few, many) {
  const lastTwo = Math.abs(count) % 100;
  const last = lastTwo % 10;
  if (lastTwo > 10 && lastTwo < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

function iconSvg(paths, options = {}) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add(options.className || "button-icon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("viewBox", options.viewBox || "0 0 24 24");
  for (const pathData of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    svg.append(path);
  }
  return svg;
}

const icons = {
  brushCleaning: [
    "m16 22-1-4",
    "M19 14a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2h-3a1 1 0 0 1-1-1V4a2 2 0 0 0-4 0v5a1 1 0 0 1-1 1H6a2 2 0 0 0-2 2v1a1 1 0 0 0 1 1",
    "M19 14H5l-1.973 6.767A1 1 0 0 0 4 22h16a1 1 0 0 0 .973-1.233Z",
    "m8 22 1-4"
  ],
  circleQuestionMark: [
    "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z",
    "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3",
    "M12 17h.01"
  ],
  delete: [
    "M10 10l4 4",
    "m14 10-4 4",
    "M20 5H7.8a2 2 0 0 0-1.4.6L2 12l4.4 6.4a2 2 0 0 0 1.4.6H20a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Z"
  ],
  messageCirclePlus: [
    "M7.9 20A9 9 0 1 0 4 16.1L2 22Z",
    "M8 12h8",
    "M12 8v8"
  ],
  share2: [
    "M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    "M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    "M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    "m8.6 13.5 6.8 4",
    "m15.4 6.5-6.8 4"
  ],
  trash2: [
    "M3 6h18",
    "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
    "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
    "M10 11v6",
    "M14 11v6"
  ],
  triangleAlert: [
    "m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z",
    "M12 9v4",
    "M12 17h.01"
  ]
};

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `item-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function vibrate(pattern) {
  if ("vibrate" in navigator) navigator.vibrate(pattern);
}

function isInteractiveTarget(target) {
  return target instanceof Element && Boolean(target.closest(".check-wrap, .delete-button, .quantity-button"));
}

function isCheckboxTarget(target) {
  return target instanceof Element && Boolean(target.closest(".check-wrap"));
}

function activeDuplicateName(value) {
  const parsed = parseProductInput(value);
  if (!parsed.name) return "";
  return visibleItems().find((item) => sameName(item.name, parsed.name))?.name || "";
}

function updateDuplicateInputState() {
  const duplicate = activeDuplicateName(dom.input.value);
  dom.form.classList.toggle("has-duplicate", Boolean(duplicate));
  dom.duplicateNote.hidden = !duplicate;
  return duplicate;
}

function setStatus(message) {
  dom.status.textContent = message;
}

function setSyncStatus(status) {
  if (status === "idle" && queuedMutationCount() > 0) {
    status = "queued";
  }
  const message = syncMessages[status] || status;
  const queued = queuedMutationCount();
  const fullMessage = status === "queued" && queued
    ? `${message}: ${queued}`
    : message;
  const text = dom.syncStatus.querySelector(".sync-text");
  if (text) {
    text.textContent = fullMessage;
  } else {
    dom.syncStatus.textContent = fullMessage;
  }
  dom.syncStatus.className = `sync-status is-${status}`;
  dom.sync.className = `icon-button is-${status}`;
  dom.sync.title = fullMessage;
  dom.sync.setAttribute("aria-label", status === "queued" && queued ? `${fullMessage} изменений` : "Синхронизировать список");
  document.body.dataset.sync = status;
}

function updateQueuedSyncState() {
  if (document.body.dataset.sync === "syncing") return;
  if (queuedMutationCount() > 0) {
    setSyncStatus("queued");
    return;
  }
  if (navigator.onLine && document.body.dataset.sync === "queued") {
    setSyncStatus("idle");
  }
}

function explainSyncStatus() {
  if (!navigator.onLine || document.body.dataset.sync === "offline") {
    showToast("Нет сети. Изменения сохранятся и отправятся позже");
    return true;
  }
  const queued = queuedMutationCount();
  if (queued) {
    showToast(`${queued} ${pluralize(queued, "изменение ждет", "изменения ждут", "изменений ждут")} отправки`);
    return false;
  }
  if (state.pendingMutations > 0) {
    showToast("Синхронизация идет в фоне");
    return false;
  }
  showToast("Список синхронизирован");
  return false;
}

function withSync(promise) {
  setSyncStatus(navigator.onLine ? "syncing" : "offline");
  return promise
    .then((result) => {
      setSyncStatus(navigator.onLine ? "idle" : "offline");
      return result;
    })
    .catch((error) => {
      setSyncStatus(navigator.onLine ? "error" : "offline");
      throw error;
    });
}

async function runMutation(request, afterSuccess, queueEntry) {
  state.pendingMutations += 1;
  let succeeded = false;
  const queued = queueEntry ? queueMutation(queueEntry.action, queueEntry.payload, { status: navigator.onLine ? "syncing" : "offline" }) : null;
  try {
    const data = await withSync(typeof request === "function" ? request() : request);
    succeeded = true;
    removeQueuedMutation(queued?.id);
    if (afterSuccess) afterSuccess(data);
    return data;
  } catch (error) {
    if (queued && isNetworkError(error)) {
      setSyncStatus(navigator.onLine ? "queued" : "offline");
      showToast("Сохранил локально, синхронизирую позже");
      return { ok: true, queued: true };
    }
    removeQueuedMutation(queued?.id);
    throw error;
  } finally {
    state.pendingMutations = Math.max(0, state.pendingMutations - 1);
    if (succeeded && state.pendingMutations === 0) {
      bootstrap({ silent: true });
    } else if (state.pendingMutations === 0) {
      updateQueuedSyncState();
    }
  }
}

function normalizeItems(items) {
  return (items || []).map((item) => ({
    ...item,
    name: displayName(item.name),
    quantity: displayQuantity(item.quantity),
    marker: item.marker === "important" || item.marker === "maybe" ? item.marker : "",
    sortOrder: item.sortOrder || new Date(item.createdAt).getTime()
  }));
}

function dataFingerprint(products, items) {
  return JSON.stringify({
    products: (products || []).map(normalizeProduct).filter(Boolean).sort((a, b) => a.localeCompare(b, "ru")),
    items: (items || []).map((item) => ({
      id: item.id,
      name: displayName(item.name),
      quantity: displayQuantity(item.quantity),
      marker: item.marker || "",
      bought: Boolean(item.bought),
      boughtAt: item.boughtAt || "",
      createdAt: item.createdAt || "",
      sortOrder: Number(item.sortOrder || new Date(item.createdAt).getTime() || 0)
    })).sort((a, b) => a.id.localeCompare(b.id))
  });
}

function sortedItems() {
  const copy = visibleItems();
  return copy.sort((a, b) => {
    if (a.bought !== b.bought) return a.bought ? 1 : -1;
    if (!a.bought && a.marker !== b.marker) {
      if (a.marker === "important") return -1;
      if (b.marker === "important") return 1;
    }
    if (a.bought && b.bought) {
      return a.name.localeCompare(b.name, "ru");
    }
    if (state.sort === "alpha") {
      return a.name.localeCompare(b.name, "ru");
    }
    return itemOrder(b) - itemOrder(a);
  });
}

function captureItemRects() {
  return new Map([...dom.list.querySelectorAll(".item")].map((node) => [
    node.dataset.id,
    node.getBoundingClientRect()
  ]));
}

function animateListMoves(previousRects, options = {}) {
  if (!previousRects?.size || prefersReducedMotion()) return;
  const delay = options.delay || 0;
  const duration = options.duration || LIST_MOVE_DURATION;

  for (const node of dom.list.querySelectorAll(".item")) {
    const previous = previousRects.get(node.dataset.id);
    if (!previous) continue;

    const next = node.getBoundingClientRect();
    const deltaX = previous.left - next.left;
    const deltaY = previous.top - next.top;
    if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) continue;

    node.classList.add("is-moving");
    node.style.transition = "none";
    node.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
    node.getBoundingClientRect();

    requestAnimationFrame(() => {
      node.style.transition = `transform ${duration}ms cubic-bezier(0.2, 0.8, 0.2, 1) ${delay}ms`;
      node.style.transform = "";
      window.setTimeout(() => {
        node.classList.remove("is-moving");
        node.style.transition = "";
      }, duration + delay + 40);
    });
  }
}

function prepareCardFlight(id) {
  if (prefersReducedMotion()) return null;
  const node = dom.list.querySelector(`[data-id="${CSS.escape(id)}"]`);
  const card = node?.querySelector(".item-card");
  if (!card) return null;

  return {
    rect: card.getBoundingClientRect(),
    card: card.cloneNode(true),
    itemClassName: node.className
  };
}

function animateCardFlight(snapshot, id, nextBought) {
  if (!snapshot || prefersReducedMotion()) {
    dom.list.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.remove("is-flight-target");
    return;
  }

  const target = dom.list.querySelector(`[data-id="${CSS.escape(id)}"]`);
  const targetCard = target?.querySelector(".item-card");
  if (!targetCard) return;

  const targetRect = targetCard.getBoundingClientRect();
  const ghost = document.createElement("div");
  const inner = document.createElement("div");
  const front = document.createElement("div");
  const back = document.createElement("div");
  const frontCard = snapshot.card;
  const backCard = targetCard.cloneNode(true);
  const frontCheck = frontCard.querySelector(".item-check");
  const backCheck = backCard.querySelector(".item-check");
  if (frontCheck) frontCheck.checked = !nextBought;
  if (backCheck) backCheck.checked = nextBought;

  ghost.className = `item-flight ${nextBought ? "is-to-bought" : "is-to-active"}`;
  ghost.setAttribute("aria-hidden", "true");
  inner.className = "item-flight-inner";
  front.className = `${snapshot.itemClassName} item-flight-side item-flight-front`;
  back.className = `${target.className.replace("is-flight-target", "")} item-flight-side item-flight-back`;
  front.append(frontCard);
  back.append(backCard);
  inner.append(front, back);
  ghost.append(inner);
  Object.assign(ghost.style, {
    left: `${snapshot.rect.left}px`,
    top: `${snapshot.rect.top}px`,
    width: `${snapshot.rect.width}px`,
    height: `${snapshot.rect.height}px`
  });
  document.body.append(ghost);

  const deltaX = targetRect.left - snapshot.rect.left;
  const deltaY = targetRect.top - snapshot.rect.top;
  const lift = Math.min(26, Math.max(10, Math.abs(deltaY) * 0.12));
  const arcY = deltaY >= 0 ? -lift : lift;
  const direction = nextBought ? -180 : 180;

  const move = ghost.animate([
    { transform: "translate3d(0, 0, 0) scale(1)", offset: 0 },
    { transform: `translate3d(${deltaX * 0.12}px, ${deltaY * 0.12 + arcY}px, 0) scale(1.025)`, offset: 0.38 },
    { transform: `translate3d(${deltaX * 0.48}px, ${deltaY * 0.48 + arcY * 0.35}px, 0) scale(1.018)`, offset: 0.66 },
    { transform: `translate3d(${deltaX}px, ${deltaY}px, 0) scale(1)`, offset: 1 }
  ], {
    duration: CARD_FLIGHT_DURATION,
    easing: "cubic-bezier(0.22, 0.72, 0.18, 1)",
    fill: "forwards"
  });

  inner.animate([
    { transform: "rotateX(0deg)", offset: 0 },
    { transform: `rotateX(${direction * 0.42}deg)`, offset: 0.38 },
    { transform: `rotateX(${direction}deg)`, offset: 0.78 },
    { transform: `rotateX(${direction}deg)`, offset: 1 }
  ], {
    duration: CARD_FLIGHT_DURATION,
    easing: "cubic-bezier(0.25, 0.72, 0.22, 1)",
    fill: "forwards"
  });

  const finish = () => {
    ghost.remove();
    target.classList.remove("is-flight-target");
  };
  move.finished.then(finish).catch(finish);
}

function render(options = {}) {
  const scrollY = window.scrollY;
  const animate = options.animate !== false;
  const previousRects = options.move ? captureItemRects() : null;
  document.body.classList.toggle("quiet-render", !animate);
  dom.list.replaceChildren();
  const items = sortedItems();
  const isStoreMode = items.some((item) => item.bought);
  dom.empty.classList.toggle("is-visible", items.length === 0);
  document.body.classList.toggle("store-mode", isStoreMode);
  updateInstallTheme(isStoreMode);

  for (const item of items) {
    if (item.bought && !dom.list.querySelector(".list-separator")) {
      const separator = document.createElement("li");
      separator.className = "list-separator";
      const text = document.createElement("span");
      text.textContent = "Куплено";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "clear-bought-button";
      button.setAttribute("aria-label", "Очистить купленные");
      button.title = "Очистить купленные";
      button.append(iconSvg(icons.trash2));
      separator.append(text, button);
      dom.list.append(separator);
    }
    const node = dom.template.content.firstElementChild.cloneNode(true);
    node.dataset.id = item.id;
    node.draggable = false;
    node.classList.toggle("can-reorder", state.sort === "added" && !item.bought && item.marker !== "important");
    node.classList.toggle("is-bought", Boolean(item.bought));
    node.classList.toggle("is-important", item.marker === "important");
    node.classList.toggle("is-maybe", item.marker === "maybe");
    node.classList.toggle("is-flight-target", item.id === options.flightId);
    node.classList.toggle("skip-land", options.move && previousRects?.has(item.id));
    node.classList.toggle("is-new", item.id === options.newItemId);
    const itemName = node.querySelector(".item-name");
    itemName.textContent = item.name;
    if (!item.bought && item.marker === "important") {
      itemName.append(iconSvg(icons.triangleAlert, { className: "marker-icon" }));
    }
    if (!item.bought && item.marker === "maybe") {
      itemName.append(iconSvg(icons.circleQuestionMark, { className: "marker-icon" }));
    }
    const quantityButton = node.querySelector(".quantity-button");
    quantityButton.replaceChildren();
    if (item.quantity) {
      const quantityText = document.createElement("span");
      quantityText.textContent = item.quantity;
      quantityButton.append(quantityText);
    } else if (!item.bought) {
      quantityButton.append(iconSvg(icons.messageCirclePlus));
    }
    quantityButton.classList.toggle("is-empty", !item.quantity);
    quantityButton.disabled = Boolean(item.bought);
    quantityButton.setAttribute("aria-label", item.quantity ? `Количество: ${item.quantity}` : "Добавить количество");
    quantityButton.addEventListener("click", () => editQuantity(item.id));
    const checkbox = node.querySelector(".item-check");
    checkbox.checked = Boolean(item.bought);
    checkbox.addEventListener("change", () => toggleItem(item.id));
    const deleteButton = node.querySelector(".delete-button");
    deleteButton.replaceChildren(iconSvg(icons.delete));
    deleteButton.addEventListener("click", () => removeItem(item.id));
    wireItemGestures(node);
    dom.list.append(node);
  }

  if (!animate) {
    window.scrollTo({ top: scrollY, left: 0, behavior: "instant" });
    requestAnimationFrame(() => document.body.classList.remove("quiet-render"));
  }

  if (animate) {
    animateListMoves(previousRects, {
      delay: options.moveDelay || 0,
      duration: options.moveDuration || LIST_MOVE_DURATION
    });
  }
}

function renderSort() {
  dom.segments.forEach((button) => {
    const active = button.dataset.sort === state.sort;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", String(active));
  });
}

function renderSuggestions() {
  const markerPrefix = inputMarkerPrefix();
  const parsedInput = parseProductInput(dom.input.value);
  const query = normalize(parsedInput.name || dom.input.value.replace(/[!?]+/g, " "));
  const shouldSuggestQuantity = !parsedInput.quantity;
  dom.suggestions.replaceChildren();
  state.activeSuggestionIndex = -1;
  updateDuplicateInputState();

  if (!query) {
    dom.suggestions.classList.remove("is-open");
    return;
  }

  const matches = state.products
    .map((product) => product)
    .filter(Boolean)
    .filter((name, index, products) => products.findIndex((product) => sameName(product, name)) === index)
    .filter((name) => startsWithWord(name, query))
    .filter((name) => !state.items.some((item) => sameName(item.name, name) && !item.bought))
    .map((name) => ({
      name,
      quantity: shouldSuggestQuantity ? preferredQuantityForProduct(name) : ""
    }))
    .sort((a, b) => Number(Boolean(b.quantity)) - Number(Boolean(a.quantity)) || a.name.localeCompare(b.name, "ru"))
    .slice(0, 6);

  for (const [index, suggestion] of matches.entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggestion";
    button.setAttribute("role", "option");
    button.dataset.index = String(index);
    button.dataset.value = `${markerPrefix}${suggestion.name}${suggestion.quantity ? ` ${suggestion.quantity}` : ""}`;

    const nameText = document.createElement("span");
    nameText.className = "suggestion-name";
    nameText.textContent = suggestion.name;
    button.append(nameText);
    if (suggestion.quantity) {
      const quantityText = document.createElement("span");
      quantityText.className = "suggestion-quantity";
      quantityText.textContent = suggestion.quantity;
      button.append(quantityText);
    }

    button.addEventListener("click", () => {
      dom.input.value = button.dataset.value;
      dom.suggestions.classList.remove("is-open");
      dom.input.focus();
    });
    dom.suggestions.append(button);
  }

  dom.suggestions.classList.toggle("is-open", matches.length > 0);
}

function setActiveSuggestion(index) {
  const options = [...dom.suggestions.querySelectorAll(".suggestion")];
  if (!options.length) {
    state.activeSuggestionIndex = -1;
    return;
  }

  state.activeSuggestionIndex = (index + options.length) % options.length;
  options.forEach((option, optionIndex) => {
    const active = optionIndex === state.activeSuggestionIndex;
    option.classList.toggle("is-active", active);
    option.setAttribute("aria-selected", String(active));
    if (active) option.scrollIntoView({ block: "nearest" });
  });
}

function selectedSuggestion() {
  if (state.activeSuggestionIndex < 0) return "";
  const option = dom.suggestions.querySelectorAll(".suggestion")[state.activeSuggestionIndex];
  return option?.dataset.value || option?.textContent || "";
}

function inputMarkerPrefix() {
  if (dom.input.value.includes("!")) return "!";
  if (dom.input.value.includes("?")) return "?";
  return "";
}

async function bootstrap(options = {}) {
  if (readQueuedMutations().length) {
    await flushQueuedMutations();
    if (options.silent) return;
  }
  if (options.silent && (state.pendingMutations > 0 || state.pendingUndo > 0)) return;
  if (!options.silent) setStatus("Синхронизация...");
  try {
    const data = await withSync(api.request("bootstrap"));
    if (state.pendingMutations > 0) {
      if (!options.silent) setStatus("Сохраняем локальные изменения...");
      return;
    }
    const nextProducts = (data.products?.length ? data.products : fallbackProducts)
      .map(normalizeProduct)
      .filter(Boolean);
    const nextItems = normalizeItems(data.items);
    const currentFingerprint = dataFingerprint(state.products, state.items);
    const nextFingerprint = dataFingerprint(nextProducts, nextItems);
    if (options.silent && currentFingerprint === nextFingerprint) return;

    state.products = nextProducts;
    state.items = nextItems;
    saveLocalData();
    renderSort();
    render({ animate: !options.silent });
    if (!options.silent) {
      if (api.enabled && data.listScoped !== true) {
        setStatus("Обнови Apps Script: сервер пока не разделяет списки");
      } else {
        setStatus(api.enabled ? "Данные загружены" : "Демо-режим: укажи Apps Script URL в config.js");
      }
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      setSyncStatus(queuedMutationCount() ? "queued" : "idle");
      if (!options.silent) setStatus("Синхронизация продолжится позже");
      return;
    }
    if (!options.silent) setStatus(error.message);
  }
}

async function addItem(value) {
  const parsed = parseProductInput(value);
  const correctedName = findAutocorrectName(parsed.name);
  const cleanName = correctedName || parsed.name;
  if (!cleanName) return;

  if (hasProfanity(cleanName)) {
    rejectProfanity(dom.input);
    return;
  }

  if (visibleItems().some((item) => sameName(item.name, cleanName))) {
    dom.input.value = cleanName;
    renderSuggestions();
    setStatus("Этот товар уже есть в списке");
    return;
  }

  const item = {
    id: createId(),
    name: cleanName,
    quantity: parsed.quantity,
    marker: parsed.marker,
    bought: false,
    createdAt: new Date().toISOString(),
    sortOrder: Date.now()
  };

  state.items.push(item);
  recordProductUsage(item.name, item.quantity);
  if (!state.products.some((product) => sameName(product, cleanName))) {
    state.products.push(cleanName);
  }
  dom.input.value = "";
  renderSuggestions();
  saveLocalData();
  render({ move: true, newItemId: item.id });

  try {
    await runMutation(() => api.request("addItem", { item }), null, { action: "addItem", payload: { item } });
    setStatus(correctedName ? `Добавлено: ${correctedName}` : "Добавлено");
  } catch (error) {
    state.items = state.items.filter((existing) => existing.id !== item.id);
    saveLocalData();
    render({ move: true });
    setStatus(error.message);
  }
}

async function toggleItem(id) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return;

  const flight = prepareCardFlight(id);
  const previousBought = item.bought;
  const previousBoughtAt = item.boughtAt || "";
  item.bought = !item.bought;
  item.boughtAt = item.bought ? new Date().toISOString() : "";
  vibrate(item.bought ? 12 : 8);
  saveLocalData();
  render({
    move: true,
    flightId: id,
    moveDelay: CARD_DEPART_DELAY,
    moveDuration: CARD_FLIGHT_DURATION - CARD_DEPART_DELAY
  });
  animateCardFlight(flight, id, item.bought);

  try {
    const patch = { bought: item.bought, boughtAt: item.boughtAt };
    await runMutation(() => api.request("updateItem", { id, patch }), null, { action: "updateItem", payload: { id, patch } });
    setStatus(item.bought ? "Отмечено как купленное" : "Вернули в список");
  } catch (error) {
    item.bought = previousBought;
    item.boughtAt = previousBoughtAt;
    saveLocalData();
    render({ move: true });
    setStatus(error.message);
  }
}

async function editQuantity(id) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item || item.bought) return;

  state.editingQuantityId = id;
  dom.quantityItemName.textContent = item.name;
  dom.quantityInput.value = item.quantity || "";
  dom.quantityModal.hidden = false;
  requestAnimationFrame(() => {
    dom.quantityInput.focus();
    dom.quantityInput.select();
  });
}

function closeQuantityModal() {
  state.editingQuantityId = "";
  dom.quantityModal.hidden = true;
  dom.quantityInput.value = "";
}

function setMarkerEditor(marker) {
  dom.markerOptions.forEach((button) => {
    const active = button.dataset.marker === marker;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function selectedMarkerEditor() {
  return dom.markerOptions.find((button) => button.classList.contains("is-active"))?.dataset.marker || "";
}

async function editItemDetails(id) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item || item.bought) return;

  state.editingItemId = id;
  dom.itemNameInput.value = item.name;
  dom.itemQuantityInput.value = item.quantity || "";
  setMarkerEditor(item.marker || "");
  dom.itemModal.hidden = false;
}

function closeItemModal() {
  state.editingItemId = "";
  dom.itemModal.hidden = true;
  dom.itemNameInput.value = "";
  dom.itemQuantityInput.value = "";
  setMarkerEditor("");
}

async function saveItemDetails() {
  const item = state.items.find((entry) => entry.id === state.editingItemId);
  if (!item || item.bought) {
    closeItemModal();
    return;
  }

  const nextName = displayName(dom.itemNameInput.value);
  if (!nextName) return;
  if (hasProfanity(nextName)) {
    rejectProfanity(dom.itemNameInput);
    return;
  }
  if (state.items.some((entry) => entry.id !== item.id && !entry.bought && sameName(entry.name, nextName))) {
    setStatus("Этот товар уже есть в списке");
    return;
  }

  const previous = { name: item.name, quantity: item.quantity || "", marker: item.marker || "" };
  const patch = {
    name: nextName,
    quantity: displayQuantity(dom.itemQuantityInput.value),
    marker: selectedMarkerEditor()
  };

  Object.assign(item, patch);
  recordProductUsage(item.name, item.quantity);
  if (!state.products.some((product) => sameName(product, item.name))) {
    state.products.push(item.name);
  }
  closeItemModal();
  saveLocalData();
  render();

  try {
    await runMutation(() => api.request("updateItem", { id: item.id, patch }), null, { action: "updateItem", payload: { id: item.id, patch } });
    setStatus("Товар обновлен");
  } catch (error) {
    Object.assign(item, previous);
    saveLocalData();
    render();
    setStatus(error.message);
  }
}

async function saveQuantity(value) {
  const item = state.items.find((entry) => entry.id === state.editingQuantityId);
  if (!item || item.bought) {
    closeQuantityModal();
    return;
  }

  const previousQuantity = item.quantity || "";
  item.quantity = displayQuantity(value);
  recordProductUsage(item.name, item.quantity);
  closeQuantityModal();
  saveLocalData();
  render();

  try {
    const patch = { quantity: item.quantity };
    await runMutation(() => api.request("updateItem", { id: item.id, patch }), null, { action: "updateItem", payload: { id: item.id, patch } });
    setStatus(item.quantity ? "Количество обновлено" : "Количество убрано");
  } catch (error) {
    item.quantity = previousQuantity;
    saveLocalData();
    render();
    setStatus(error.message);
  }
}

async function saveOrder() {
  const ids = [...dom.list.querySelectorAll(".item")]
    .map((node) => node.dataset.id)
    .filter((id) => {
      const item = state.items.find((entry) => entry.id === id);
      return item && !item.bought && item.marker !== "important";
    });
  const order = {};
  const base = Date.now();
  ids.forEach((id, index) => {
    order[id] = base - index;
  });

  state.items = state.items.map((item) => ({
    ...item,
    sortOrder: order[item.id] ?? item.sortOrder
  }));
  saveLocalData();

  try {
    await runMutation(() => api.request("updateOrder", { order }), null, { action: "updateOrder", payload: { order } });
    setStatus("Порядок обновлен");
  } catch (error) {
    setStatus(error.message);
    bootstrap();
  }
}

async function removeItem(id) {
  const node = dom.list.querySelector(`[data-id="${CSS.escape(id)}"]`);
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return;
  const previousItems = [...state.items];

  vibrate([18, 28, 24]);
  node?.classList.add("is-removing");
  await new Promise((resolve) => setTimeout(resolve, prefersReducedMotion() ? 1 : 180));
  state.items = state.items.filter((entry) => entry.id !== id);
  saveLocalData();
  render({ move: true });
  showUndo("Товар удален", () => {
    state.items = previousItems;
    saveLocalData();
    render({ move: true });
  }, async () => {
    try {
      await runMutation(() => api.request("deleteItem", { id }), null, { action: "deleteItem", payload: { id } });
      setStatus("Удалено");
    } catch (error) {
      state.items = previousItems;
      saveLocalData();
      render({ move: true });
      setStatus(error.message);
    }
  });
}

async function clearItems() {
  if (!state.items.length) return;
  openClearConfirm();
}

async function confirmClearItems() {
  closeClearConfirm();
  if (!state.items.length) return;
  const previous = [...state.items];
  const ids = previous.map((item) => item.id);
  state.items = [];
  saveLocalData();
  render({ move: true });
  showUndo("Список очищен", () => {
    state.items = previous;
    saveLocalData();
    render({ move: true });
  }, async () => {
    try {
      await runMutation(() => api.request("clearItems", { ids }), null, { action: "clearItems", payload: { ids } });
      setStatus("Список очищен");
    } catch (error) {
      state.items = previous;
      saveLocalData();
      render({ move: true });
      setStatus(error.message);
    }
  });
}

async function clearBoughtItems() {
  const boughtItems = state.items.filter((item) => item.bought);
  if (!boughtItems.length) return;

  const previous = [...state.items];
  const ids = boughtItems.map((item) => item.id);
  state.items = state.items.filter((item) => !item.bought);
  saveLocalData();
  render({ move: true });
  showUndo("Купленные убраны", () => {
    state.items = previous;
    saveLocalData();
    render({ move: true });
  }, async () => {
    try {
      await runMutation(() => api.request("clearBoughtItems", { ids }), null, { action: "clearBoughtItems", payload: { ids } });
      setStatus("Купленные убраны");
    } catch (error) {
      state.items = previous;
      saveLocalData();
      render({ move: true });
      setStatus(error.message);
    }
  });
}

function handleListAction(event) {
  if (!(event.target instanceof Element)) return;
  if (event.target.closest(".clear-bought-button")) {
    clearBoughtItems();
  }
}

function openClearConfirm() {
  dom.clearModal.hidden = false;
  dom.clearConfirm.focus();
}

function closeClearConfirm() {
  dom.clearModal.hidden = true;
}

function sharedListUrl() {
  const shareBase = String(config.shareBaseUrl || "").trim();
  const currentUrl = new URL(window.location.href);
  currentUrl.hash = "";
  currentUrl.search = "";
  const url = new URL(shareBase || currentUrl.toString(), window.location.href);
  url.searchParams.delete("role");
  url.searchParams.set("list", state.listId);
  url.searchParams.set("v", APP_VERSION);
  return url.toString();
}

function updateInstallTheme(isStoreMode) {
  if (dom.themeColor) {
    dom.themeColor.content = isStoreMode ? THEME_COLORS.store : THEME_COLORS.default;
  }
}

function isInstalledPwa() {
  return Boolean(window.navigator.standalone) || window.matchMedia?.("(display-mode: standalone)").matches;
}

function updateDisplayMode() {
  document.body.classList.toggle("is-installed", isInstalledPwa());
}

function openHelp() {
  dom.helpModal.hidden = false;
}

function closeHelp() {
  dom.helpModal.hidden = true;
}

function showToast(message) {
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    dom.toast.hidden = true;
  }, 1800);
}

function showUndo(message, undo, commit) {
  if (showUndo.commit) {
    window.clearTimeout(showUndo.timer);
    showUndo.commit();
  }

  state.pendingUndo += 1;
  let settled = false;

  const settle = () => {
    if (settled) return false;
    settled = true;
    state.pendingUndo = Math.max(0, state.pendingUndo - 1);
    if (showUndo.commit === commitNow) {
      showUndo.commit = null;
    }
    return true;
  };

  const undoNow = () => {
    if (!settle()) return;
    undo();
  };

  const commitNow = () => {
    if (!settle()) return;
    commit();
  };

  window.clearTimeout(showUndo.timer);
  dom.undoText.textContent = message;
  dom.undoBar.hidden = false;
  dom.undoButton.onclick = () => {
    window.clearTimeout(showUndo.timer);
    dom.undoBar.hidden = true;
    undoNow();
  };
  showUndo.commit = commitNow;
  showUndo.timer = window.setTimeout(() => {
    dom.undoBar.hidden = true;
    commitNow();
  }, UNDO_TIMEOUT);
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch (error) {
    const input = document.createElement("input");
    input.value = value;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    return copied;
  }
}

function openShareModal(url) {
  dom.shareInput.value = url;
  dom.shareModal.hidden = false;
}

function closeShareModal() {
  dom.shareModal.hidden = true;
}

async function shareList() {
  const url = sharedListUrl();
  if (navigator.share) {
    try {
      await navigator.share({ url });
      showToast("Ссылка отправлена");
      return;
    } catch (error) {
      if (error.name === "AbortError") return;
    }
  }

  if (await copyText(url)) {
    showToast("Ссылка скопирована");
  } else {
    openShareModal(url);
  }
}

function wireItemGestures(node) {
  let startX = 0;
  let startY = 0;
  let currentX = 0;
  let mode = "";
  let placeholder = null;
  let longPressTimer = 0;
  let longPressed = false;
  const card = node.querySelector(".item-card");

  function clearLongPress() {
    window.clearTimeout(longPressTimer);
    longPressTimer = 0;
  }

  node.addEventListener("pointerdown", (event) => {
    if (isInteractiveTarget(event.target)) return;
    const item = state.items.find((entry) => entry.id === node.dataset.id);
    if (!item) return;
    if (state.sort === "added" && !item.bought && item.marker !== "important") {
      event.preventDefault();
    }
    startX = event.clientX;
    startY = event.clientY;
    currentX = 0;
    mode = "";
    longPressed = false;
    if (!item.bought) {
      longPressTimer = window.setTimeout(() => {
        longPressed = true;
        mode = "edit";
        editItemDetails(node.dataset.id);
      }, 560);
    }
    node.setPointerCapture(event.pointerId);
  });

  node.addEventListener("pointermove", (event) => {
    if (!startX) return;
    const item = state.items.find((entry) => entry.id === node.dataset.id);
    if (!item) return;
    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;

    if (!mode && Math.max(Math.abs(deltaX), Math.abs(deltaY)) > 8) {
      clearLongPress();
      mode = Math.abs(deltaX) > Math.abs(deltaY) ? "swipe" : "reorder";
      if (mode === "reorder" && (state.sort !== "added" || item.bought || item.marker === "important")) {
        mode = "";
        startX = 0;
        return;
      }
      if (mode === "reorder") {
        placeholder = beginReorder(node);
      }
    }

    if (mode === "swipe") {
      event.preventDefault();
      currentX = Math.min(0, deltaX);
      card.style.transform = `translateX(${currentX}px)`;
      card.style.opacity = String(Math.max(0.45, 1 - Math.abs(currentX) / 220));
      return;
    }

    if (mode === "reorder") {
      event.preventDefault();
      node.style.transform = `translate3d(0, ${deltaY}px, 0)`;
      movePlaceholderByPointer(node, placeholder, event.clientY);
    }
  });

  node.addEventListener("pointerup", (event) => {
    clearLongPress();
    finishGesture(node, card, mode, currentX, placeholder);
    if (!mode && !longPressed && !isInteractiveTarget(event.target)) {
      toggleItem(node.dataset.id);
    }
    startX = 0;
    mode = "";
    placeholder = null;
  });

  node.addEventListener("pointercancel", () => {
    clearLongPress();
    finishGesture(node, card, mode, 0, placeholder);
    startX = 0;
    mode = "";
    placeholder = null;
  });

  node.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    editItemDetails(node.dataset.id);
  });
}

function beginReorder(node) {
  const rect = node.getBoundingClientRect();
  const placeholder = document.createElement("li");
  placeholder.className = "item-placeholder";
  placeholder.style.height = `${rect.height}px`;
  dom.list.insertBefore(placeholder, node.nextSibling);

  node.classList.add("is-reordering");
  node.style.position = "fixed";
  node.style.left = `${rect.left}px`;
  node.style.top = `${rect.top}px`;
  node.style.width = `${rect.width}px`;
  node.style.zIndex = "10";
  node.style.margin = "0";
  return placeholder;
}

function movePlaceholderByPointer(node, placeholder, clientY) {
  const item = state.items.find((entry) => entry.id === node.dataset.id);
  if (!item || item.bought || !placeholder) return;

  const siblings = [...dom.list.querySelectorAll(".item:not(.is-reordering)")];
  const target = siblings.find((sibling) => {
    const siblingItem = state.items.find((entry) => entry.id === sibling.dataset.id);
    if (!siblingItem || siblingItem.bought || siblingItem.marker === "important") return false;
    const rect = sibling.getBoundingClientRect();
    return clientY < rect.top + rect.height / 2;
  });

  if (target) {
    dom.list.insertBefore(placeholder, target);
    return;
  }

  const firstBought = [...dom.list.querySelectorAll(".item:not(.is-reordering)")].find((sibling) => {
    const siblingItem = state.items.find((entry) => entry.id === sibling.dataset.id);
    return siblingItem?.bought;
  });
  dom.list.insertBefore(placeholder, dom.list.querySelector(".list-separator") || firstBought || null);
}

function finishGesture(node, card, mode, currentX, placeholder) {
  const id = node.dataset.id;
  const item = state.items.find((entry) => entry.id === id);
  card.style.transform = "";
  card.style.opacity = "";

  if (mode === "edit") {
    if (placeholder) placeholder.remove();
    resetReorderStyles(node);
    return;
  }

  if (mode === "swipe" && Math.abs(currentX) > 86) {
    removeItem(id);
    return;
  }

  if (mode === "reorder" && item && !item.bought) {
    if (placeholder) {
      dom.list.insertBefore(node, placeholder);
      placeholder.remove();
    }
    resetReorderStyles(node);
    saveOrder();
    return;
  }

  if (placeholder) placeholder.remove();
  resetReorderStyles(node);
}

function resetReorderStyles(node) {
  node.classList.remove("is-reordering");
  node.style.position = "";
  node.style.left = "";
  node.style.top = "";
  node.style.width = "";
  node.style.zIndex = "";
  node.style.margin = "";
  node.style.transform = "";
}

dom.list.addEventListener("click", (event) => {
  handleListAction(event);
  if (isCheckboxTarget(event.target)) {
    event.stopPropagation();
  }
});

dom.form.addEventListener("submit", (event) => {
  event.preventDefault();
  addItem(dom.input.value);
});

dom.input.addEventListener("input", renderSuggestions);
dom.input.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    setActiveSuggestion(state.activeSuggestionIndex + 1);
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    setActiveSuggestion(state.activeSuggestionIndex - 1);
    return;
  }

  if (event.key === "Enter" && dom.input.value.trim()) {
    const suggestion = selectedSuggestion();
    event.preventDefault();
    if (suggestion) {
      addItem(suggestion);
      return;
    }
    dom.suggestions.classList.remove("is-open");
    addItem(dom.input.value);
  }
});

dom.sync.addEventListener("click", () => {
  if (explainSyncStatus()) return;
  bootstrap();
});
dom.clear.addEventListener("click", clearItems);
dom.clearCancel.addEventListener("click", closeClearConfirm);
dom.clearConfirm.addEventListener("click", confirmClearItems);
dom.clearModal.addEventListener("click", (event) => {
  if (event.target === dom.clearModal) {
    closeClearConfirm();
  }
});
dom.share.addEventListener("click", shareList);
dom.help.addEventListener("click", openHelp);
dom.shareClose.addEventListener("click", closeShareModal);
dom.shareModal.addEventListener("click", (event) => {
  if (event.target === dom.shareModal) {
    closeShareModal();
  }
});
dom.shareCopy.addEventListener("click", async () => {
  if (await copyText(dom.shareInput.value)) {
    closeShareModal();
    showToast("Ссылка скопирована");
  }
});
dom.quantityForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveQuantity(dom.quantityInput.value);
});
dom.quantityCancel.addEventListener("click", closeQuantityModal);
dom.quantityModal.addEventListener("click", (event) => {
  if (event.target === dom.quantityModal) {
    closeQuantityModal();
  }
});
dom.itemForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveItemDetails();
});
dom.itemCancel.addEventListener("click", closeItemModal);
dom.itemModal.addEventListener("click", (event) => {
  if (event.target === dom.itemModal) {
    closeItemModal();
  }
});
dom.markerOptions.forEach((button) => {
  button.addEventListener("click", () => setMarkerEditor(button.dataset.marker));
});
dom.helpClose.addEventListener("click", closeHelp);
dom.helpModal.addEventListener("click", (event) => {
  if (event.target === dom.helpModal) {
    closeHelp();
  }
});
dom.segments.forEach((button) => {
  button.addEventListener("click", () => {
    state.sort = button.dataset.sort;
    localStorage.setItem("shopping.sort", state.sort);
    renderSort();
    render();
  });
});

document.addEventListener("click", (event) => {
  if (!dom.form.contains(event.target)) {
    dom.suggestions.classList.remove("is-open");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !dom.quantityModal.hidden) {
    closeQuantityModal();
  }
  if (event.key === "Escape" && !dom.itemModal.hidden) {
    closeItemModal();
  }
  if (event.key === "Escape" && !dom.helpModal.hidden) {
    closeHelp();
  }
  if (event.key === "Escape" && !dom.shareModal.hidden) {
    closeShareModal();
  }
  if (event.key === "Escape" && !dom.clearModal.hidden) {
    closeClearConfirm();
  }
});

window.addEventListener("online", () => {
  setSyncStatus("idle");
  flushQueuedMutations();
});
window.addEventListener("offline", () => setSyncStatus("offline"));
window.addEventListener("beforeunload", (event) => {
  if (!hasBlockingUnsavedChanges()) return;
  event.preventDefault();
  event.returnValue = "";
});
const displayModeQuery = window.matchMedia?.("(display-mode: standalone)");
displayModeQuery?.addEventListener?.("change", updateDisplayMode);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js");
}

updateDisplayMode();
setSyncStatus(navigator.onLine ? "idle" : "offline");
setupListId();
updateQueuedSyncState();
if (restoreLocalData()) {
  setStatus("Локальный список загружен");
} else {
  render({ animate: false });
}
bootstrap();

setInterval(() => {
  if (!document.hidden) bootstrap({ silent: true });
}, 60000);

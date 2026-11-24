const STORAGE_KEY = "ops-quadrant-board-v1";
const STATUSES = ["未开始", "进行中", "已完成"];
const QUADRANTS = [
  { id: "q1", name: "紧急重要" },
  { id: "q2", name: "紧急不重要" },
  { id: "q3", name: "重要不紧急" },
  { id: "q4", name: "不重要不紧急" },
];
const GRID = [
  ["q1", "q2"],
  ["q3", "q4"],
];
const HEADER_ALIASES = [
  ["title", ["任务", "标题", "待办", "事项", "内容", "工作项", "task", "title", "name", "todo"]],
  ["owner", ["主责人", "负责人", "责任人", "执行人", "owner", "assignee"]],
  ["status", ["完成情况", "状态", "进度", "status"]],
  ["blockers", ["难点", "阻碍", "阻塞", "备注", "问题", "blocker", "blockers", "notes"]],
  ["quadrant", ["象限", "分类", "quadrant"]],
];
const SAMPLES = [
  {
    id: "sample-complaint",
    title: "升级投诉已超过 4 小时未回复",
    owner: "林可",
    status: "进行中",
    blockers: "物流轨迹停在中转站，客服没有新的节点可同步给客户。",
    quadrant: "q1",
    order: 0,
  },
  {
    id: "sample-payment",
    title: "支付成功但订单未入账，今日内补单",
    owner: "周宁",
    status: "未开始",
    blockers: "渠道对账文件预计 18:00 才出。",
    quadrant: "q1",
    order: 1,
  },
  {
    id: "sample-price",
    title: "门店价签已改成与线上促销价一致",
    owner: "陈舟",
    status: "已完成",
    blockers: "",
    quadrant: "q1",
    order: 2,
  },
  {
    id: "sample-seal",
    title: "供应商催要盖章回执，合同条款不变",
    owner: "赵敏",
    status: "进行中",
    blockers: "公章在外地出差同事处，今晚才能寄回。",
    quadrant: "q2",
    order: 0,
  },
  {
    id: "sample-staff",
    title: "周末快闪临时借调两名店员",
    owner: "吴迪",
    status: "未开始",
    blockers: "",
    quadrant: "q2",
    order: 1,
  },
  {
    id: "sample-shift",
    title: "修订下月夜班排班规则",
    owner: "何晴",
    status: "未开始",
    blockers: "店长还没确认连班上限。",
    quadrant: "q3",
    order: 0,
  },
  {
    id: "sample-sku",
    title: "复盘上季度缺货最多的 20 个 SKU",
    owner: "马力",
    status: "进行中",
    blockers: "华东仓少了一周的出库明细。",
    quadrant: "q3",
    order: 1,
  },
  {
    id: "sample-posters",
    title: "归档共享盘里的过季海报",
    owner: "苏晚",
    status: "未开始",
    blockers: "",
    quadrant: "q4",
    order: 0,
  },
  {
    id: "sample-news",
    title: "把行业周报按月份收进文件夹",
    owner: "实习生",
    status: "未开始",
    blockers: "",
    quadrant: "q4",
    order: 1,
  },
];

let tasks = [];
let memoryOnly = false;
let openId = null;
let pointer = null;
let tap = null;
let fileDragDepth = 0;
let confirmResolver = null;

export function normalizeStatus(value) {
  const raw = String(value || "").trim();
  const s = raw.toLowerCase();
  if (!s) return "未开始";
  if (/未开始|未完成|待办|todo|pending|未处理/.test(s)) return "未开始";
  if (/进行|doing|in progress|wip|处理中/.test(s)) return "进行中";
  if (/已完成|完成|done|completed|closed/.test(s)) return "已完成";
  return "未开始";
}

export function quadrantFromText(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const s = raw.toLowerCase().replace(/\s+/g, "");
  if (["q1", "1", "紧急重要", "重要紧急", "重要且紧急", "紧急且重要"].includes(s)) return "q1";
  if (["q2", "2", "紧急不重要", "不重要但紧急", "紧急但不重要"].includes(s)) return "q2";
  if (["q3", "3", "重要不紧急", "不紧急但重要", "重要但不紧急"].includes(s)) return "q3";
  if (["q4", "4", "不重要不紧急", "不紧急不重要", "既不紧急也不重要"].includes(s)) return "q4";
  const notUrgent = s.includes("不紧急");
  const notImportant = s.includes("不重要");
  const isUrgent = s.includes("紧急") && !notUrgent;
  const isImportant = s.includes("重要") && !notImportant;
  if (isUrgent && isImportant) return "q1";
  if (isUrgent && notImportant) return "q2";
  if (notUrgent && isImportant) return "q3";
  if (notUrgent && notImportant) return "q4";
  return null;
}

function clampText(value, max) {
  const s = String(value ?? "");
  return s.length > max ? s.slice(0, max) : s;
}

function headerKey(cell) {
  const n = String(cell || "").trim().toLowerCase().replace(/\s+/g, "").replace(/[*：:]/g, "");
  for (const [key, names] of HEADER_ALIASES) {
    if (names.includes(n)) return key;
  }
  return null;
}

function mapHeaders(cells) {
  const index = { title: -1, owner: -1, status: -1, blockers: -1, quadrant: -1 };
  let known = 0;
  cells.forEach((cell, i) => {
    const key = headerKey(cell);
    if (!key || index[key] !== -1) return;
    index[key] = i;
    known += 1;
  });
  if (!known) return null;
  if (index.title === -1) index.title = 0;
  return index;
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(String(cell).replace(/\s/g, "")));
}

function tasksFromTable(rows) {
  const cleaned = rows
    .map((row) => row.map((cell) => String(cell ?? "").trim()))
    .filter((row) => row.some((cell) => cell !== ""));
  const dataRows = cleaned.filter((row) => !isSeparatorRow(row));
  if (!dataRows.length) return [];
  const mapped = mapHeaders(dataRows[0]);
  const col = mapped || { title: 0, owner: -1, status: -1, blockers: -1, quadrant: -1 };
  const start = mapped ? 1 : 0;
  const out = [];
  for (let i = start; i < dataRows.length; i += 1) {
    const row = dataRows[i];
    const title = (row[col.title] || "").trim();
    if (!title) continue;
    out.push({
      title,
      owner: col.owner >= 0 ? (row[col.owner] || "").trim() : "",
      status: normalizeStatus(col.status >= 0 ? row[col.status] : ""),
      blockers: col.blockers >= 0 ? (row[col.blockers] || "").trim() : "",
      quadrant: quadrantFromText(col.quadrant >= 0 ? row[col.quadrant] : "") || "q3",
    });
  }
  return out;
}

function detectDelimiter(text) {
  const first = text.split(/\r?\n/).find((line) => line.trim()) || "";
  const commas = (first.match(/,/g) || []).length;
  const semis = (first.match(/;/g) || []).length;
  const tabs = (first.match(/\t/g) || []).length;
  if (tabs >= commas && tabs >= semis && tabs > 0) return "\t";
  if (semis > commas) return ";";
  return ",";
}

function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const s = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      if (row.some((item) => item.trim() !== "")) rows.push(row);
      row = [];
      continue;
    }
    cell += c;
  }
  row.push(cell);
  if (row.some((item) => item.trim() !== "")) rows.push(row);
  return rows;
}

function lineToTask(line) {
  let s = String(line || "").trim();
  if (!s) return null;
  if (/^#{1,6}\s+/.test(s)) return null;
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(s)) return null;
  s = s.replace(/^>\s+/, "");
  let status = "";
  const box = s.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/);
  if (box) {
    status = box[1].toLowerCase() === "x" ? "已完成" : "未开始";
    s = box[2].trim();
  } else {
    s = s.replace(/^[-*+]\s+/, "").replace(/^\d+[.)、]\s+/, "");
  }
  s = s.replace(/^[*_`]+|[*_`]+$/g, "").trim();
  if (!s) return null;
  return { title: s, owner: "", status: status || "未开始", blockers: "", quadrant: "q3" };
}

function splitMdRow(line) {
  let s = String(line || "").trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((cell) => cell.trim());
}

function tasksFromMarkdown(body) {
  const lines = body.split(/\r?\n/);
  const out = [];
  let table = [];
  const flush = () => {
    if (!table.length) return;
    out.push(...tasksFromTable(table.map(splitMdRow)));
    table = [];
  };
  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) table.push(line);
    else {
      flush();
      const task = lineToTask(line);
      if (task) out.push(task);
    }
  }
  flush();
  return out;
}

export function parseTaskFile(filename, text) {
  const name = String(filename || "").toLowerCase();
  const body = String(text || "").replace(/^\uFEFF/, "").replace(/\u0000/g, "");
  if (!body.trim()) return [];
  if (name.endsWith(".csv")) return tasksFromTable(parseCsv(body, detectDelimiter(body)));
  if (name.endsWith(".md") || name.endsWith(".markdown")) return tasksFromMarkdown(body);
  return body.split(/\r?\n/).map(lineToTask).filter(Boolean);
}

export function decodeTaskText(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  const cjk = (utf8.match(/[\u3400-\u9fff]/g) || []).length;
  if (bad > 0 && cjk === 0) {
    try {
      const gb = new TextDecoder("gb18030").decode(bytes);
      const gbCjk = (gb.match(/[\u3400-\u9fff]/g) || []).length;
      if (gbCjk > cjk) return gb.replace(/^\uFEFF/, "");
    } catch {
      /* keep utf-8 */
    }
  }
  return utf8.replace(/^\uFEFF/, "");
}

function nameOf(id) {
  return QUADRANTS.find((q) => q.id === id)?.name || "";
}

function cellOf(id) {
  for (let r = 0; r < 2; r += 1) {
    for (let c = 0; c < 2; c += 1) {
      if (GRID[r][c] === id) return [r, c];
    }
  }
  return [0, 0];
}

function gridMove(id, dr, dc) {
  const [r, c] = cellOf(id);
  const nr = r + dr;
  const nc = c + dc;
  if (nr < 0 || nr > 1 || nc < 0 || nc > 1) return null;
  return GRID[nr][nc];
}

function safeId(value) {
  const id = String(value || "");
  if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) return id;
  return crypto.randomUUID();
}

function sanitizeTask(raw) {
  if (!raw || typeof raw !== "object") return null;
  const title = clampText(raw.title, 500).trim();
  if (!title) return null;
  const quadrant = ["q1", "q2", "q3", "q4"].includes(raw.quadrant) ? raw.quadrant : "q3";
  const status = STATUSES.includes(raw.status) ? raw.status : "未开始";
  const order = Number.isFinite(Number(raw.order)) ? Number(raw.order) : 0;
  return {
    id: safeId(raw.id),
    title,
    owner: clampText(raw.owner, 120).trim(),
    status,
    blockers: clampText(raw.blockers, 2000).trim(),
    quadrant,
    order,
  };
}

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : data?.tasks;
    if (!Array.isArray(list)) return [];
    return list.map(sanitizeTask).filter(Boolean).slice(0, 2000);
  } catch {
    return [];
  }
}

function setSaveLabel(text) {
  const el = document.getElementById("save-state");
  if (el) el.textContent = text;
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, tasks }));
    if (!memoryOnly) setSaveLabel("已保存到此浏览器");
  } catch {
    memoryOnly = true;
    setSaveLabel("浏览器拒绝保存，刷新后会丢失");
  }
}

function announce(message) {
  const live = document.getElementById("live");
  if (!live) return;
  live.textContent = "";
  window.setTimeout(() => {
    live.textContent = message;
  }, 30);
}

function toast(message) {
  const host = document.getElementById("toasts");
  if (host) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = message;
    host.append(el);
    window.setTimeout(() => el.remove(), 3600);
  }
  announce(message);
}

function nextOrder(quadrant) {
  const siblings = tasks.filter((task) => task.quadrant === quadrant);
  if (!siblings.length) return 0;
  return Math.max(...siblings.map((task) => task.order)) + 1;
}

function statusKey(status) {
  if (status === "进行中") return "doing";
  if (status === "已完成") return "done";
  return "todo";
}

function cardNode(task) {
  const art = document.createElement("article");
  art.className = `card${task.status === "已完成" ? " is-done" : ""}`;
  art.dataset.id = task.id;
  art.tabIndex = 0;
  art.setAttribute("role", "listitem");
  art.setAttribute("aria-roledescription", "可拖动任务");
  const bits = [task.title, task.status];
  if (task.owner) bits.push(`主责人 ${task.owner}`);
  if (task.blockers) bits.push("有难点");
  art.setAttribute("aria-label", bits.join("，"));
  art.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown ArrowLeft ArrowRight Enter");

  const handle = document.createElement("span");
  handle.className = "handle";
  handle.setAttribute("aria-hidden", "true");
  handle.textContent = "⋮⋮";

  const body = document.createElement("div");
  body.className = "card-body";
  const title = document.createElement("h3");
  title.className = "card-title";
  title.textContent = task.title;
  body.append(title);

  const meta = document.createElement("div");
  meta.className = "meta";
  if (task.owner) {
    const owner = document.createElement("span");
    owner.className = "owner";
    owner.textContent = task.owner;
    meta.append(owner);
  }
  const status = document.createElement("span");
  status.className = `status status-${statusKey(task.status)}`;
  status.textContent = task.status;
  meta.append(status);
  if (task.blockers) {
    const flag = document.createElement("span");
    flag.className = "blocker-flag";
    flag.textContent = "难点";
    meta.append(flag);
  }
  body.append(meta);
  if (task.blockers) {
    const block = document.createElement("p");
    block.className = "card-block";
    block.textContent = `难点：${task.blockers.replace(/\s+/g, " ")}`;
    body.append(block);
  }
  art.append(handle, body);
  return art;
}

function updateCounts() {
  let total = 0;
  for (const q of QUADRANTS) {
    const n = document.querySelectorAll(`#list-${q.id} .card:not(.ghost)`).length;
    total += n;
    const count = document.getElementById(`count-${q.id}`);
    const label = document.getElementById(`count-label-${q.id}`);
    if (count) count.textContent = String(n);
    if (label) label.textContent = `${n} 项`;
  }
  const summary = document.getElementById("summary");
  const q1 = document.getElementById("count-q1")?.textContent || "0";
  if (summary) summary.textContent = total ? `共 ${total} 条 · 紧急重要 ${q1} 条` : "还没有任务";
  const callout = document.getElementById("callout");
  if (callout) callout.hidden = total > 0;
  const clear = document.getElementById("clear-board");
  if (clear) clear.disabled = total === 0;
}

function renderBoard() {
  for (const q of QUADRANTS) {
    const list = document.getElementById(`list-${q.id}`);
    if (!list) continue;
    const items = tasks.filter((task) => task.quadrant === q.id).sort((a, b) => a.order - b.order);
    list.replaceChildren(...items.map(cardNode));
  }
  updateCounts();
  if (openId) syncDetailChrome();
}

function flash(id) {
  const card = document.querySelector(`#matrix .card[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  card.classList.add("is-new");
  card.addEventListener("animationend", () => card.classList.remove("is-new"), { once: true });
  card.scrollIntoView({ block: "nearest" });
}

function addTasks(items) {
  const created = [];
  for (const item of items) {
    const quadrant = ["q1", "q2", "q3", "q4"].includes(item.quadrant) ? item.quadrant : "q3";
    const title = clampText(item.title || "", 500).trim();
    if (!title) continue;
    const task = {
      id: crypto.randomUUID(),
      title,
      owner: clampText(item.owner || "", 120).trim(),
      status: STATUSES.includes(item.status) ? item.status : normalizeStatus(item.status),
      blockers: clampText(item.blockers || "", 2000).trim(),
      quadrant,
      order: nextOrder(quadrant),
    };
    tasks.push(task);
    created.push(task);
  }
  if (!created.length) return 0;
  save();
  renderBoard();
  flash(created[0].id);
  return created.length;
}

function reindex(quadrant) {
  const ids = quadrant ? [quadrant] : QUADRANTS.map((q) => q.id);
  for (const id of ids) {
    tasks
      .filter((task) => task.quadrant === id)
      .sort((a, b) => a.order - b.order)
      .forEach((task, index) => {
        task.order = index;
      });
  }
}

function relocate(id, quadrant, index, options = {}) {
  const task = tasks.find((item) => item.id === id);
  if (!task || !["q1", "q2", "q3", "q4"].includes(quadrant)) return false;
  const prevQ = task.quadrant;
  const current = tasks.filter((item) => item.quadrant === prevQ).sort((a, b) => a.order - b.order);
  const curIdx = current.findIndex((item) => item.id === id);
  task.quadrant = quadrant;
  const siblings = tasks
    .filter((item) => item.quadrant === quadrant && item.id !== id)
    .sort((a, b) => a.order - b.order);
  const clamped = Math.max(0, Math.min(index, siblings.length));
  if (prevQ === quadrant && clamped === curIdx) {
    task.quadrant = prevQ;
    return false;
  }
  siblings.splice(clamped, 0, task);
  siblings.forEach((item, n) => {
    item.order = n;
  });
  if (prevQ !== quadrant) reindex(prevQ);
  save();
  renderBoard();
  if (options.focusCard) {
    document.querySelector(`#list-${quadrant} .card[data-id="${CSS.escape(id)}"]`)?.focus();
  }
  return true;
}

function moveAndAnnounce(id, quadrant, index) {
  const moved = relocate(id, quadrant, index, { focusCard: true });
  if (!moved) return;
  const task = tasks.find((item) => item.id === id);
  if (!task) return;
  announce(`已将「${task.title}」放到${nameOf(task.quadrant)}，第 ${task.order + 1} 位`);
}

function syncDetailChrome() {
  const task = tasks.find((item) => item.id === openId);
  if (!task) return;
  const kicker = document.getElementById("detail-kicker");
  if (kicker) kicker.textContent = `当前在${nameOf(task.quadrant)}`;
  document.querySelectorAll("[data-move]").forEach((btn) => {
    btn.setAttribute("aria-pressed", btn.dataset.move === task.quadrant ? "true" : "false");
  });
  const siblings = tasks.filter((item) => item.quadrant === task.quadrant).sort((a, b) => a.order - b.order);
  const index = siblings.findIndex((item) => item.id === task.id);
  const up = document.getElementById("nudge-up");
  const down = document.getElementById("nudge-down");
  if (up) up.disabled = index <= 0;
  if (down) down.disabled = index < 0 || index >= siblings.length - 1;
}

function updateTask(id, patch) {
  const task = tasks.find((item) => item.id === id);
  if (!task) return;
  if ("title" in patch) {
    const title = clampText(patch.title, 500).trim();
    if (title) task.title = title;
  }
  if ("owner" in patch) task.owner = clampText(patch.owner, 120).trim();
  if ("status" in patch && STATUSES.includes(patch.status)) task.status = patch.status;
  if ("blockers" in patch) task.blockers = clampText(patch.blockers, 2000).trim();
  save();
  const card = document.querySelector(`#matrix .card[data-id="${CSS.escape(id)}"]`);
  if (card) card.replaceWith(cardNode(task));
  updateCounts();
}

let filling = false;

function openDetail(id) {
  const task = tasks.find((item) => item.id === id);
  const dialog = document.getElementById("detail");
  if (!task || !dialog) return;
  openId = id;
  filling = true;
  document.getElementById("field-title").value = task.title;
  document.getElementById("field-owner").value = task.owner;
  document.getElementById("field-status").value = task.status;
  document.getElementById("field-blockers").value = task.blockers;
  filling = false;
  syncDetailChrome();
  if (!dialog.open) dialog.showModal();
  document.getElementById("field-owner").focus();
}

function bindInstant(id, key) {
  const el = document.getElementById(id);
  el.addEventListener("input", () => {
    if (filling || !openId) return;
    if (key === "title" && !el.value.trim()) return;
    const value = key === "blockers" ? el.value : el.value;
    updateTask(openId, { [key]: value });
  });
  el.addEventListener("blur", () => {
    if (!openId) return;
    if (key === "title" && !el.value.trim()) {
      const task = tasks.find((item) => item.id === openId);
      if (task) el.value = task.title;
      return;
    }
    el.value = el.value.trim();
    updateTask(openId, { [key]: el.value });
  });
}

function persistFromDom(activeId) {
  const before = new Map(tasks.map((task) => [task.id, `${task.quadrant}:${task.order}`]));
  for (const q of QUADRANTS) {
    document.querySelectorAll(`#list-${q.id} .card:not(.ghost)`).forEach((card, index) => {
      const task = tasks.find((item) => item.id === card.dataset.id);
      if (!task) return;
      task.quadrant = q.id;
      task.order = index;
    });
  }
  save();
  updateCounts();
  const task = tasks.find((item) => item.id === activeId);
  if (task && before.get(activeId) !== `${task.quadrant}:${task.order}`) {
    announce(`已将「${task.title}」放到${nameOf(task.quadrant)}，第 ${task.order + 1} 位`);
  }
}

function cleanupPointer() {
  if (pointer?.card) {
    pointer.card.hidden = false;
    pointer.card.classList.remove("is-dragging");
  }
  pointer?.placeholder?.remove();
  pointer?.ghost?.remove();
  document.querySelectorAll(".quad.is-over").forEach((el) => el.classList.remove("is-over"));
  document.body.classList.remove("is-dragging-task");
  pointer = null;
}

function cancelDrag() {
  if (pointer?.dragging && pointer.originParent) {
    pointer.originParent.insertBefore(pointer.card, pointer.originNext);
  }
  cleanupPointer();
  updateCounts();
}

function startDrag(event) {
  pointer.dragging = true;
  const card = pointer.card;
  const rect = card.getBoundingClientRect();
  pointer.originParent = card.parentElement;
  pointer.originNext = card.nextSibling;
  const placeholder = document.createElement("div");
  placeholder.className = "placeholder";
  placeholder.style.height = `${Math.max(rect.height, 52)}px`;
  card.after(placeholder);
  pointer.placeholder = placeholder;
  card.classList.add("is-dragging");
  card.hidden = true;
  const ghost = card.cloneNode(true);
  ghost.hidden = false;
  ghost.classList.add("ghost");
  ghost.classList.remove("is-dragging");
  ghost.setAttribute("aria-hidden", "true");
  ghost.removeAttribute("tabindex");
  ghost.style.width = `${rect.width}px`;
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  document.body.append(ghost);
  pointer.ghost = ghost;
  pointer.offX = event.clientX - rect.left;
  pointer.offY = event.clientY - rect.top;
  document.body.classList.add("is-dragging-task");
  try {
    card.setPointerCapture(event.pointerId);
  } catch {
    /* pointer may already be released */
  }
}

function placeCardAtPoint(x, y) {
  const ghost = pointer?.ghost;
  if (ghost) ghost.style.visibility = "hidden";
  const el = document.elementFromPoint(x, y);
  if (ghost) ghost.style.visibility = "";
  const quad = el?.closest?.(".quad");
  if (!quad || !pointer?.placeholder) return;
  document.querySelectorAll(".quad.is-over").forEach((node) => node.classList.remove("is-over"));
  quad.classList.add("is-over");
  const list = quad.querySelector(".list");
  const cards = [...list.querySelectorAll(".card")].filter((card) => card !== pointer.card && !card.hidden);
  let before = null;
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) {
      before = card;
      break;
    }
  }
  if (before) list.insertBefore(pointer.placeholder, before);
  else list.append(pointer.placeholder);
  pointer.placeholder.before(pointer.card);
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  const card = event.target.closest?.(".card");
  if (!card || card.classList.contains("ghost")) return;
  if (event.target.closest("a, button, input, textarea, select, label")) return;
  if (event.pointerType === "touch" && !event.target.closest(".handle")) {
    tap = { id: event.pointerId, x: event.clientX, y: event.clientY, cardId: card.dataset.id };
    return;
  }
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, card, dragging: false };
}

function onPointerMove(event) {
  if (!pointer || event.pointerId !== pointer.id) return;
  const dx = event.clientX - pointer.x;
  const dy = event.clientY - pointer.y;
  if (!pointer.dragging) {
    if (dx * dx + dy * dy < 36) return;
    startDrag(event);
  }
  event.preventDefault();
  if (pointer.ghost) {
    pointer.ghost.style.left = `${event.clientX - pointer.offX}px`;
    pointer.ghost.style.top = `${event.clientY - pointer.offY}px`;
  }
  placeCardAtPoint(event.clientX, event.clientY);
  updateCounts();
  const edge = 72;
  if (event.clientY < edge) window.scrollBy(0, -12);
  else if (event.clientY > window.innerHeight - edge) window.scrollBy(0, 12);
}

function onPointerUp(event) {
  if (tap && event.pointerId === tap.id) {
    const dx = event.clientX - tap.x;
    const dy = event.clientY - tap.y;
    const id = tap.cardId;
    tap = null;
    if (dx * dx + dy * dy < 36) openDetail(id);
    return;
  }
  if (!pointer || event.pointerId !== pointer.id) return;
  const wasDrag = pointer.dragging;
  const id = pointer.card.dataset.id;
  if (wasDrag) {
    pointer.card.hidden = false;
    pointer.placeholder?.remove();
    pointer.placeholder = null;
    persistFromDom(id);
  }
  cleanupPointer();
  if (!wasDrag) openDetail(id);
}

function onKeyDown(event) {
  if (pointer?.dragging) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelDrag();
    }
    return;
  }
  const card = event.target.closest?.(".card");
  if (!card || card.classList.contains("ghost")) return;
  if (event.altKey || event.metaKey || event.ctrlKey) return;
  const id = card.dataset.id;
  const task = tasks.find((item) => item.id === id);
  if (!task) return;
  const siblings = tasks.filter((item) => item.quadrant === task.quadrant).sort((a, b) => a.order - b.order);
  const index = siblings.findIndex((item) => item.id === id);
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (index > 0) moveAndAnnounce(id, task.quadrant, index - 1);
    else {
      const dest = gridMove(task.quadrant, -1, 0);
      if (dest) moveAndAnnounce(id, dest, 9999);
    }
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    if (index < siblings.length - 1) moveAndAnnounce(id, task.quadrant, index + 1);
    else {
      const dest = gridMove(task.quadrant, 1, 0);
      if (dest) moveAndAnnounce(id, dest, 0);
    }
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    const dest = gridMove(task.quadrant, 0, -1);
    if (dest) moveAndAnnounce(id, dest, index);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    const dest = gridMove(task.quadrant, 0, 1);
    if (dest) moveAndAnnounce(id, dest, index);
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openDetail(id);
  }
}

function hasFiles(event) {
  return [...(event.dataTransfer?.types || [])].includes("Files");
}

async function readFile(file) {
  const buffer = await file.arrayBuffer();
  return decodeTaskText(buffer);
}

async function importFiles(fileList) {
  const files = [...fileList];
  let parsed = [];
  let skipped = 0;
  let truncated = false;
  for (const file of files) {
    if (!/\.(txt|csv|md|markdown)$/i.test(file.name)) {
      skipped += 1;
      continue;
    }
    if (file.size > 1_000_000) {
      toast(`「${file.name}」超过 1MB，未导入`);
      continue;
    }
    try {
      const text = await readFile(file);
      parsed.push(...parseTaskFile(file.name, text));
    } catch {
      toast(`无法读取「${file.name}」`);
    }
  }
  if (parsed.length > 500) {
    parsed = parsed.slice(0, 500);
    truncated = true;
  }
  if (!parsed.length) {
    toast(skipped ? "请上传 txt、csv 或 md 文件" : "没有识别到任务。请确认一行一条，或 CSV 含有表头。");
    return;
  }
  const count = addTasks(parsed);
  let message = `已导入 ${count} 条。未填写象限的任务放在「重要不紧急」，可以再拖动。`;
  if (truncated) message += " 已只取前 500 条。";
  if (skipped) message += ` 已跳过 ${skipped} 个不支持的文件。`;
  toast(message);
}

function askConfirm({ title, body, confirmLabel }) {
  const dialog = document.getElementById("confirm");
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-body").textContent = body;
  document.getElementById("confirm-yes").textContent = confirmLabel;
  return new Promise((resolve) => {
    confirmResolver = resolve;
    dialog.showModal();
  });
}

function settleConfirm(value) {
  const resolve = confirmResolver;
  confirmResolver = null;
  const dialog = document.getElementById("confirm");
  if (dialog.open) dialog.close();
  if (resolve) resolve(value);
}

function loadSamples() {
  let added = 0;
  for (const sample of SAMPLES) {
    if (tasks.some((task) => task.id === sample.id)) continue;
    tasks.push({ ...sample, order: nextOrder(sample.quadrant) });
    added += 1;
  }
  if (!added) {
    toast("示例任务已经在看板上");
    return;
  }
  save();
  renderBoard();
  toast(`已放入 ${added} 条示例任务，可以直接拖动`);
}

function bindChrome() {
  document.getElementById("add-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.getElementById("new-title");
    const title = input.value.trim();
    if (!title) {
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }
    input.removeAttribute("aria-invalid");
    const count = addTasks([{ title, owner: "", status: "未开始", blockers: "", quadrant: "q1" }]);
    if (!count) return;
    input.value = "";
    announce(`已添加「${title}」到紧急重要`);
  });
  document.getElementById("new-title").addEventListener("input", (event) => {
    event.currentTarget.removeAttribute("aria-invalid");
  });

  const fileInput = document.getElementById("file-input");
  fileInput.addEventListener("change", () => {
    if (fileInput.files?.length) importFiles(fileInput.files);
    fileInput.value = "";
  });

  document.getElementById("load-sample").addEventListener("click", loadSamples);
  document.getElementById("clear-board").addEventListener("click", async () => {
    if (!tasks.length) return;
    const ok = await askConfirm({
      title: "清空看板",
      body: "这台浏览器里保存的任务、象限和详情都会删除。",
      confirmLabel: "确认清空",
    });
    if (!ok) return;
    tasks = [];
    openId = null;
    const detail = document.getElementById("detail");
    if (detail.open) detail.close();
    save();
    renderBoard();
    toast("看板已清空");
  });

  document.getElementById("confirm-yes").addEventListener("click", () => settleConfirm(true));
  document.getElementById("confirm-no").addEventListener("click", () => settleConfirm(false));
  document.getElementById("confirm").addEventListener("close", () => {
    if (!confirmResolver) return;
    const resolve = confirmResolver;
    confirmResolver = null;
    resolve(false);
  });
  document.getElementById("confirm").addEventListener("click", (event) => {
    if (event.target.id === "confirm") settleConfirm(false);
  });

  const detail = document.getElementById("detail");
  detail.addEventListener("close", () => {
    openId = null;
  });
  detail.addEventListener("click", (event) => {
    if (event.target.id === "detail") detail.close();
  });
  document.getElementById("detail-form").addEventListener("submit", (event) => event.preventDefault());
  document.getElementById("close-detail").addEventListener("click", () => detail.close());
  bindInstant("field-title", "title");
  bindInstant("field-owner", "owner");
  bindInstant("field-blockers", "blockers");
  document.getElementById("field-status").addEventListener("change", (event) => {
    if (filling || !openId) return;
    updateTask(openId, { status: event.target.value });
  });
  document.querySelectorAll("[data-move]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!openId) return;
      const task = tasks.find((item) => item.id === openId);
      if (!task || task.quadrant === btn.dataset.move) return;
      const index = tasks.filter((item) => item.quadrant === btn.dataset.move).length;
      relocate(openId, btn.dataset.move, index);
      announce(`已将「${task.title}」放到${nameOf(btn.dataset.move)}`);
    });
  });
  document.getElementById("nudge-up").addEventListener("click", () => {
    if (!openId) return;
    const task = tasks.find((item) => item.id === openId);
    const siblings = tasks.filter((item) => item.quadrant === task.quadrant).sort((a, b) => a.order - b.order);
    const index = siblings.findIndex((item) => item.id === task.id);
    if (index > 0) relocate(openId, task.quadrant, index - 1);
  });
  document.getElementById("nudge-down").addEventListener("click", () => {
    if (!openId) return;
    const task = tasks.find((item) => item.id === openId);
    const siblings = tasks.filter((item) => item.quadrant === task.quadrant).sort((a, b) => a.order - b.order);
    const index = siblings.findIndex((item) => item.id === task.id);
    if (index >= 0 && index < siblings.length - 1) relocate(openId, task.quadrant, index + 1);
  });
  document.getElementById("delete-task").addEventListener("click", async () => {
    const task = tasks.find((item) => item.id === openId);
    if (!task) return;
    const ok = await askConfirm({
      title: "删除这条任务",
      body: `「${task.title}」会从看板移除。`,
      confirmLabel: "删除",
    });
    if (!ok || !tasks.some((item) => item.id === task.id)) return;
    tasks = tasks.filter((item) => item.id !== task.id);
    reindex();
    openId = null;
    if (detail.open) detail.close();
    save();
    renderBoard();
    toast("已删除任务");
  });

  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointermove", onPointerMove, { passive: false });
  document.addEventListener("pointerup", onPointerUp);
  document.addEventListener("pointercancel", () => {
    if (pointer?.dragging) cancelDrag();
    else cleanupPointer();
    tap = null;
  });
  document.addEventListener("keydown", onKeyDown);

  window.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    fileDragDepth += 1;
    document.body.classList.add("is-file-hover");
  });
  window.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
  });
  window.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) return;
    fileDragDepth -= 1;
    if (fileDragDepth <= 0) {
      fileDragDepth = 0;
      document.body.classList.remove("is-file-hover");
    }
  });
  window.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    fileDragDepth = 0;
    document.body.classList.remove("is-file-hover");
    if (event.dataTransfer?.files?.length) importFiles(event.dataTransfer.files);
  });
}

function init() {
  tasks = loadTasks();
  bindChrome();
  renderBoard();
  if (tasks.length) setSaveLabel("已从本机恢复");
}

if (typeof document !== "undefined") init();

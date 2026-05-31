// 简单单页 SPA:列表 + 详情,键盘快捷键,字段编辑高亮。

// HTML 转义:image_filename 等来自 DB 的字段插入 innerHTML 前必须转义,防存储型 XSS
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const FIELD_DEFS = [
  { key: "colour",            label: "颜色 (colour)",    dropdown: true },
  { key: "defects",           label: "瑕疵 (defects)",   dropdown: true },
  { key: "object_type",       label: "器型 (object_type)", dropdown: true },
  { key: "subtype_carving",   label: "雕刻子类",         dropdown: true },
  { key: "subtype_jewelry",   label: "首饰子类",         dropdown: true },
  { key: "subtype_ritual",    label: "礼器子类",         dropdown: true },
  { key: "texture",           label: "纹理 (texture)",   dropdown: true },
  { key: "transparency",      label: "透明度",           dropdown: true },
  { key: "annotator",         label: "原标注员",         dropdown: true },
  { key: "lead_time",         label: "用时(秒)",        readonly: true },
  { key: "created_at",        label: "创建时间",         readonly: true },
];

const state = {
  items: [],
  index: -1,
  filter: "all",
  edits: {},
  reviewer: "anonymous",
  options: {},
};

function collectOptions(items) {
  const opts = {};
  FIELD_DEFS.filter(f => f.dropdown).forEach(f => {
    const set = new Set();
    items.forEach(it => {
      const v = ((it.payload || {})[f.key] || "").trim();
      if (v) set.add(v);
    });
    opts[f.key] = Array.from(set).sort();
  });
  return opts;
}

const $ = (sel) => document.querySelector(sel);

async function loadList() {
  const r = await fetch("/api/list");
  const data = await r.json();
  state.items = data.items;
  state.reviewer = data.reviewer || "anonymous";
  state.options = collectOptions(state.items);
  $("#reviewer").textContent = state.reviewer;
  renderList();
  if (state.items.length && state.index < 0) {
    selectIndex(firstVisibleIndex());
  }
}

function statusKey(s) {
  return s || "todo";
}

function statusSym(s) {
  return { pass: "✓", fail: "✗", doubt: "?", todo: "·" }[statusKey(s)] || "·";
}

function statusLabel(s) {
  return { pass: "通过", fail: "不通过", doubt: "存疑", todo: "未审" }[statusKey(s)] || "未审";
}

function passesFilter(item) {
  const f = state.filter;
  const s = statusKey(item.status);
  if (f === "all") return true;
  if (f === "todo") return s === "todo";
  return s === f;
}

function firstVisibleIndex() {
  for (let i = 0; i < state.items.length; i++) if (passesFilter(state.items[i])) return i;
  return -1;
}

function renderList() {
  const ul = $("#list");
  ul.innerHTML = "";
  let visible = 0, done = 0;
  state.items.forEach((it, idx) => {
    if (statusKey(it.status) !== "todo") done++;
    if (!passesFilter(it)) return;
    visible++;
    const li = document.createElement("li");
    li.dataset.idx = idx;
    if (idx === state.index) li.classList.add("active");
    const s = statusKey(it.status);
    li.innerHTML = `
      <span class="st ${s}">${statusSym(it.status)}</span>
      <span class="id">#${esc(it.annotation_id)}</span>
      <span class="fn" title="${esc(it.image_filename)}">${esc(it.image_filename)}</span>
    `;
    li.addEventListener("click", () => selectIndex(idx));
    ul.appendChild(li);
  });
  $("#progress").textContent = `${done} / ${state.items.length}`;
}

async function selectIndex(idx) {
  if (idx < 0 || idx >= state.items.length) return;
  state.index = idx;
  state.edits = {};
  renderList();
  const it = state.items[idx];
  // 拉详情(拿最新 review 的 edits/note)
  const r = await fetch(`/api/item/${it.annotation_id}`);
  const detail = await r.json();
  renderDetail(detail);
}

function renderDetail(detail) {
  $("#empty").classList.add("hidden");
  $("#detail").classList.remove("hidden");
  $("#d-id").textContent = detail.annotation_id;
  $("#d-filename").textContent = detail.image_filename;
  const status = detail.latest_review ? detail.latest_review.status : null;
  const badge = $("#d-status");
  badge.className = "badge " + (status || "");
  badge.textContent = statusLabel(status);
  $("#d-img").src = `/img/${encodeURIComponent(detail.image_filename)}`;
  $("#d-img").onerror = () => {
    $("#d-img").alt = `图片读不到: ${detail.image_filename}`;
  };

  // 字段
  const baseEdits = detail.latest_review ? detail.latest_review.edits || {} : {};
  const fields = $("#fields");
  fields.innerHTML = "";
  FIELD_DEFS.forEach((f) => {
    const { key, label, dropdown, readonly } = f;
    const row = document.createElement("div");
    row.className = "field-row";
    if (readonly) row.classList.add("readonly");
    const orig = detail.payload[key] ?? "";
    const current = key in baseEdits ? baseEdits[key] : orig;
    if (key in baseEdits) row.classList.add("edited");
    let inputHtml;
    if (dropdown && !readonly) {
      const listId = `dl-${key}`;
      const opts = (state.options[key] || []).map(o => `<option value="${escapeAttr(o)}">`).join("");
      inputHtml = `<input list="${listId}" data-key="${key}" data-orig="${escapeAttr(orig)}" value="${escapeAttr(current)}">
                   <datalist id="${listId}">${opts}</datalist>`;
    } else {
      inputHtml = `<input type="text" data-key="${key}" data-orig="${escapeAttr(orig)}" value="${escapeAttr(current)}" ${readonly?"readonly":""}>`;
    }
    row.innerHTML = `<label>${label}</label>${inputHtml}`;
    const input = row.querySelector("input");
    input.addEventListener("input", () => {
      const o = input.dataset.orig;
      if (input.value !== o) {
        row.classList.add("edited");
        state.edits[key] = input.value;
      } else {
        row.classList.remove("edited");
        delete state.edits[key];
      }
    });
    fields.appendChild(row);
  });
  // 把已有 edits 灌进 state(便于保存时一次提交)
  Object.assign(state.edits, baseEdits);
  $("#note").value = detail.latest_review ? (detail.latest_review.note || "") : "";

  const meta = document.createElement("div");
  meta.className = "field-meta";
  if (detail.latest_review) {
    meta.textContent = `上次核对: ${detail.latest_review.reviewer} · ${detail.latest_review.reviewed_at}`;
  } else {
    meta.textContent = "尚未核对";
  }
  fields.appendChild(meta);
}

function escapeAttr(s) {
  return String(s ?? "").replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;");
}

async function saveReview(status) {
  if (state.index < 0) return;
  const it = state.items[state.index];
  const payload = {
    annotation_id: it.annotation_id,
    reviewer: state.reviewer,
    status,
    note: $("#note").value,
    edits: state.edits,
  };
  const r = await fetch("/api/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) {
    alert("保存失败: " + (data.error || r.status));
    return;
  }
  // 更新本地状态
  it.status = status;
  it.reviewer = state.reviewer;
  renderList();
  // 自动跳下一条(同 filter 下)
  const next = nextVisibleIndex(state.index);
  if (next >= 0) selectIndex(next);
}

function nextVisibleIndex(from) {
  for (let i = from + 1; i < state.items.length; i++) if (passesFilter(state.items[i])) return i;
  return -1;
}

function prevVisibleIndex(from) {
  for (let i = from - 1; i >= 0; i--) if (passesFilter(state.items[i])) return i;
  return -1;
}

// 事件绑定
document.addEventListener("DOMContentLoaded", () => {
  $("#filter").addEventListener("change", (e) => {
    state.filter = e.target.value;
    renderList();
    if (state.index < 0 || !passesFilter(state.items[state.index])) {
      const i = firstVisibleIndex();
      if (i >= 0) selectIndex(i);
    }
  });

  $("#prev-btn").addEventListener("click", () => {
    const i = prevVisibleIndex(state.index);
    if (i >= 0) selectIndex(i);
  });
  $("#next-btn").addEventListener("click", () => {
    const i = nextVisibleIndex(state.index);
    if (i >= 0) selectIndex(i);
  });

  document.querySelectorAll("[data-status]").forEach((btn) => {
    btn.addEventListener("click", () => saveReview(btn.dataset.status));
  });

  $("#d-img").addEventListener("click", () => {
    const src = $("#d-img").src;
    if (!src) return;
    $("#lb-img").src = src;
    $("#lightbox").classList.remove("hidden");
  });
  $("#lightbox").addEventListener("click", () => {
    $("#lightbox").classList.add("hidden");
  });

  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") {
      if (e.key === "Enter" && tag === "input" && e.target.id === "note") {
        e.preventDefault();
        saveReview("pass");
      }
      return;
    }
    if (e.key === "j" || e.key === "J" || e.key === "ArrowDown") {
      e.preventDefault();
      const i = nextVisibleIndex(state.index);
      if (i >= 0) selectIndex(i);
    } else if (e.key === "k" || e.key === "K" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = prevVisibleIndex(state.index);
      if (i >= 0) selectIndex(i);
    } else if (e.key === "1") {
      saveReview("pass");
    } else if (e.key === "2") {
      saveReview("fail");
    } else if (e.key === "3") {
      saveReview("doubt");
    }
  });

  loadList();
});

// ==UserScript==
// @name         AdMob Batch Creator
// @namespace    local.admob-batch-creator
// @version      0.1.0
// @description  中文 AdMob 广告单元批量创建、手动 USD 底价、核验与导出；未知页面阻止提交
// @match        https://apps.admob.com/*
// @run-at       document-idle
// @noframes
// @sandbox      DOM
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_openInTab
// @grant        GM_setClipboard
// @grant        GM_getTab
// @grant        GM_saveTab
// ==/UserScript==

"use strict";
(() => {
  // src/types.ts
  var STATUS_ZH = { pending: "待执行", filling: "填表中", submitting: "提交中", verifying: "核验中", success: "成功", failed: "明确失败", uncertain: "结果不确定", "created-unverified": "已创建但配置待核验", exists: "已存在", conflict: "冲突", stopped: "已停止" };
  var FORMAT_ZH = { interstitial: "插页式", "app-open": "开屏" };

  // src/core.ts
  function normalizeDecimal(value) {
    const input = String(value).trim();
    if (!/^[0-9]+(?:\.[0-9]+)?$/.test(input)) {
      throw new Error("底价须为非负十进制数字；不要包含货币符号、千分位、指数或逗号小数点");
    }
    const [whole, fraction = ""] = input.split(".");
    const integer = whole.replace(/^0+(?=\d)/, "");
    const digits = fraction.replace(/0+$/, "");
    return digits ? `${integer}.${digits}` : integer;
  }
  function decimalEqual(left, right) {
    try {
      return normalizeDecimal(left) === normalizeDecimal(right);
    } catch {
      return false;
    }
  }
  var MAX_NAME_LENGTH = 80;
  function detectDelimiter(text) {
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === '"') {
        if (quoted && text[index + 1] === '"') index += 1;
        else quoted = !quoted;
      } else if (!quoted && char === "	") return "	";
      else if (!quoted && (char === "\r" || char === "\n")) {
        if (text.slice(0, index).trim()) break;
      }
    }
    return ",";
  }
  function readRecords(text, delimiter) {
    const records = [];
    let field = "", fields = [], errors = [];
    let quoted = false, closed = false, line = 1, recordLine = 1;
    const finish = () => {
      fields.push(field);
      if (fields.some((v) => v.trim() !== "") || errors.length) records.push({ line: recordLine, fields, errors });
      field = "";
      fields = [];
      errors = [];
      closed = false;
    };
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (char === '"') {
          if (text[index + 1] === '"') {
            field += '"';
            index += 1;
          } else {
            quoted = false;
            closed = true;
          }
        } else if (char === "\r" || char === "\n") {
          if (char === "\r" && text[index + 1] === "\n") index += 1;
          field += "\n";
          line += 1;
        } else field += char;
        continue;
      }
      if (char === delimiter) {
        fields.push(field);
        field = "";
        closed = false;
      } else if (char === "\r" || char === "\n") {
        if (char === "\r" && text[index + 1] === "\n") index += 1;
        finish();
        line += 1;
        recordLine = line;
      } else if (char === '"') {
        if (field === "" && !closed) quoted = true;
        else {
          errors.push("引号位置无效；含分隔符的字段请用双引号包围");
          field += char;
        }
      } else if (closed) {
        errors.push("闭合引号后出现多余字符");
        field += char;
      } else field += char;
    }
    if (quoted) errors.push("字段双引号未闭合");
    finish();
    return records;
  }
  function parseInput(text, options = {}) {
    const maxNameLength = Math.min(MAX_NAME_LENGTH, options.maxNameLength ?? MAX_NAME_LENGTH);
    if (!Number.isInteger(maxNameLength) || maxNameLength < 1) throw new Error("名称长度限制无效");
    const cleaned = text.replace(/^\uFEFF/, "");
    const records = readRecords(cleaned, detectDelimiter(cleaned));
    const headerName = /^(广告位名称|广告单元名称|名称|ad\s*unit\s*name)$/i;
    const headerFloor = /^(底价|底价usd|底价[（(]usd\s*[/／]\s*千次展示[）)]|floor(?:\s*usd)?)$/i;
    if (records[0]?.fields.length === 2 && headerName.test(records[0].fields[0].trim()) && headerFloor.test(records[0].fields[1].trim()) && !records[0].errors.length) records.shift();
    const rows = records.map((record) => {
      const [name = "", rawFloor = ""] = record.fields;
      const errors = [...new Set(record.errors)];
      if (record.fields.length !== 2) errors.push(`应为两列，实际为 ${record.fields.length} 列`);
      if (!name.trim()) errors.push("广告位名称不能为空");
      if (name !== name.trim()) errors.push("名称前后存在空白，请明确修正");
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(name)) errors.push("名称包含不支持的控制字符");
      if (name.length > maxNameLength) errors.push(`名称超过限制 ${maxNameLength} 个字符，未截断`);
      let floor = rawFloor;
      if (!rawFloor.trim()) errors.push("缺失底价");
      else {
        try {
          floor = normalizeDecimal(rawFloor);
        } catch (error) {
          errors.push(error.message);
        }
      }
      return { line: record.line, name, floor, errors };
    });
    const occurrences = /* @__PURE__ */ new Map();
    for (const row of rows) if (row.name) occurrences.set(row.name, (occurrences.get(row.name) ?? 0) + 1);
    for (const row of rows) if ((occurrences.get(row.name) ?? 0) > 1) row.errors.push("输入清单中存在重复名称，请逐行处理");
    return rows;
  }
  function classifyLookup(lookup, identity, format, name, floor) {
    if (!lookup.complete) return { status: "uncertain", reason: lookup.reason || "已有广告位读取不完整，不能判定不存在" };
    const matches = lookup.matches.filter((match) => match.name === name);
    if (matches.length === 0) return { status: "pending", reason: "已完整检查，未发现同名广告位" };
    if (matches.length > 1) return { status: "uncertain", reason: "存在多个同名广告位，需人工核验" };
    const actual = matches[0];
    if (actual.publisherId !== identity.publisherId || actual.appId !== identity.appId) return { status: "uncertain", reason: "同名结果所属发布商或应用无法确认", actual };
    if (!actual.unitId || !/^ca-app-pub-\d{16}\/\d{10}$/.test(actual.unitId) || !actual.unitId.startsWith(`ca-app-${identity.publisherId}/`)) return { status: "uncertain", reason: "未获得可核对的真实广告位 ID", actual };
    if (actual.format && actual.format !== format) return { status: "conflict", reason: "同名广告位的广告格式不同", actual };
    if (actual.mode && actual.mode !== "manual") return { status: "conflict", reason: "同名广告位不是手动底价模式", actual };
    if (actual.currency && actual.currency !== "USD") return { status: "conflict", reason: "同名广告位底价币种不是 USD", actual };
    if (actual.floor !== void 0 && !decimalEqual(actual.floor, floor)) return { status: "conflict", reason: "同名广告位底价金额不同或无法解释", actual };
    if (!actual.verified || actual.format !== format || actual.mode !== "manual" || actual.currency !== "USD" || actual.floor === void 0) return { status: "uncertain", reason: "同名广告位配置未完整核验", actual };
    return { status: "exists", reason: "已有同名、同格式、同手动美元底价广告位，跳过创建", actual };
  }
  var ALLOWED = {
    pending: ["filling", "exists", "conflict", "uncertain", "failed", "stopped"],
    filling: ["submitting", "pending", "failed", "stopped", "uncertain", "exists", "conflict"],
    submitting: ["verifying", "uncertain", "created-unverified"],
    verifying: ["success", "exists", "uncertain", "created-unverified", "conflict"],
    success: [],
    exists: [],
    conflict: ["verifying"],
    failed: ["pending", "stopped", "verifying"],
    uncertain: ["verifying", "created-unverified", "failed"],
    "created-unverified": ["verifying"],
    stopped: ["pending", "verifying"]
  };
  var FINAL = /* @__PURE__ */ new Set(["success", "failed", "created-unverified", "exists", "conflict", "stopped", "uncertain"]);
  function transition(task, status, reason = "") {
    if (task.status !== status && !ALLOWED[task.status].includes(status)) throw new Error(`不允许的任务状态转换：${task.status} → ${status}`);
    if (task.intentAt && ["pending", "filling", "failed", "stopped"].includes(status)) throw new Error("已有提交意图，必须核验，不能重新创建或断言失败");
    if (status === "submitting" && (!task.assignmentId || !task.workerId || !task.intentAt)) throw new Error("提交前必须持久化提交意图与任务归属");
    if (status === "success") {
      const actual = task.actual;
      if (!actual?.verified || !actual.unitId || !/^ca-app-pub-\d{16}\/\d{10}$/.test(actual.unitId) || !actual.publisherId || !actual.appId || !actual.unitId.startsWith(`ca-app-${actual.publisherId}/`) || !actual.appId.startsWith(`ca-app-${actual.publisherId}~`) || actual.name !== task.name || !actual.format || actual.mode !== "manual" || actual.currency !== "USD" || actual.floor === void 0 || !decimalEqual(actual.floor, task.floor)) {
        throw new Error("实际保存配置与广告位 ID 尚未完整核验，不能标记成功");
      }
    }
    task.status = status;
    task.reason = reason;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    task.logs.push({ at: now, step: status, message: reason });
    if (FINAL.has(status)) task.finishedAt = now;
    else delete task.finishedAt;
    return task;
  }
  function recoverTask(task) {
    if (task.intentAt && !["success", "exists", "created-unverified", "conflict"].includes(task.status)) {
      task.status = task.actual?.unitId ? "created-unverified" : "uncertain";
      task.reason = "检测到历史提交意图，先核验平台真实结果，禁止重新提交";
    } else if (task.status === "submitting" || task.status === "verifying") {
      task.status = task.actual?.unitId ? "created-unverified" : "uncertain";
      task.reason = "中断时处于提交或核验阶段，结果待核验";
    } else if (task.status === "filling") {
      task.status = "failed";
      task.reason = "填表阶段中断，尚无提交意图；可由用户重试";
    }
    return task;
  }
  function newId() {
    return globalThis.crypto.randomUUID();
  }
  function createBatch(rows, identity, format, concurrency, execution, sourceUrl, controllerId) {
    if (!Array.isArray(rows) || !rows.length) throw new Error("请输入至少一条广告位");
    const names = /* @__PURE__ */ new Set();
    for (const row of rows) {
      if (!row || !Array.isArray(row.errors) || row.errors.length) throw new Error("输入存在行级错误，请先修正");
      if (typeof row.name !== "string" || !row.name.trim() || row.name !== row.name.trim() || row.name.length > MAX_NAME_LENGTH || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(row.name)) throw new Error(`第 ${row.line} 行广告位名称无效或超过 ${MAX_NAME_LENGTH} 个字符`);
      if (!Number.isSafeInteger(row.line) || row.line < 1) throw new Error("输入原始行号无效");
      if (names.has(row.name)) throw new Error(`输入包含重复广告位名称：${row.name}`);
      names.add(row.name);
      if (typeof row.floor !== "string") throw new Error(`第 ${row.line} 行底价须为十进制字符串`);
      normalizeDecimal(row.floor);
    }
    if (!/^pub-\d{16}$/.test(identity.publisherId) || !/^ca-app-pub-\d{16}~\d{10}$/.test(identity.appId) || !identity.appId.startsWith(`ca-app-${identity.publisherId}~`)) throw new Error("发布商 ID 或应用 ID 无效或不匹配");
    if (![1, 2, 3].includes(concurrency)) throw new Error("并发数必须为 1、2 或 3");
    if (!["interstitial", "app-open"].includes(format)) throw new Error("不支持的广告格式");
    if (!["tabs", "single"].includes(execution)) throw new Error("不支持的执行模式");
    if (typeof controllerId !== "string" || !controllerId.trim()) throw new Error("主控标识不能为空");
    return {
      schema: 1,
      id: newId(),
      identity: structuredClone(identity),
      format,
      mode: "manual",
      currency: "USD",
      concurrency: execution === "single" ? 1 : concurrency,
      execution,
      sourceUrl,
      phase: "draft",
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      canaryPassed: false,
      controllerId,
      tasks: rows.map((row) => ({ id: newId(), line: row.line, name: row.name, floor: normalizeDecimal(row.floor), status: "pending", reason: "", attempts: 0, logs: [] }))
    };
  }
  function spreadsheetText(value) {
    let text = value === void 0 || value === null ? "" : String(value);
    if (/^[\s\u0000-\u001F]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
    return text;
  }
  function csvCell(value) {
    return `"${spreadsheetText(value).replace(/"/g, '""')}"`;
  }
  function exportCsv(batch, filter = "all") {
    const success = /* @__PURE__ */ new Set(["success", "exists"]);
    const tasks = batch.tasks.filter((task) => filter === "all" || (filter === "success" ? success.has(task.status) : !success.has(task.status)));
    const records = [["原始行号", "发布商ID", "应用名称", "App ID", "广告位名称", "广告格式", "请求底价模式", "请求底价USD", "实际底价模式", "实际底价", "实际币种", "广告位ID", "状态", "原因", "完成时间"]];
    for (const task of tasks) records.push([task.line, batch.identity.publisherId, batch.identity.appName, batch.identity.appId, task.name, FORMAT_ZH[batch.format], "手动设定底价", task.floor, task.actual?.mode, task.actual?.floor, task.actual?.currency, task.actual?.unitId, STATUS_ZH[task.status], task.reason, task.finishedAt]);
    return `\uFEFF${records.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r
`;
  }
  function copyPairs(batch) {
    const cell = (value) => {
      const text = spreadsheetText(value);
      return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return batch.tasks.filter((task) => task.actual?.unitId).map((task) => `${cell(task.name)}	${cell(task.actual.unitId)}`).join("\r\n");
  }

  // src/adapter.ts
  var ZH = {
    publisher: ["发布商 ID", "发布商ID", "Publisher ID"],
    appId: ["应用 ID", "应用ID", "AdMob 应用 ID", "AdMob App ID"],
    appName: ["应用名称", "当前应用"],
    units: ["广告单元"],
    add: ["添加广告单元"],
    create: ["创建广告单元"],
    name: ["广告单元名称"],
    advanced: ["高级设置"],
    manual: ["手动设定底价"],
    floor: ["全局底价", "有效每千次展示费用底价", "全局有效每千次展示费用底价"],
    format: ["广告格式"],
    unitId: ["广告单元 ID", "广告单元ID"],
    mode: ["底价模式", "有效每千次展示费用底价模式"],
    amount: ["全局底价", "全局有效每千次展示费用底价"],
    currency: ["底价币种", "币种"],
    interstitial: ["插页式", "插屏"],
    "app-open": ["开屏"],
    next: ["下一页"],
    first: ["第一页", "首页"]
  };
  var AdapterError = class extends Error {
    code;
    fatal;
    actual;
    constructor(code, message, fatal = true, actual) {
      super(message);
      this.name = "AdapterError";
      this.code = code;
      this.fatal = fatal;
      this.actual = actual;
    }
  };
  var txt = (e) => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
  var compact = (s) => s.replace(/[：:\s]/g, "");
  var sameLabel = (s, labels) => labels.some((x) => compact(s) === compact(x));
  var publisherRx = /^pub-\d{16}$/;
  var appRx = /^ca-app-pub-\d{16}~\d{10}$/;
  var unitRx = /^ca-app-pub-\d{16}\/\d{10}$/;
  function visible(e) {
    if (!e.isConnected || e.closest('[hidden],[aria-hidden="true"],inert')) return false;
    const view = e.ownerDocument.defaultView;
    for (let node = e; node; node = node.parentElement) {
      const style = view?.getComputedStyle(node);
      if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return false;
    }
    return true;
  }
  function elements(scope, selector) {
    return [...scope.querySelectorAll(selector)].filter(visible);
  }
  function one(candidates, step) {
    const deduped = [...new Set(candidates)];
    if (deduped.length !== 1) throw new AdapterError("STRUCTURE", `${step}：找到 ${deduped.length} 个候选控件，已停止，需适配当前页面`);
    return deduped[0];
  }
  function enabled(e) {
    return !e.hasAttribute("disabled") && e.getAttribute("aria-disabled") !== "true";
  }
  function accessibleName(e) {
    const refs = e.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => txt(e.ownerDocument.getElementById(id))).join(" ");
    return e.getAttribute("aria-label")?.trim() || refs || e.labels?.[0]?.textContent?.trim() || txt(e);
  }
  function controls(scope, labels, selector = 'button,[role="button"],a') {
    return elements(scope, selector).filter((e) => sameLabel(accessibleName(e), labels));
  }
  function click(e, step) {
    if (!visible(e) || !enabled(e)) throw new AdapterError("STRUCTURE", `${step}：控件不可见或不可操作`);
    e.click();
  }
  function labelledInputs(scope, labels) {
    return elements(scope, 'input:not([type="hidden"]),textarea').filter((e) => sameLabel(accessibleName(e), labels));
  }
  function readField(scope, labels) {
    const values = [];
    for (const e of elements(scope, 'dt,th,label,[role="rowheader"]')) {
      if (!sameLabel(txt(e), labels)) continue;
      if (e.tagName === "DT" && e.nextElementSibling?.tagName === "DD") values.push(txt(e.nextElementSibling));
      if (e.tagName === "TH" || e.getAttribute("role") === "rowheader") {
        const row = e.closest('tr,[role="row"]');
        const cells = row ? elements(row, 'td,[role="cell"]') : [];
        if (cells.length === 1) values.push(txt(cells[0]));
      }
      if (e.tagName === "LABEL") {
        const target = e.control;
        if (target && visible(target) && (target.hasAttribute("readonly") || target.tagName === "OUTPUT")) values.push(target.value || txt(target));
      }
    }
    for (const e of elements(scope, "[aria-label],output")) {
      if (!sameLabel(e.getAttribute("aria-label") || "", labels)) continue;
      if (/^(INPUT|TEXTAREA)$/.test(e.tagName) && !e.hasAttribute("readonly")) continue;
      values.push(e.value || txt(e));
    }
    const distinct = [...new Set(values.map((x) => x.trim()).filter(Boolean))];
    if (distinct.length > 1) throw new AdapterError("IDENTITY", `字段“${labels[0]}”出现多个不同值，无法确认当前上下文`);
    return distinct[0];
  }
  function currencyOf(input) {
    const contexts = [accessibleName(input)];
    for (const attr of ["aria-describedby", "aria-labelledby"]) {
      for (const id of (input.getAttribute(attr) || "").split(/\s+/).filter(Boolean)) contexts.push(txt(input.ownerDocument.getElementById(id)));
    }
    const parent = input.parentElement;
    const local = input.closest("label") || (parent && !/^(BODY|HTML|FORM|MAIN|SECTION|FIELDSET)$/.test(parent.tagName) && parent.querySelectorAll("input").length === 1 && txt(parent).length < 240 ? parent : null);
    if (local) contexts.push(txt(local));
    const text = contexts.join(" ");
    if (/\b(?:CNY|RMB|EUR|GBP|HKD|CAD|AUD|SGD|JPY|TWD)\b|人民币|欧元|港元|加元|澳元|新加坡元|日元|英镑|CN¥|HK\$|CA\$|A\$/i.test(text)) throw new AdapterError("CURRENCY", "底价输入控件的币种不是 USD 或包含冲突币种");
    if (/\bUSD\b|US\$|美元/i.test(text)) return "USD";
    throw new AdapterError("CURRENCY", "无法从底价输入控件的关联标签确认 USD；单独的 $ 不足以确认美元");
  }
  function scaled(s, scale) {
    const [whole, fraction = ""] = s.split(".");
    return BigInt(whole + fraction.padEnd(scale, "0"));
  }
  function checkConstraints(input, value) {
    const normalized = normalizeDecimal(value);
    const min = input.getAttribute("min");
    const max = input.getAttribute("max");
    const step = input.getAttribute("step");
    const candidates = [normalized, min, max, step === "any" ? null : step].filter((x) => !!x).map(normalizeDecimal);
    const scale = Math.max(0, ...candidates.map((x) => (x.split(".")[1] || "").length));
    const actual = scaled(normalized, scale);
    if (min && actual < scaled(normalizeDecimal(min), scale)) throw new AdapterError("ROW", `底价小于页面允许的最小值 ${min}`, false);
    if (max && actual > scaled(normalizeDecimal(max), scale)) throw new AdapterError("ROW", `底价大于页面允许的最大值 ${max}`, false);
    const actualStep = step || (input.type === "number" ? "1" : "any");
    if (actualStep !== "any") {
      const stepScale = Math.max(scale, (actualStep.split(".")[1] || "").length);
      const stepInteger = scaled(normalizeDecimal(actualStep), stepScale);
      if (stepInteger <= 0n || (scaled(normalized, stepScale) - scaled(min ? normalizeDecimal(min) : "0", stepScale)) % stepInteger !== 0n) throw new AdapterError("ROW", `底价不符合页面的小数精度/步长 ${actualStep}`, false);
    }
  }
  function setInput(input, value) {
    if (!enabled(input) || input.readOnly) throw new AdapterError("STRUCTURE", "输入控件不可编辑");
    const win = input.ownerDocument.defaultView;
    const proto = input.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    input.dispatchEvent(new win.Event("change", { bubbles: true }));
    input.dispatchEvent(new win.Event("blur", { bubbles: true }));
    if (input.value !== value) throw new AdapterError("ROW", "页面未接受输入值，未执行提交", false);
  }
  function formatFrom(s) {
    if (!s) return void 0;
    if (sameLabel(s, ZH.interstitial)) return "interstitial";
    if (sameLabel(s, ZH["app-open"])) return "app-open";
    return void 0;
  }
  function required(s, message) {
    if (!s) throw new AdapterError("STRUCTURE", message);
    return s;
  }
  function bodyScope(doc) {
    return doc;
  }
  function activeFilters(table) {
    const region = table.closest('main,[role="main"]') || table.closest('[role="region"],section') || table.parentElement;
    const fields = elements(region, 'input,select,[role="combobox"],[role="searchbox"]');
    for (const field of fields) {
      const label = accessibleName(field);
      if (/每页|每次显示|行数/.test(label)) continue;
      const isSearch = field.type === "search" || field.getAttribute("role") === "searchbox" || /搜索|筛选/.test(label);
      const isSelection = field.tagName === "SELECT" || field.getAttribute("role") === "combobox";
      const value = field.value || field.getAttribute("aria-valuetext") || (isSelection ? txt(field.querySelector('[aria-selected="true"],option:checked')) : "");
      if (value?.trim() && (isSearch || isSelection) && !/^(全部|所有|所有广告单元|全部广告单元|所有状态)$/.test(value.trim())) return true;
    }
    return elements(region, 'button,[role="button"]').some((e) => /清除(?:所有)?筛选|移除筛选条件|删除筛选条件/.test(accessibleName(e)) && enabled(e));
  }
  var AdMobAdapter = class {
    doc;
    timeout;
    prepared;
    submitted = false;
    sourceListLink;
    constructor(doc = document, timeout = 15e3) {
      this.doc = doc;
      this.timeout = timeout;
    }
    async wait(fn, step) {
      const initial = fn();
      if (initial) return initial;
      return new Promise((resolve, reject) => {
        const finish = (err, value) => {
          observer.disconnect();
          clearTimeout(timer);
          err ? reject(err) : resolve(value);
        };
        const observer = new this.doc.defaultView.MutationObserver(() => {
          try {
            const value = fn();
            if (value) finish(void 0, value);
          } catch (err) {
            finish(err);
          }
        });
        observer.observe(this.doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        const timer = setTimeout(() => finish(new AdapterError("TIMEOUT", `${step}：等待页面条件超时，未确认结果`)), this.timeout);
      });
    }
    async identify() {
      const location2 = this.doc.location;
      if (location2 && /accounts\.google\.com$/.test(location2.hostname)) throw new AdapterError("LOGIN", "登录已失效，请在原浏览器恢复登录");
      const scope = bodyScope(this.doc);
      const publisherId = required(readField(scope, ZH.publisher), "当前页面没有可核对的发布商 ID；请进入包含账号和目标应用信息的页面并导出诊断");
      const appId = required(readField(scope, ZH.appId), "当前页面没有可核对的 AdMob App ID；请进入目标应用，不能使用历史缓存");
      const appName = required(readField(scope, ZH.appName), "当前页面没有明确标注的当前应用名称");
      if (!publisherRx.test(publisherId) || !appRx.test(appId) || !appId.startsWith(`ca-app-${publisherId}~`)) throw new AdapterError("IDENTITY", "发布商 ID 与 App ID 无效或不属于同一发布商");
      const floorInputs = labelledInputs(scope, ZH.floor);
      let currency;
      if (floorInputs.length === 1) {
        try {
          currency = currencyOf(floorInputs[0]);
        } catch {
          currency = "无法确认 USD";
        }
      }
      return { publisherId, appId, appName, currency, evidence: ["当前页面显式发布商ID字段", "当前页面显式应用ID和应用名称字段"] };
    }
    async assertIdentity(identity) {
      const current = await this.identify();
      if (current.publisherId !== identity.publisherId || current.appId !== identity.appId) throw new AdapterError("IDENTITY", "当前发布商或应用与批次不一致，整批暂停");
    }
    list() {
      const tables = elements(this.doc, 'table,[role="table"],[role="grid"]').filter((e) => sameLabel(accessibleName(e), ZH.units) || e.querySelector("caption") && sameLabel(txt(e.querySelector("caption")), ZH.units));
      if (tables.length > 1) throw new AdapterError("STRUCTURE", "当前页面存在多个广告单元列表");
      return tables[0];
    }
    async home() {
      if (this.list()) return;
      const links = controls(this.doc, ZH.units, "a[href]");
      const link = one(links, "返回目标应用广告单元");
      this.sourceListLink = link.href;
      click(link, "广告单元");
      await this.wait(() => this.list(), "等待广告单元列表");
    }
    async lookup(identity, name) {
      await this.assertIdentity(identity);
      await this.home();
      {
        const table = requiredElement(this.list(), "未识别到广告单元表格");
        const region = table.closest('[role="region"],section') || table.parentElement;
        const first = controls(region, ZH.first);
        if (first.length > 1) return { complete: false, matches: [], reason: "列表首页控件不唯一" };
        if (first.length === 1 && enabled(first[0])) {
          const previous = txt(table);
          click(first[0], "返回列表第一页");
          await this.wait(() => {
            const fresh = this.list();
            return fresh && txt(fresh) !== previous;
          }, "等待列表第一页");
        }
      }
      const seen = /* @__PURE__ */ new Set();
      const matches = [];
      let counted = 0;
      let total;
      for (let pages = 0; pages < 200; pages++) {
        await this.assertIdentity(identity);
        const table = requiredElement(this.list(), "未识别到广告单元表格");
        const region = table.closest('[role="region"],section') || table.parentElement;
        if (activeFilters(table)) return { complete: false, matches, reason: "广告单元列表包含搜索或筛选，无法确认全部同名结果" };
        const totalMatch = txt(region).match(/共\s*(\d+)\s*(?:个|条)?\s*广告单元/);
        if (totalMatch) total = Number(totalMatch[1]);
        const headers = elements(table, 'thead th,[role="columnheader"]').map(txt);
        const nameIndex = headers.findIndex((h) => sameLabel(h, ZH.name));
        if (nameIndex < 0) return { complete: false, matches, reason: "列表缺少明确的广告单元名称列" };
        const rows = elements(table, 'tbody tr,[role="row"]').filter((r) => r.querySelector('td,[role="cell"]'));
        const signature = rows.map(txt).join("\n");
        if (seen.has(signature)) return { complete: false, matches, reason: "列表分页重复或未更新" };
        seen.add(signature);
        counted += rows.length;
        for (const row of rows) {
          const cells = elements(row, 'td,[role="cell"]');
          if (txt(cells[nameIndex]) !== name) continue;
          const get2 = (labels) => {
            const i = headers.findIndex((h) => sameLabel(h, labels));
            return i >= 0 ? txt(cells[i]) : void 0;
          };
          const unitId = get2(ZH.unitId);
          const format = formatFrom(get2(ZH.format));
          const mode = get2(ZH.mode);
          const floorRaw = get2(ZH.amount);
          const currencyRaw = get2(ZH.currency);
          let floor;
          try {
            if (floorRaw) floor = normalizeDecimal(floorRaw);
          } catch {
          }
          const currency = currencyRaw && /^(USD|US\$|美元)$/i.test(currencyRaw) ? "USD" : currencyRaw;
          const actual = { publisherId: identity.publisherId, appId: identity.appId, name, unitId, format, mode: mode === "手动设定底价" ? "manual" : mode, floor, currency, verified: !!unitId && unitRx.test(unitId) && !!format && mode === "手动设定底价" && !!floor && currency === "USD" };
          matches.push(actual);
        }
        if (total !== void 0 && counted === total) return { complete: true, matches };
        if (total !== void 0 && counted > total) return { complete: false, matches, reason: "列表总数与已读取行数不一致" };
        const next = controls(region, ZH.next);
        if (next.length !== 1 || !enabled(next[0])) return { complete: false, matches, reason: "缺少可核对的列表总数，不能证明分页/筛选结果完整" };
        const previous = signature;
        click(next[0], "下一页");
        await this.wait(() => {
          const fresh = this.list();
          return fresh && elements(fresh, 'tbody tr,[role="row"]').filter((r) => r.querySelector('td,[role="cell"]')).map(txt).join("\n") !== previous;
        }, "等待下一页列表");
      }
      return { complete: false, matches, reason: "超过分页安全上限，结果不完整" };
    }
    activeForm() {
      const names = labelledInputs(this.doc, ZH.name);
      if (!names.length) return void 0;
      const name = one(names, "定位广告单元名称");
      return name.closest('[role="dialog"],form') || name.closest('main,[role="main"]') || void 0;
    }
    async prepare(identity, format, name, floor, checkpoint) {
      this.prepared = void 0;
      this.submitted = false;
      await checkpoint();
      await this.assertIdentity(identity);
      if (!this.activeForm()) {
        await this.home();
        click(one(controls(this.doc, ZH.add), "添加广告单元"), "添加广告单元");
        await this.wait(() => elements(this.doc, '[role="group"],[role="region"],article,fieldset').some((e) => sameLabel(accessibleName(e), ZH[format]) || elements(e, "h1,h2,h3,h4,legend").some((h) => sameLabel(txt(h), ZH[format]))), "等待广告格式卡片");
        const cards = elements(this.doc, '[role="group"],[role="region"],article,fieldset').filter((e) => sameLabel(accessibleName(e), ZH[format]) || elements(e, "h1,h2,h3,h4,legend").some((h) => sameLabel(txt(h), ZH[format])));
        const leafCards = cards.filter((e) => !cards.some((other) => other !== e && e.contains(other)));
        const card = one(leafCards, "定位准确广告格式卡片");
        if (/激励/.test(accessibleName(card))) throw new AdapterError("STRUCTURE", "定位到了激励广告格式，已停止");
        click(one(controls(card, ["选择"]), `选择${ZH[format][0]}`), `选择${ZH[format][0]}`);
      }
      const form = await this.wait(() => this.activeForm(), "等待创建表单");
      await checkpoint();
      await this.assertIdentity(identity);
      const declaredFormat = readField(form, ZH.format) || txt(one(elements(form, "h1,h2,h3").filter((e) => ZH[format].some((f) => txt(e) === `创建${f}广告单元`)), "确认创建表单广告格式"));
      if (!formatFrom(declaredFormat) && !ZH[format].some((f) => declaredFormat === `创建${f}广告单元`)) throw new AdapterError("STRUCTURE", "创建表单未明确确认请求广告格式");
      if (formatFrom(declaredFormat) && formatFrom(declaredFormat) !== format) throw new AdapterError("STRUCTURE", "创建表单格式与批次不一致");
      const nameInput = one(labelledInputs(form, ZH.name), "广告单元名称");
      if (nameInput.maxLength >= 0 && name.length > nameInput.maxLength) throw new AdapterError("ROW", `名称超过当前页面上限 ${nameInput.maxLength}，未截断`, false);
      setInput(nameInput, name);
      const advanced = controls(form, ZH.advanced);
      if (advanced.length === 1 && advanced[0].getAttribute("aria-expanded") === "false") click(advanced[0], "展开高级设置");
      const manual = await this.wait(() => {
        const list = controls(form, ZH.manual, 'input[type="radio"],[role="radio"]');
        return list.length ? one(list, "手动设定底价") : void 0;
      }, "等待手动底价选项");
      await checkpoint();
      click(manual, "主动选择手动设定底价");
      await this.wait(() => manual.checked || manual.getAttribute("aria-checked") === "true", "回读手动底价模式");
      const floorInput = await this.wait(() => {
        const list = labelledInputs(form, ZH.floor);
        return list.length ? one(list, "全局底价输入框") : void 0;
      }, "等待全局底价输入框");
      const floorRegion = floorInput.closest('fieldset,[role="group"],[role="region"]');
      if (!floorRegion || !/全局|有效每千次展示费用底价/.test(accessibleName(floorRegion) + txt(floorRegion.querySelector("legend")))) throw new AdapterError("STRUCTURE", "无法确认底价字段属于广告单元的全局底价区域");
      if (/针对特定国家|针对特定地区|国家\/地区|中介组|瀑布流/.test(accessibleName(floorRegion))) throw new AdapterError("STRUCTURE", "底价字段可能属于国家/地区或中介组设置，未提交");
      currencyOf(floorInput);
      checkConstraints(floorInput, floor);
      setInput(floorInput, normalizeDecimal(floor));
      if (!decimalEqual(floorInput.value, floor) || nameInput.value !== name || !(manual.checked || manual.getAttribute("aria-checked") === "true")) throw new AdapterError("STRUCTURE", "名称、模式或底价回读不一致");
      currencyOf(floorInput);
      if (!floorInput.checkValidity() || !nameInput.checkValidity()) throw new AdapterError("ROW", "输入不满足当前 AdMob 表单校验规则", false);
      one(controls(form, ZH.create), "创建广告单元提交按钮");
      await checkpoint();
      await this.assertIdentity(identity);
      this.prepared = { identity, format, name, floor, form };
    }
    async submit() {
      const state = this.prepared;
      if (!state || this.submitted) throw new AdapterError("SUBMIT_GUARD", "当前表单未通过准备或已经执行过提交");
      await this.assertIdentity(state.identity);
      const form = this.activeForm();
      if (!form || form !== state.form) throw new AdapterError("STRUCTURE", "提交前表单被替换，需重新预检");
      const nameInput = one(labelledInputs(form, ZH.name), "提交前名称");
      const floorInput = one(labelledInputs(form, ZH.floor), "提交前底价");
      const manual = one(controls(form, ZH.manual, 'input[type="radio"],[role="radio"]'), "提交前模式");
      if (nameInput.value !== state.name || !decimalEqual(floorInput.value, state.floor) || !(manual.checked || manual.getAttribute("aria-checked") === "true")) throw new AdapterError("STRUCTURE", "提交前字段发生变化");
      const declaredFormat = readField(form, ZH.format) || elements(form, "h1,h2,h3").map(txt).find((s) => ZH[state.format].some((f) => s === `创建${f}广告单元`));
      if (formatFrom(declaredFormat) !== state.format && !ZH[state.format].some((f) => declaredFormat === `创建${f}广告单元`)) throw new AdapterError("STRUCTURE", "提交前广告格式发生变化或无法确认");
      currencyOf(floorInput);
      checkConstraints(floorInput, state.floor);
      if (!floorInput.checkValidity() || !nameInput.checkValidity()) throw new AdapterError("ROW", "提交前表单校验未通过", false);
      this.submitted = true;
      click(one(controls(form, ZH.create), "唯一创建按钮"), "创建广告单元");
    }
    async verify(identity, format, name, floor) {
      await this.assertIdentity(identity);
      const unitId = await this.wait(() => {
        const value = readField(this.doc, ZH.unitId);
        return value && unitRx.test(value) ? value : void 0;
      }, "等待真实广告单元 ID");
      const partial = { unitId, publisherId: identity.publisherId, appId: identity.appId, verified: false };
      try {
        if (!unitId.startsWith(`ca-app-${identity.publisherId}/`)) throw new AdapterError("IDENTITY", "广告单元ID所属发布商不一致");
        const detailLinks = elements(this.doc, "a[href]").filter((e) => sameLabel(accessibleName(e), ["查看广告单元", "广告单元设置", "查看设置"]) || accessibleName(e) === name);
        if (!readField(this.doc, ZH.mode) && detailLinks.length === 1) {
          click(detailLinks[0], "打开保存后的广告单元配置");
          await this.wait(() => readField(this.doc, ZH.mode), "等待已保存底价模式");
        }
        await this.assertIdentity(identity);
        const detailUnitId = readField(this.doc, ZH.unitId);
        if (detailUnitId !== unitId) throw new AdapterError("VERIFY", "保存后详情的广告单元ID与最初取得的ID不一致，不能合并两个单元的配置");
        if (this.activeForm()) throw new AdapterError("VERIFY", "仍停留在可编辑创建表单，不能作为已保存配置证据");
        const savedName = readField(this.doc, ZH.name);
        const savedFormat = formatFrom(readField(this.doc, ZH.format));
        const modeRaw = readField(this.doc, ZH.mode);
        const amountRaw = readField(this.doc, ZH.amount);
        const currencyRaw = readField(this.doc, ZH.currency);
        Object.assign(partial, { name: savedName, format: savedFormat, mode: modeRaw === "手动设定底价" ? "manual" : modeRaw, floor: amountRaw, currency: currencyRaw });
        if (!savedName || !savedFormat || !modeRaw || !amountRaw || !currencyRaw) throw new AdapterError("VERIFY", "已取得ID，但保存后页面缺少名称、格式、全局手动底价或币种字段");
        const savedFloor = normalizeDecimal(amountRaw);
        const savedCurrency = /^(USD|US\$|美元)$/i.test(currencyRaw) ? "USD" : currencyRaw;
        Object.assign(partial, { floor: savedFloor, currency: savedCurrency });
        if (savedName !== name || savedFormat !== format || modeRaw !== "手动设定底价" || !decimalEqual(savedFloor, floor) || savedCurrency !== "USD") throw new AdapterError("VERIFY", "已创建，但保存后配置与请求不一致");
        return { ...partial, verified: true };
      } catch (err) {
        if (err instanceof AdapterError) {
          err.actual = partial;
          throw err;
        }
        throw new AdapterError("VERIFY", "已取得ID，但保存后的配置无法可靠读取", true, partial);
      }
    }
    diagnostics() {
      const redact = (s) => s.replace(/ca-app-pub-\d{16}[~/]\d+/g, "[已隐去广告ID]").replace(/pub-\d+/g, "[已隐去发布商ID]").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[已隐去邮箱]");
      const knownLabels = Object.values(ZH).flat();
      const numericAttr = (e, key) => {
        const s = e.getAttribute(key);
        return s && /^(?:\d+(?:\.\d+)?|any)$/.test(s) ? s : void 0;
      };
      const safeLabel = (s) => knownLabels.find((x) => compact(x) === compact(s)) || (s.includes("USD") ? "[关联标签含USD]" : s.includes("US$") ? "[关联标签含US$]" : s.includes("美元") ? "[关联标签含美元]" : s.includes("$") ? "[关联标签仅含$]" : "[未在诊断白名单中的文字]");
      const items = elements(this.doc, 'input:not([type="hidden"]),textarea,button,[role="button"],[role="radio"],dt,th,legend').slice(0, 300).map((e) => ({
        tag: e.tagName.toLowerCase(),
        role: ["button", "radio", "textbox", "spinbutton", "rowheader", "columnheader"].includes(e.getAttribute("role") || "") ? e.getAttribute("role") : void 0,
        label: safeLabel(redact(accessibleName(e))),
        type: e.tagName === "INPUT" ? e.type : void 0,
        disabled: !enabled(e),
        min: numericAttr(e, "min"),
        max: numericAttr(e, "max"),
        step: numericAttr(e, "step"),
        maxLength: numericAttr(e, "maxlength")
      }));
      return { adapter: "semantic-candidate-unverified-live", time: (/* @__PURE__ */ new Date()).toISOString(), origin: this.doc.location?.origin, controls: items, omitted: "不导出URL路径、查询参数、DOM HTML、输入值、账号ID、应用名、Cookie、Token、密码或任意页面正文" };
    }
  };
  function requiredElement(e, message) {
    if (!e) throw new AdapterError("STRUCTURE", message);
    return e;
  }

  // src/panel.ts
  var STYLE = `
:host{all:initial;color-scheme:light;font-family:system-ui,"Microsoft YaHei",sans-serif;font-size:13px;line-height:1.5;color:#192331}
*{box-sizing:border-box}button,input,select,textarea{font:inherit}button{cursor:pointer;border:1px solid #c3cddd;border-radius:6px;background:#fff;color:#253751;padding:6px 10px;min-height:32px}button:hover:not(:disabled){background:#eef4ff;border-color:#6d8cb8}button:disabled{opacity:.45;cursor:not-allowed}button.primary{background:#155db4;color:white;border-color:#155db4}button.danger{color:#b42318}input,select,textarea{border:1px solid #c3cddd;border-radius:5px;background:#fff;color:#192331;padding:6px;max-width:100%}input:disabled,select:disabled,textarea:disabled{background:#edf1f5;color:#667386}input[type=checkbox]{width:16px;height:16px;margin:0;flex-shrink:0}input:focus-visible,button:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid #2a71ca;outline-offset:2px}h2,h3,p{margin:0}h2{font-size:15px}h3{font-size:13px;margin-bottom:7px}section{padding:12px 14px;border-bottom:1px solid #e1e7ef}.shell{position:fixed;right:16px;top:72px;z-index:2147483647;width:min(650px,calc(100vw - 32px));max-height:calc(100vh - 88px);border:1px solid #bac9dc;border-radius:10px;background:white;box-shadow:0 8px 36px #12263f33;overflow:hidden}.head{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#f1f6fc;border-bottom:1px solid #d5e1ef}.head h2{flex:1}.head small{font-size:11px;font-weight:normal;color:#526884}.body{overflow:auto;max-height:calc(100vh - 145px);overscroll-behavior:contain}.shell.collapsed{width:260px}.shell.collapsed .body{display:none}.row,.actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.config{display:grid;grid-template-columns:1fr 1fr;gap:9px}.field{display:flex;flex-direction:column;gap:4px}.field.full{grid-column:1/-1}.field select{width:100%}.muted{color:#596b80;font-size:12px}.warning{color:#865300;background:#fff8df;border:1px solid #f0dea0;border-radius:6px;padding:8px;margin-top:8px}.notice{white-space:pre-wrap;overflow-wrap:anywhere;background:#edf4ff;color:#244f84;border-radius:6px;padding:8px;margin-bottom:8px}.notice:empty{display:none}.identity{display:grid;grid-template-columns:102px 1fr;gap:4px 10px;margin:8px 0}.identity dt{color:#566a83}.identity dd{margin:0;overflow-wrap:anywhere;font-family:inherit}.identity dd.code{font-family:ui-monospace,Consolas,monospace}.identity-state{white-space:pre-wrap;color:#865300}.table-scroll{overflow:auto;margin:8px 0;max-height:260px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #d9e1eb;padding:5px;vertical-align:middle}th{background:#f1f5fa;text-align:center;font-weight:600;position:sticky;top:0;z-index:1}.input-table th:nth-child(1){width:42px}.input-table th:nth-child(2){width:47%}.input-table th:nth-child(3){width:125px}.input-table td:first-child,.input-table td:last-child{text-align:center}.input-table input{width:100%;min-width:100px;padding:5px}.input-table input[aria-invalid=true]{border-color:#d14438;background:#fff8f7}.input-table .error-row td{text-align:left;color:#a52c22;background:#fff6f3}.input-table .error-row[hidden]{display:none}.input-table .error-row td span{font-weight:600}.result-table{min-width:670px}.result-table td:nth-child(1),.result-table td:nth-child(3),.result-table td:nth-child(4),.result-table td:nth-child(5){text-align:center}.result-table td:nth-child(2),.result-table td:last-child{text-align:left;white-space:normal;overflow-wrap:anywhere}.result-table td:nth-child(6){text-align:center;font-family:ui-monospace,Consolas,monospace}.badge{display:inline-block;border-radius:4px;padding:2px 5px;background:#edf1f6;color:#40516b;white-space:nowrap}.badge.good{background:#e5f5ec;color:#17633d}.badge.bad{background:#fff0e9;color:#9c3d19}.checks{list-style:none;padding:0;margin:7px 0}.checks li{display:flex;gap:6px;margin:4px 0;align-items:flex-start}.check-ok{color:#17633d}.check-bad{color:#a34122}.confirm{display:flex;gap:8px;align-items:flex-start;margin:10px 0}.confirm input{margin-top:3px}.log{max-height:180px;overflow:auto;background:#f5f7fa;padding:8px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;border-radius:5px}.log:empty::before{content:"暂无执行日志";color:#627188}.summary{font-size:12px;color:#4e6581;margin:6px 0}.paste{width:100%;min-height:80px;resize:vertical;font-family:ui-monospace,Consolas,"Microsoft YaHei",monospace}.spacer{margin-top:9px}summary{cursor:pointer;color:#385c88}.file{max-width:245px;font-size:12px}.empty{text-align:center;padding:16px;color:#63768e}.footer{font-size:11px;color:#627188;padding:8px 14px}.mode-note{min-height:18px}.batch-meta{overflow-wrap:anywhere}.error-cell{max-width:220px}@media(max-width:560px){.shell{right:8px;top:40px;width:calc(100vw - 16px);max-height:calc(100vh - 48px)}.body{max-height:calc(100vh - 105px)}.config{grid-template-columns:1fr}.identity{grid-template-columns:88px 1fr}.head small{display:none}}
`;
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== void 0) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function option(value, label) {
    const node = element("option", label);
    node.value = value;
    return node;
  }
  function csvCell2(value) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  function safeLogText(value) {
    return value.replace(/\b(cookie|set-cookie|authorization)["']?\s*[:=：][^\r\n]*/gi, "$1: [凭证已隐藏]").replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [凭证已隐藏]").replace(/\b(access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|token|password|passwd|secret)["']?\s*[:=：]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, "$1=[凭证已隐藏]").replace(/(密码|口令)\s*[:=：]\s*[^\s,;]+/g, "$1=[凭证已隐藏]");
  }
  function elapsedText(from, to) {
    return Number.isFinite(from) && Number.isFinite(to) && to >= from ? `${((to - from) / 1e3).toFixed(3)} 秒` : "未知";
  }
  function logStepLabel(step) {
    return Object.prototype.hasOwnProperty.call(STATUS_ZH, step) ? STATUS_ZH[step] : `其他步骤（${safeLogText(step)}）`;
  }
  function mountPanel(actions) {
    if (document.getElementById("abc-panel-host")) throw new Error("AdMob Batch Creator 面板已存在");
    const host = element("div");
    host.id = "abc-panel-host";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.append(element("style", STYLE));
    const shell = element("aside", void 0, "shell");
    shell.setAttribute("aria-label", "AdMob 批量创建广告位");
    const head = element("header", void 0, "head");
    const title = element("h2", "AdMob Batch Creator");
    title.append(element("small", " · 批量广告单元"));
    const collapse = element("button", "收起");
    collapse.type = "button";
    collapse.setAttribute("aria-expanded", "true");
    head.append(title, collapse);
    shell.append(head);
    const body = element("div", void 0, "body");
    body.id = "abc-panel-body";
    collapse.setAttribute("aria-controls", body.id);
    shell.append(body);
    shadow.append(shell);
    document.documentElement.append(host);
    const state = { ready: false, checks: [], busy: false };
    let localBusy = false;
    let inputRows = [];
    let sourceDirty = false;
    const sourceIssues = /* @__PURE__ */ new WeakMap();
    let renderedBatch = "";
    const editableControls = [];
    const buttons = {};
    const notice = element("div", "", "notice");
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    const section = (heading) => {
      const n = element("section");
      n.append(element("h3", heading));
      body.append(n);
      return n;
    };
    const accountSection = section("当前页面");
    accountSection.prepend(notice);
    const identityList = element("dl", void 0, "identity");
    const identityValues = {};
    for (const [key, label] of [["publisherId", "发布商 ID"], ["appName", "当前应用"], ["appId", "AdMob App ID"], ["currency", "底价字段币种"]]) {
      const value = element("dd", "未识别", key === "publisherId" || key === "appId" ? "code" : "");
      identityValues[key] = value;
      identityList.append(element("dt", label), value);
    }
    const identityStatus = element("p", "请进入目标应用，再识别当前账号。", "identity-state");
    const capabilities = element("p", "", "muted spacer");
    accountSection.append(identityList, identityStatus);
    async function invoke(run) {
      if (localBusy) return;
      localBusy = true;
      updateControls();
      try {
        await run();
      } catch (error) {
        state.notice = error instanceof Error ? error.message : String(error);
        renderNotice();
      } finally {
        localBusy = false;
        updateControls();
      }
    }
    function button(key, label, callback, className = "") {
      const b = element("button", label, className);
      b.type = "button";
      buttons[key] = b;
      b.addEventListener("click", () => {
        void invoke(callback);
      });
      return b;
    }
    const accountActions = element("div", void 0, "actions spacer");
    accountActions.append(button("identify", "重新识别", actions.identify), button("probe", "检测跨页能力", actions.probe), button("diagnostics", "导出脱敏诊断", actions.diagnostics));
    accountSection.append(accountActions, capabilities);
    accountSection.append(element("p", "真实 AdMob 与 HubVPS 流程尚未验收。未知页面或币种不明时会阻止提交。", "warning"));
    const settings = section("整批设置");
    const config = element("div", void 0, "config");
    const format = element("select");
    format.setAttribute("aria-label", "广告格式");
    format.append(option("interstitial", "插页式 / 插屏"), option("app-open", "开屏"));
    const mode = element("input");
    mode.value = "手动设定底价";
    mode.readOnly = true;
    mode.setAttribute("aria-label", "底价模式");
    const currency = element("input");
    currency.value = "USD / 千次展示";
    currency.readOnly = true;
    currency.setAttribute("aria-label", "请求底价币种");
    const concurrency = element("select");
    concurrency.setAttribute("aria-label", "并发数");
    concurrency.append(option("1", "1 个执行页"), option("2", "2 个执行页（默认）"), option("3", "3 个执行页"));
    concurrency.value = "2";
    const execution = element("select");
    execution.setAttribute("aria-label", "执行方式");
    execution.append(option("tabs", "主控 + 执行标签页"), option("single", "单页模式（当前页执行）"));
    const controls2 = [["广告格式", format], ["底价模式", mode], ["请求币种", currency], ["并发数", concurrency], ["执行方式", execution]];
    for (const [labelText, control] of controls2) {
      const label = element("label", void 0, "field");
      label.append(element("span", labelText), control);
      config.append(label);
    }
    editableControls.push(format, concurrency, execution);
    settings.append(config);
    const modeNote = element("p", "先核验首条，再扩展并发；这是插件配置，并非 AdMob 官方额度。", "muted spacer mode-note");
    settings.append(modeNote);
    for (const control of [format, concurrency, execution]) control.addEventListener("change", () => {
      invalidate();
      concurrency.disabled = execution.value === "single" || isFrozen() || isBusy();
      modeNote.textContent = execution.value === "single" ? "单页模式只操作当前页面；仍需可靠的主控互斥。" : "先核验首条，再扩展并发；这是插件配置，并非 AdMob 官方额度。";
    });
    const inputSection = section("两列清单");
    const pasteLabel = element("label", void 0, "field");
    pasteLabel.append(element("span", "粘贴 Excel 两列、TSV 或 CSV"));
    const paste = element("textarea", void 0, "paste");
    paste.placeholder = "广告位名称,底价USD\nUS_NEW_INT_60,60\nUS_NEW_INT_40,40";
    paste.setAttribute("aria-label", "CSV 或 TSV 输入");
    pasteLabel.append(paste);
    inputSection.append(pasteLabel);
    editableControls.push(paste);
    const inputActions = element("div", void 0, "actions spacer");
    const parseButton = element("button", "解析到清单");
    parseButton.type = "button";
    parseButton.addEventListener("click", () => {
      inputRows = parsedRows(paste.value);
      sourceDirty = false;
      invalidate();
      renderRows();
    });
    paste.addEventListener("input", () => {
      sourceDirty = true;
      invalidate();
      validateRows();
    });
    const file = element("input", void 0, "file");
    file.type = "file";
    file.accept = ".csv,.tsv,text/csv,text/tab-separated-values";
    file.setAttribute("aria-label", "导入 CSV 或 TSV");
    file.addEventListener("change", () => {
      const selected = file.files?.[0];
      if (!selected) return;
      void invoke(async () => {
        paste.value = await selected.text();
        inputRows = parsedRows(paste.value);
        sourceDirty = false;
        invalidate();
        renderRows();
        file.value = "";
      });
    });
    const add = element("button", "增加一行");
    add.type = "button";
    add.addEventListener("click", () => {
      inputRows.push({ line: Math.max(0, ...inputRows.map((r) => r.line)) + 1, name: "", floor: "", errors: [] });
      invalidate();
      renderRows();
      rowNodes.at(-1)?.name.focus();
    });
    editableControls.push(parseButton, file, add);
    inputActions.append(parseButton, file, add);
    inputSection.append(inputActions);
    const inputSummary = element("p", "尚未导入清单。", "summary");
    inputSummary.setAttribute("aria-live", "polite");
    inputSection.append(inputSummary);
    const inputScroll = element("div", void 0, "table-scroll");
    const inputTable = element("table", void 0, "input-table");
    inputTable.setAttribute("aria-label", "广告位名称与底价清单");
    const inputHead = element("thead");
    const inputHeadRow = element("tr");
    for (const name of ["原行", "广告位名称", "底价（USD / 千次）", "操作"]) inputHeadRow.append(element("th", name));
    inputHead.append(inputHeadRow);
    const inputTbody = element("tbody");
    inputTable.append(inputHead, inputTbody);
    inputScroll.append(inputTable);
    inputSection.append(inputScroll);
    inputSection.append(element("p", "输入 60 表示 60 美元。仅接受明确的十进制金额；不会自动换汇、截断名称或添加后缀。", "muted"));
    const runSection = section("预检与执行");
    const checklist = element("ul", void 0, "checks");
    runSection.append(checklist);
    const confirmLabel = element("label", void 0, "confirm");
    const confirm = element("input");
    confirm.type = "checkbox";
    confirmLabel.append(confirm, element("span", "我已核对当前发布商、应用、广告格式和两列清单；点击“开始创建”确认整个批次。"));
    runSection.append(confirmLabel);
    confirm.addEventListener("change", updateControls);
    const runActions = element("div", void 0, "actions");
    runActions.append(button("preflight", "预检（不提交）", () => actions.preflight(getConfig())), button("start", "开始创建", () => actions.start(getConfig()), "primary"), button("pause", "暂停", actions.pause), button("resume", "继续", actions.resume), button("stop", "停止", actions.stop, "danger"));
    const recoveryActions = element("div", void 0, "actions spacer");
    recoveryActions.append(button("retry", "重试明确失败项", actions.retry), button("verify", "核验结果不确定项", actions.verify), button("degrade", "降级为单页", actions.degrade));
    buttons.degrade.title = "停止增加执行标签页，保留旧执行页并继续收集其结果；后续任务在当前页执行";
    runSection.append(runActions, recoveryActions);
    const resultSection = section("结果");
    const batchMeta = element("p", "暂无批次", "muted batch-meta");
    const resultSummary = element("p", "", "summary");
    const resultScroll = element("div", void 0, "table-scroll");
    const resultTable = element("table", void 0, "result-table");
    resultTable.setAttribute("aria-label", "广告单元创建结果");
    const resultHead = element("thead");
    const resultHeadRow = element("tr");
    for (const name of ["原行", "广告位名称", "请求 USD", "实际底价 / 币种", "状态", "广告位 ID", "原因"]) resultHeadRow.append(element("th", name));
    resultHead.append(resultHeadRow);
    const resultTbody = element("tbody");
    resultTable.append(resultHead, resultTbody);
    resultScroll.append(resultTable);
    const exports = element("div", void 0, "actions spacer");
    exports.append(button("export-all", "导出全部", () => actions.export("all")), button("export-success", "导出成功", () => actions.export("success")), button("export-exceptions", "导出异常", () => actions.export("exceptions")), button("copy", "复制“名称 + ID”", actions.copy));
    resultSection.append(batchMeta, resultSummary, resultScroll, exports);
    const logsDetails = element("details");
    logsDetails.append(element("summary", "查看执行日志"));
    const logs = element("div", "", "log spacer");
    logsDetails.append(logs);
    resultSection.append(logsDetails);
    body.append(element("div", "记录仅保存在当前浏览器配置。停止不会删除已创建的广告单元。", "footer"));
    const rowNodes = [];
    function parsedRows(text) {
      const rows = parseInput(text);
      for (const row of rows) sourceIssues.set(row, row.errors.filter((error) => /两列|引号/.test(error)));
      return rows;
    }
    function serializeRows() {
      return inputRows.map((row) => `${csvCell2(row.name)},${csvCell2(row.floor)}`).join("\r\n");
    }
    function validateRows() {
      const occurrences = /* @__PURE__ */ new Map();
      for (const row of inputRows) occurrences.set(row.name, (occurrences.get(row.name) ?? 0) + 1);
      inputRows.forEach((row) => {
        const parsed = parseInput(`广告位名称,底价USD\r
${csvCell2(row.name)},${csvCell2(row.floor)}`)[0];
        row.errors = [...parsed?.errors ?? ["广告位名称不能为空", "缺失底价"], ...(sourceIssues.get(row) ?? []).map((error) => `${error}；请修正粘贴区并重新解析`)];
        if (row.name && (occurrences.get(row.name) ?? 0) > 1) row.errors.push("输入清单中存在重复名称，请逐行处理");
      });
      const errors = inputRows.filter((row) => row.errors.length).length;
      inputSummary.textContent = sourceDirty ? "粘贴区已改动，请先点击“解析到清单”。" : inputRows.length ? `共 ${inputRows.length} 行 · ${errors ? `${errors} 行有错误` : "输入格式通过，尚需后台预检"}` : "尚未导入清单。";
      rowNodes.forEach((nodes, index) => {
        const row = inputRows[index];
        if (!row) return;
        nodes.error.textContent = `原始第 ${row.line} 行：${row.errors.join("；")}`;
        nodes.errorRow.hidden = !row.errors.length;
        nodes.name.setAttribute("aria-invalid", String(row.errors.some((error) => /名称|重复|列数|解析/.test(error))));
        nodes.floor.setAttribute("aria-invalid", String(row.errors.some((error) => /底价|金额|数字|十进制|列数|解析/.test(error))));
      });
      updateControls();
    }
    function renderRows() {
      inputTbody.replaceChildren();
      rowNodes.length = 0;
      for (const [index, row] of inputRows.entries()) {
        const tr = element("tr");
        const number = element("td", String(row.line));
        const nameCell = element("td");
        const nameInput = element("input");
        nameInput.type = "text";
        nameInput.value = row.name;
        nameInput.setAttribute("aria-label", `第 ${row.line} 行广告位名称`);
        const floorCell = element("td");
        const floorInput = element("input");
        floorInput.type = "text";
        floorInput.inputMode = "decimal";
        floorInput.value = row.floor;
        floorInput.setAttribute("aria-label", `第 ${row.line} 行底价 USD`);
        nameCell.append(nameInput);
        floorCell.append(floorInput);
        const operation = element("td");
        const remove = element("button", "删除");
        remove.type = "button";
        remove.setAttribute("aria-label", `删除第 ${row.line} 行`);
        remove.addEventListener("click", () => {
          inputRows.splice(index, 1);
          invalidate();
          renderRows();
        });
        operation.append(remove);
        tr.append(number, nameCell, floorCell, operation);
        const errorRow = element("tr", void 0, "error-row");
        const error = element("td");
        error.colSpan = 4;
        errorRow.append(error);
        inputTbody.append(tr, errorRow);
        rowNodes.push({ name: nameInput, floor: floorInput, error, errorRow, remove });
        for (const [input, field] of [[nameInput, "name"], [floorInput, "floor"]]) {
          input.addEventListener("input", () => {
            row[field] = input.value;
            invalidate();
            validateRows();
          });
          input.addEventListener("paste", (event) => {
            const text = event.clipboardData?.getData("text/plain");
            if (!text || !/[\t\r\n]/.test(text)) return;
            event.preventDefault();
            const pasted = parsedRows(text);
            if (!pasted.length) return;
            const nextLine = Math.max(0, ...inputRows.map((item) => item.line)) + 1;
            const mapped = pasted.map((item, offset) => {
              item.line = inputRows[index + offset]?.line ?? nextLine + offset;
              return item;
            });
            inputRows.splice(index, mapped.length, ...mapped);
            invalidate();
            renderRows();
          });
        }
      }
      validateRows();
    }
    function getConfig() {
      validateRows();
      return { format: format.value, concurrency: execution.value === "single" ? 1 : Number(concurrency.value), execution: execution.value, text: serializeRows(), rows: structuredClone(inputRows) };
    }
    function invalidate() {
      state.ready = false;
      state.checks = [];
      confirm.checked = false;
      renderChecks();
      updateControls();
    }
    function isFrozen() {
      return !!state.batch && ["running", "paused", "stopping"].includes(state.batch.phase);
    }
    function isBusy() {
      return localBusy || !!state.busy;
    }
    function updateControls() {
      const busy = isBusy(), frozen = isFrozen(), batch = state.batch;
      editableControls.forEach((control) => {
        control.disabled = busy || frozen;
      });
      concurrency.disabled = busy || frozen || execution.value === "single";
      rowNodes.forEach((nodes) => {
        nodes.name.disabled = busy || frozen;
        nodes.floor.disabled = busy || frozen;
        nodes.remove.disabled = busy || frozen;
      });
      confirm.disabled = busy || frozen;
      Object.values(buttons).forEach((b) => {
        b.disabled = busy;
      });
      const valid = !sourceDirty && inputRows.length > 0 && inputRows.every((row) => !row.errors.length);
      buttons.preflight.disabled = busy || frozen || !valid;
      buttons.start.disabled = busy || frozen || !!batch && batch.phase !== "draft" || !!batch?.stopRequestedAt || !valid || !state.ready || !confirm.checked;
      buttons.pause.disabled = busy || batch?.phase !== "running";
      buttons.resume.disabled = busy || batch?.phase !== "paused" || !batch.confirmedAt || !!batch.stopRequestedAt;
      buttons.stop.disabled = busy || !batch || !["draft", "running", "paused", "stopping"].includes(batch.phase);
      buttons.retry.disabled = busy || !batch || batch.phase === "running" || batch.phase === "stopping" || !batch.tasks.some((t) => t.status === "failed" && !t.intentAt && !t.actual?.unitId && t.attempts < 3);
      buttons.verify.disabled = busy || !batch || batch.phase === "running" || !batch.tasks.some((t) => ["uncertain", "created-unverified", "submitting", "verifying"].includes(t.status));
      buttons.degrade.disabled = busy || !batch || batch.execution !== "tabs" || !["running", "paused"].includes(batch.phase);
      for (const key of ["export-all", "export-success", "export-exceptions", "copy"]) buttons[key].disabled = busy || !batch;
    }
    function renderNotice() {
      notice.textContent = state.notice ?? "";
    }
    function renderIdentity() {
      for (const key of ["publisherId", "appName", "appId"]) identityValues[key].textContent = state.identity?.[key] || "未识别";
      identityValues.currency.textContent = state.identity?.currency || "尚未在真实底价字段确认";
      identityStatus.textContent = state.identityError || (state.identity ? "账号与应用已识别；提交前仍会逐页重新核对。" : "请进入目标应用，再识别当前账号。");
      capabilities.textContent = state.capabilities || "";
    }
    function renderChecks() {
      checklist.replaceChildren();
      for (const check of state.checks ?? []) {
        const li = element("li", void 0, check.ok ? "check-ok" : "check-bad");
        li.append(element("span", check.ok ? "✓" : "✕"), element("span", check.label));
        checklist.append(li);
      }
      if (!state.checks?.length) checklist.append(element("li", "先导入清单并运行预检。预检不点击创建。", "muted"));
    }
    function renderResults() {
      const batch = state.batch;
      const signature = batch ? JSON.stringify(batch) : "";
      if (signature === renderedBatch) return;
      renderedBatch = signature;
      resultTbody.replaceChildren();
      if (!batch) {
        batchMeta.textContent = "暂无批次";
        resultSummary.textContent = "";
        logs.textContent = "";
        return;
      }
      batchMeta.textContent = `批次 ${batch.id} · ${FORMAT_ZH[batch.format]} · ${{ draft: "待开始", running: "执行中", paused: "已暂停", stopping: "停止中，正在收集结果", done: "已结束" }[batch.phase]} · ${batch.execution === "single" ? "单页模式" : `并发 ${batch.concurrency}`}`;
      const counts = /* @__PURE__ */ new Map();
      for (const task of batch.tasks) {
        counts.set(STATUS_ZH[task.status], (counts.get(STATUS_ZH[task.status]) ?? 0) + 1);
        const tr = element("tr");
        const actual = task.actual;
        const badge = element("span", STATUS_ZH[task.status], `badge ${["success", "exists"].includes(task.status) ? "good" : ["failed", "uncertain", "created-unverified", "conflict"].includes(task.status) ? "bad" : ""}`);
        const status = element("td");
        status.append(badge);
        tr.append(element("td", String(task.line)), element("td", task.name), element("td", task.floor), element("td", actual?.floor ? `${actual.floor} ${actual.currency || "币种未确认"}` : "未读取"), status, element("td", actual?.unitId || "—"), element("td", task.reason || "—", "error-cell"));
        resultTbody.append(tr);
      }
      resultSummary.textContent = `共 ${batch.tasks.length} 行 · ${[...counts].map(([label, count]) => `${label} ${count}`).join(" · ")}`;
      const createdAt = Date.parse(batch.createdAt);
      const entries = batch.tasks.flatMap((task) => task.logs.map((log, index) => ({ ...log, name: task.name, line: task.line, interval: elapsedText(index ? Date.parse(task.logs[index - 1].at) : createdAt, Date.parse(log.at)), elapsed: elapsedText(createdAt, Date.parse(log.at)) })));
      entries.sort((a, b) => a.at.localeCompare(b.at));
      logs.textContent = entries.slice(-150).map((log) => `${safeLogText(log.at)} [${log.line} ${safeLogText(log.name)}] ${logStepLabel(log.step)} · 累计耗时 ${log.elapsed} / 本行上步间隔 ${log.interval}${log.message ? ` · ${safeLogText(log.message)}` : ""}`).join("\n");
    }
    collapse.addEventListener("click", () => {
      const collapsed = shell.classList.toggle("collapsed");
      collapse.textContent = collapsed ? "展开" : "收起";
      collapse.setAttribute("aria-expanded", String(!collapsed));
    });
    renderRows();
    renderChecks();
    renderIdentity();
    updateControls();
    return {
      getConfig,
      update(patch) {
        Object.assign(state, patch);
        if (patch.batch && isFrozen()) {
          format.value = patch.batch.format;
          concurrency.value = String(patch.batch.concurrency);
          execution.value = patch.batch.execution;
        }
        renderIdentity();
        renderNotice();
        renderChecks();
        renderResults();
        updateControls();
      },
      destroy() {
        host.remove();
      }
    };
  }

  // src/gm.ts
  var PREFIX = "abc:v1:";
  var uuid = () => crypto.randomUUID();
  var get = (key, fallback) => GM_getValue(PREFIX + key, fallback);
  function set(key, value) {
    GM_setValue(PREFIX + key, value);
    if (JSON.stringify(GM_getValue(PREFIX + key)) !== JSON.stringify(value)) throw new Error("GM 存储回读不一致，已阻止继续");
  }
  function listen(key, callback) {
    const id = GM_addValueChangeListener(PREFIX + key, callback);
    return () => GM_removeValueChangeListener(id);
  }
  async function tabState() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("GM_getTab 不可用，无法可靠识别执行标签页")), 5e3);
      GM_getTab((tab) => {
        clearTimeout(timer);
        resolve(tab || {});
      });
    });
  }
  async function holdLock(name) {
    if (!navigator.locks) throw new Error("当前环境不支持 Web Locks，无法保证主控互斥；已禁用创建");
    return new Promise((resolve, reject) => {
      navigator.locks.request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          reject(new Error("同一发布商账号已有活动主控；请在原主控继续或关闭原主控后恢复"));
          return;
        }
        return new Promise((release) => resolve(release));
      }).catch(reject);
    });
  }
  async function lockUnavailable(name) {
    if (!navigator.locks) return false;
    return navigator.locks.request(name, { ifAvailable: true }, (lock) => !lock);
  }
  function download(name, text, mime = "text/plain;charset=utf-8") {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 15e3);
  }
  function sameIdentity(a, b) {
    return a.publisherId === b.publisherId && a.appId === b.appId;
  }
  async function waitFor(read, timeout = 15e3) {
    const current = read();
    if (current !== void 0) return current;
    return new Promise((resolve, reject) => {
      let remove = () => {
      };
      const finish = () => {
        clearInterval(poll);
        clearTimeout(timer);
        remove();
      };
      const check = () => {
        try {
          const value = read();
          if (value !== void 0) {
            finish();
            resolve(value);
          }
        } catch (e) {
          finish();
          reject(e);
        }
      };
      const poll = setInterval(check, 400);
      const timer = setTimeout(() => {
        finish();
        reject(new Error("跨页通信等待超时；不会自动重派原任务"));
      }, timeout);
      remove = () => {
      };
    });
  }

  // src/protocol.ts
  function reportBelongs(report, task, workerId) {
    return !!report.assignmentId && task.workerId === workerId && report.workerId === workerId && report.assignmentId === task.assignmentId && report.taskId === task.id;
  }
  function mayRetry(task) {
    return task.status === "failed" && !task.intentAt && !task.actual?.unitId && task.attempts < 3;
  }
  function needsVerification(task) {
    return !!task.intentAt || ["uncertain", "created-unverified", "submitting", "verifying"].includes(task.status);
  }
  function canDispatch(batch, busy) {
    return batch.phase === "running" && busy < (batch.canaryPassed ? batch.concurrency : 1);
  }

  // src/worker.ts
  async function performJob(job, adapter, emit, permission) {
    const { batch, task, assignmentId, workerId } = job;
    const journalKey = "journal:" + assignmentId;
    const old = get(journalKey, void 0);
    const report = (r) => emit({ ...r, assignmentId, taskId: task.id });
    if (old) {
      if (old.state === "done" && old.report) {
        await report(old.report);
        return;
      }
      if (old.state === "intent") {
        await report({ type: "result", status: "uncertain", reason: "执行页在提交意图后恢复，禁止再次点击创建；请核验真实结果" });
        return;
      }
      if (job.kind === "create") {
        await report({ type: "error", status: "failed", reason: "执行页在填表期间恢复；已确认本分配没有提交意图，等待手动重试" });
        return;
      }
    }
    const checkIdentity = async () => {
      const identity = await adapter.identify();
      if (!sameIdentity(identity, batch.identity)) throw Object.assign(new Error("发布商或应用与批次不一致"), { fatal: true });
    };
    const checkpoint = async () => {
      await permission();
      await checkIdentity();
    };
    let intent = !!task.intentAt || job.kind === "verify";
    let latestActual = task.actual;
    try {
      await checkIdentity();
      if (job.kind === "verify") {
        await adapter.home();
        const found2 = await adapter.lookup(batch.identity, task.name);
        const classification2 = classifyLookup(found2, batch.identity, batch.format, task.name, task.floor);
        const actual2 = classification2.actual;
        const exactKnownId = !!task.actual?.unitId && actual2?.unitId === task.actual.unitId;
        if (task.actual?.unitId && !exactKnownId) {
          await report({ type: "result", status: "created-unverified", actual: task.actual, reason: "同名查询结果与已取得广告位ID不一致，保留原ID等待核验" });
          return;
        }
        await report({ type: "result", status: classification2.status === "exists" ? exactKnownId ? "success" : "exists" : task.actual?.unitId ? "created-unverified" : "uncertain", actual: actual2 || task.actual, reason: classification2.status === "pending" ? "暂未找到记录，不能证明创建失败；继续保留待核验" : classification2.reason });
        return;
      }
      await checkpoint();
      const found = await adapter.lookup(batch.identity, task.name);
      const classification = classifyLookup(found, batch.identity, batch.format, task.name, task.floor);
      if (classification.status !== "pending") {
        await report({ type: "result", ...classification });
        return;
      }
      set(journalKey, { assignmentId, taskId: task.id, batchId: batch.id, state: "filling" });
      await report({ type: "stage", stage: "filling" });
      await adapter.prepare(batch.identity, batch.format, task.name, task.floor, checkpoint);
      await checkpoint();
      intent = true;
      await report({ type: "intent" });
      await checkpoint();
      set(journalKey, { assignmentId, taskId: task.id, batchId: batch.id, state: "intent" });
      intent = true;
      await adapter.submit();
      await report({ type: "stage", stage: "verifying" });
      const actual = await adapter.verify(batch.identity, batch.format, task.name, task.floor);
      latestActual = actual;
      await report({ type: "result", status: actual.verified ? "success" : "created-unverified", actual, reason: actual.verified ? "保存后配置核验一致" : "已取得广告位 ID，配置尚未全部核验" });
    } catch (error) {
      const e = error;
      const completed = get(journalKey, void 0);
      if (completed?.state === "done" && completed.report) return;
      const actual = e.actual || latestActual;
      const status = actual?.unitId ? "created-unverified" : intent ? "uncertain" : "failed";
      await report({ type: "error", status, reason: e.message, actual, fatal: e.fatal });
    }
  }
  async function runWorker(workerId, adapter) {
    await holdLock("admob-batch-worker:" + workerId);
    const cmdKey = "command:" + workerId, outKey = "report:" + workerId;
    const status = document.createElement("div");
    status.id = "abc-worker-status";
    status.style.cssText = "position:fixed;bottom:8px;right:8px;z-index:2147483647;padding:10px;background:#152238;color:white;font:14px sans-serif;max-width:380px";
    status.textContent = "AdMob 批量执行页：等待主控。不要手动修改此页。";
    document.body.append(status);
    let running = false, seen = "";
    let activeJob;
    let notificationReceived = false;
    listen(cmdKey, () => {
      notificationReceived = true;
      void tick();
    });
    async function emit(data) {
      const r = { ...data, id: uuid(), at: Date.now(), workerId };
      if (data.assignmentId && ["result", "error"].includes(data.type)) {
        const prior = get("journal:" + data.assignmentId, void 0);
        const batchId = prior?.batchId || activeJob?.batch.id;
        if (!batchId) throw new Error("终态记录缺少批次归属，已阻止覆盖");
        set("journal:" + data.assignmentId, { assignmentId: data.assignmentId, taskId: data.taskId, batchId, state: "done", report: r });
      }
      set(outKey, r);
      status.textContent = "AdMob 批量执行页：" + (data.reason || data.stage || data.type);
      await waitFor(() => get(cmdKey, { seq: 0 }).ack === r.id ? true : void 0, 6e4);
    }
    async function tick() {
      if (running) return;
      const cmd = get(cmdKey, { seq: 0 });
      if (cmd.probe && seen !== cmd.probe.nonce) {
        running = true;
        seen = cmd.probe.nonce;
        try {
          let identity, error;
          try {
            identity = await adapter.identify();
          } catch (e) {
            error = e.message;
          }
          set(outKey, { id: uuid(), at: Date.now(), workerId, type: "hello", probe: { nonce: cmd.probe.nonce, locked: await lockUnavailable(cmd.probe.lockName), identity, error, notifications: notificationReceived } });
        } finally {
          running = false;
        }
        return;
      }
      if (!cmd.job || seen === cmd.job.assignmentId) return;
      const job = cmd.job;
      const batch = get("batch:" + job.batch.identity.publisherId + ":" + job.batch.identity.appId + ":" + job.batch.id, void 0);
      if (!batch || batch.controllerId !== job.batch.controllerId || !["running", "paused", "stopping"].includes(batch.phase)) return;
      seen = job.assignmentId;
      running = true;
      activeJob = job;
      try {
        await performJob(job, adapter, emit, async () => {
          const latest = get(cmdKey, { seq: 0 });
          const control = get("batch:" + job.batch.identity.publisherId + ":" + job.batch.identity.appId + ":" + job.batch.id, job.batch);
          if (latest.job?.assignmentId !== job.assignmentId || control.controllerId !== job.batch.controllerId) throw Object.assign(new Error("任务归属已变更，停止当前执行"), { fatal: true });
          if (latest.blocked) throw new Error(latest.blocked);
          if (control.phase !== "running") throw new Error(control.phase === "stopping" ? "批次已停止，未发起提交" : "批次已暂停，在提交前安全停止");
          const report = get(outKey, void 0);
          if (report?.type === "intent" && (!latest.grant || latest.grant.assignmentId !== job.assignmentId || latest.grant.expires < Date.now())) throw new Error("提交许可缺失或过期，未点击创建");
        });
      } catch (e) {
        status.textContent = "执行页通信中断：" + e.message + "。保持此页，返回主控恢复核验。";
      } finally {
        running = false;
      }
    }
    setInterval(() => void tick(), 1300);
    await tick();
  }

  // src/controller.ts
  var Controller = class {
    adapter;
    id = uuid();
    panel;
    identity;
    batch;
    slots = /* @__PURE__ */ new Map();
    lockRelease;
    lockedPublisher = "";
    tickBusy = false;
    actionBusy = false;
    preflightSignature = "";
    lastSubmit = 0;
    lastIdentityCheck = 0;
    errors = 0;
    localBusy = false;
    constructor(adapter) {
      this.adapter = adapter;
    }
    async init() {
      this.panel = mountPanel({
        identify: () => this.action(async () => {
          await this.identify();
          if (!this.batch) await this.load();
        }),
        preflight: (c) => this.action(() => this.preflight(c)),
        start: (c) => this.action(() => this.start(c)),
        pause: () => this.pause("用户暂停"),
        resume: () => this.action(() => this.resume()),
        stop: () => this.stop(),
        retry: () => this.action(() => this.retry()),
        verify: () => this.action(() => this.verify()),
        degrade: async () => {
          this.requireBatch();
          await this.pause("用户降级单页");
          this.batch.execution = "single";
          this.batch.concurrency = 1;
          this.save();
          this.notice("已降级单页。旧执行页仍保留并继续收集结果；点击继续后，后续任务在当前页处理。");
        },
        export: async (filter) => {
          this.requireBatch();
          download("AdMob-" + this.batch.id + "-" + filter + ".csv", exportCsv(this.batch, filter), "text/csv;charset=utf-8");
        },
        copy: async () => {
          this.requireBatch();
          GM_setClipboard(copyPairs(this.batch), "text");
          this.notice("已复制有真实广告位 ID 的名称与 ID");
        },
        diagnostics: async () => this.diagnostics(),
        probe: () => this.action(async () => {
          await this.identify();
          await this.acquire();
          await this.probe();
        })
      });
      this.panel.update({ capabilities: "多页模式需通过 GM 存储、通知、同会话身份及 Web Locks 跨页检查。真实 AdMob / Tampermonkey 流程尚未验收。" });
      try {
        await this.identify();
        await this.load();
      } catch (e) {
        this.panel.update({ identityError: e.message });
      }
      setInterval(() => void this.tick().catch((e) => this.pause("调度异常：" + e.message)), 1200);
      window.addEventListener("beforeunload", () => {
        if (this.batch?.phase === "running") {
          this.batch.phase = "paused";
          this.save();
        }
      });
    }
    async action(fn) {
      if (this.actionBusy) throw new Error("上一操作仍在进行");
      this.actionBusy = true;
      this.panel.update({ busy: true });
      try {
        await fn();
      } finally {
        this.actionBusy = false;
        this.panel.update({ busy: false });
      }
    }
    notice(text) {
      this.panel.update({ notice: text });
    }
    requireBatch() {
      if (!this.batch) throw new Error("当前没有批次，请先预检");
    }
    key(batch = this.batch) {
      return "batch:" + batch.identity.publisherId + ":" + batch.identity.appId + ":" + batch.id;
    }
    save() {
      if (this.batch) {
        set(this.key(), this.batch);
        set("latest:" + this.batch.identity.publisherId + ":" + this.batch.identity.appId, this.batch.id);
        this.panel.update({ batch: this.batch });
      }
    }
    async identify() {
      const identity = await this.adapter.identify();
      if (this.batch && !sameIdentity(identity, this.batch.identity) && this.batch.phase !== "done") await this.pause("主控账号或应用已切换；批次保留在原账号和应用");
      this.identity = identity;
      this.panel.update({ identity, identityError: "" });
    }
    async acquire() {
      if (!this.identity) throw new Error("先识别当前账号和应用");
      if (this.batch && !["draft", "done"].includes(this.batch.phase) && !sameIdentity(this.identity, this.batch.identity)) throw new Error("原批次尚未结束，请返回其原发布商和应用；保留原账号主控锁及执行归属");
      if (this.lockRelease && this.lockedPublisher === this.identity.publisherId) return;
      if (this.lockRelease) {
        this.lockRelease();
        this.lockRelease = void 0;
        this.lockedPublisher = "";
      }
      this.lockRelease = await holdLock("admob-batch-controller:" + this.identity.publisherId);
      this.lockedPublisher = this.identity.publisherId;
      const probeKey = "storage-probe:" + this.id;
      set(probeKey, { nonce: this.id });
      if (get(probeKey, { nonce: "" }).nonce !== this.id) throw new Error("GM 持久化检查失败");
      GM_deleteValue("abc:v1:" + probeKey);
    }
    async load() {
      if (!this.identity) return;
      const id = get("latest:" + this.identity.publisherId + ":" + this.identity.appId, void 0);
      if (!id) return;
      const batch = get("batch:" + this.identity.publisherId + ":" + this.identity.appId + ":" + id, void 0);
      if (!batch || batch.schema !== 1) return;
      await this.acquire();
      this.batch = batch;
      batch.controllerId = this.id;
      if (batch.phase !== "done") batch.phase = batch.stopRequestedAt ? "stopping" : batch.confirmedAt ? "paused" : "draft";
      for (const task of batch.tasks) {
        if (["filling", "submitting", "verifying"].includes(task.status)) recoverTask(task);
        if (batch.phase !== "done" && task.assignmentId && task.workerId && !["success", "exists", "conflict", "failed", "stopped"].includes(task.status)) {
          this.slots.set(task.workerId, { id: task.workerId, busy: task.assignmentId, since: Date.now() });
        }
      }
      this.save();
      this.notice(batch.phase === "draft" ? "已恢复未确认草稿。请重新预检，检查清单后点击开始创建。" : "已恢复历史批次并暂停。提交过或结果不确定的任务只允许先核验；点击继续才会派发尚未提交的任务。");
    }
    signature(config) {
      return JSON.stringify([config.format, config.concurrency, config.execution, config.rows, this.identity?.publisherId, this.identity?.appId]);
    }
    async preflight(config) {
      if (this.batch && this.batch.phase !== "done" && this.batch.phase !== "draft") throw new Error("请先处理当前批次；不能覆盖未完成批次");
      if (!config.rows.length || config.rows.some((r) => r.errors.length)) throw new Error("请先修正两列输入中的全部行级错误");
      for (const [id, slot] of this.slots) if (!slot.busy) {
        slot.tab?.close();
        this.slots.delete(id);
      }
      await this.identify();
      await this.acquire();
      const active = get("active:" + this.identity.publisherId, void 0);
      if (active && active.id !== this.batch?.id) {
        const old = get("batch:" + this.identity.publisherId + ":" + active.appId + ":" + active.id, void 0);
        if (old && old.phase !== "done") throw new Error("此发布商还有未完成批次，请进入原应用恢复：" + active.appId);
      }
      const batch = createBatch(config.rows, this.identity, config.format, config.concurrency, config.execution, location.href, this.id);
      this.batch = batch;
      this.save();
      for (const task of batch.tasks) {
        this.notice("预检查重：" + task.name);
        const lookup = await this.adapter.lookup(batch.identity, task.name);
        const classification = classifyLookup(lookup, batch.identity, batch.format, task.name, task.floor);
        task.actual = classification.actual;
        transition(task, classification.status, classification.reason);
        this.save();
      }
      await this.adapter.home();
      await this.identify();
      if (config.execution === "tabs") await this.probe();
      this.preflightSignature = this.signature(config);
      const pending = batch.tasks.filter((t) => t.status === "pending").length;
      this.panel.update({ ready: pending > 0, checks: [{ label: "已固定发布商及应用", ok: true }, { label: "两列输入有效", ok: true }, { label: "已完成已有广告单元查重；不完整项单独阻止创建", ok: true }, { label: "执行时逐条核验真实 USD、格式、手动底价和金额", ok: true }, { label: config.execution === "tabs" ? "跨页互斥、通知及账号检查已通过" : "单页执行；已取得账号主控锁", ok: true }] });
      this.notice("预检不创建广告位。待创建 " + pending + " 条；冲突与待核验项不会提交。实际表单的币种、金额限制会在提交前再次检查。");
    }
    async probe() {
      if (!this.identity) throw new Error("未识别账号");
      const reusable = [...this.slots.values()].find((s) => !s.busy && s.probePassed && !s.tab?.closed && s.identity && sameIdentity(s.identity, this.identity) && s.batchId === this.batch?.id);
      if (reusable) return reusable;
      const nonce = uuid(), lockName = "admob-batch-probe:" + nonce;
      const release = await holdLock(lockName);
      const slot = { id: uuid(), since: Date.now(), identity: this.identity, batchId: this.batch?.id };
      this.slots.set(slot.id, slot);
      const url = new URL(this.batch?.sourceUrl || location.href);
      url.searchParams.set("__admob_batch_worker", slot.id);
      set("command:" + slot.id, { seq: 1, probe: { nonce, lockName } });
      slot.tab = GM_openInTab(url.href, { active: false, insert: true, setParent: true });
      try {
        await waitFor(() => {
          const r = get("report:" + slot.id, void 0);
          return r?.probe?.nonce === nonce ? r : void 0;
        }, 25e3);
        const challenge = uuid();
        set("command:" + slot.id, { seq: 2, probe: { nonce: challenge, lockName } });
        const report = await waitFor(() => {
          const r = get("report:" + slot.id, void 0);
          return r?.probe?.nonce === challenge ? r : void 0;
        }, 15e3);
        if (!report.probe?.locked || !report.probe.notifications || !report.probe.identity || !sameIdentity(report.probe.identity, this.identity)) throw new Error(report.probe?.error || "跨页锁作用域、GM通知或登录账号检查未通过；请改为单页模式。");
        slot.probePassed = true;
        slot.lastReport = report.id;
        this.notice("当前会话跨页能力检查通过；尚未创建任何广告位。");
        return slot;
      } catch (error) {
        slot.tab?.close();
        this.slots.delete(slot.id);
        throw error;
      } finally {
        release();
      }
    }
    async start(config) {
      this.requireBatch();
      await this.identify();
      await this.acquire();
      if (this.batch.phase !== "draft" || this.preflightSignature !== this.signature(config)) throw new Error("输入或账号已变化，请重新预检");
      this.batch.confirmedAt = (/* @__PURE__ */ new Date()).toISOString();
      this.batch.phase = "running";
      set("active:" + this.batch.identity.publisherId, { appId: this.batch.identity.appId, id: this.batch.id });
      this.save();
      this.notice("批次已开始。先执行一条并核验，通过后再增加并发。");
    }
    async pause(reason) {
      if (this.batch?.phase === "draft") {
        this.preflightSignature = "";
        this.panel.update({ ready: false });
      }
      if (this.batch?.phase === "running") {
        this.batch.phase = "paused";
        this.save();
      }
      this.notice(reason + "。停止派发，已提交任务继续收集结果。");
    }
    async stop() {
      this.requireBatch();
      this.batch.stopRequestedAt = (/* @__PURE__ */ new Date()).toISOString();
      this.batch.phase = "stopping";
      this.preflightSignature = "";
      this.panel.update({ ready: false });
      for (const task of this.batch.tasks) if (task.status === "pending" && !task.assignmentId) transition(task, "stopped", "用户停止");
      this.save();
      this.notice("已停止新建；执行页保持打开，已提交任务继续核验。");
    }
    async resume() {
      this.requireBatch();
      await this.identify();
      await this.acquire();
      if (this.batch.stopRequestedAt) throw new Error("批次已停止；先核验已提交结果，或明确点击重试尚未提交的失败项");
      if (!this.batch.confirmedAt) throw new Error("草稿尚未确认开始；请重新预检，检查清单后点击开始创建");
      if (!sameIdentity(this.identity, this.batch.identity)) throw new Error("请回到批次原发布商与原应用");
      if (this.batch.phase === "stopping") throw new Error("批次已停止；仅可核验已有提交或重试明确失败项");
      this.batch.phase = "running";
      this.errors = 0;
      this.save();
    }
    async retry() {
      this.requireBatch();
      if (this.batch.phase === "running") throw new Error("请先暂停后重试明确失败项");
      if ([...this.slots.values()].some((slot) => slot.busy)) throw new Error("旧执行页尚未收齐结果，请先保留原页并完成收集或核验");
      let count = 0;
      for (const t of this.batch.tasks) if (mayRetry(t)) {
        t.assignmentId = void 0;
        t.workerId = void 0;
        transition(t, "pending", "用户重试：尚无提交意图");
        count++;
      }
      if (count > 0) {
        delete this.batch.stopRequestedAt;
        this.batch.phase = "paused";
      }
      this.save();
      this.notice("已准备 " + count + " 条安全重试项（最多三次，按尝试次数退避）；" + (count > 0 ? "点击继续后执行。" : "保持原批次状态。"));
    }
    async verify() {
      this.requireBatch();
      await this.identify();
      await this.acquire();
      if (this.batch.phase === "running") await this.pause("核验不确定结果");
      const tasks = this.batch.tasks.filter((t) => needsVerification(t) && !["success", "exists"].includes(t.status));
      if (!tasks.length) {
        this.notice("没有待核验的提交");
        return;
      }
      if (this.localBusy) throw new Error("单页执行仍在收集结果，请稍后核验");
      this.localBusy = true;
      try {
        for (const task of tasks) {
          if (task.status !== "verifying") transition(task, "verifying", "只读核验平台真实结果");
          try {
            const lookup = await this.adapter.lookup(this.batch.identity, task.name);
            const c = classifyLookup(lookup, this.batch.identity, this.batch.format, task.name, task.floor);
            if (c.status === "exists") {
              const prior = task.actual?.unitId;
              if (prior && c.actual?.unitId !== prior) {
                transition(task, "created-unverified", "同名条目 ID 与已取得 ID 不符，保留原记录等待人工核验");
                this.save();
                continue;
              }
              task.actual = c.actual;
              transition(task, prior ? "success" : "exists", prior ? "已按已知 ID 核验保存配置" : "发现同名同配置广告位；无法判定是否本批创建，记录为已存在");
              if (task.workerId) {
                const slot = this.slots.get(task.workerId);
                if (slot) {
                  const command = get("command:" + slot.id, { seq: 0 });
                  set("command:" + slot.id, { seq: command.seq + 1, blocked: "此任务已由主控完成只读核验，原创建分配已撤销" });
                  slot.busy = void 0;
                  slot.probePassed = false;
                }
              }
            } else {
              task.reason = c.status === "pending" ? "当前列表尚未出现记录，不能证明创建失败；禁止自动重建" : c.reason;
              transition(task, task.actual?.unitId ? "created-unverified" : "uncertain", task.reason);
            }
            this.save();
          } catch (error) {
            if (task.status === "verifying") transition(task, task.actual?.unitId ? "created-unverified" : "uncertain", "只读核验失败：" + error.message + "；禁止自动重新创建");
            this.save();
            if (error.fatal) break;
          }
        }
        await this.adapter.home();
      } finally {
        this.localBusy = false;
        this.save();
      }
    }
    async dispatch(slot, task) {
      const batch = this.batch;
      task.workerId = slot.id;
      task.assignmentId = uuid();
      task.attempts++;
      slot.busy = task.assignmentId;
      slot.since = Date.now();
      const job = { batch: structuredClone(batch), task: structuredClone(task), assignmentId: task.assignmentId, workerId: slot.id, kind: "create" };
      this.save();
      const priorCommand = get("command:" + slot.id, { seq: 0 });
      set("command:" + slot.id, { seq: priorCommand.seq + 1, job, ack: priorCommand.ack });
      if (batch.execution === "single") {
        this.localBusy = true;
        void performJob(job, this.adapter, async (data) => {
          await this.handle(slot, { ...data, id: uuid(), at: Date.now(), workerId: slot.id });
        }, async () => {
          if (this.batch?.phase !== "running") throw new Error("任务已暂停或停止，在提交前安全停下");
          const command = get("command:" + slot.id, { seq: 0 });
          if (command.blocked) throw new Error(command.blocked);
          if (task.intentAt && (!command.grant || command.grant.expires < Date.now())) throw new Error("提交许可已过期，未点击创建");
        }).catch((e) => this.pause("单页通信或存储异常：" + e.message)).finally(() => {
          this.localBusy = false;
        });
      }
    }
    async handle(slot, r) {
      const task = this.batch?.tasks.find((t) => t.assignmentId === r.assignmentId);
      if (!task || !reportBelongs(r, task, slot.id) || slot.lastReport === r.id) return;
      const cmd = get("command:" + slot.id, { seq: 0 });
      if (cmd.ack === r.id) {
        slot.lastReport = r.id;
        return;
      }
      if (["success", "exists"].includes(task.status)) {
        cmd.ack = r.id;
        cmd.seq++;
        set("command:" + slot.id, cmd);
        slot.lastReport = r.id;
        if (slot.busy === r.assignmentId) slot.busy = void 0;
        return;
      }
      if (r.type === "intent") {
        const previous = Math.max(this.lastSubmit, get("lastSubmit:" + this.batch.identity.publisherId, 0));
        const delay = Math.max(0, 2500 - (Date.now() - previous));
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        cmd.grant = void 0;
        cmd.blocked = void 0;
        try {
          const current = await this.adapter.identify();
          if (!sameIdentity(current, this.batch.identity)) await this.pause("主控账号或应用发生变化");
        } catch (error) {
          await this.pause("主控无法确认当前账号：" + error.message);
        }
        if (this.batch.phase !== "running") cmd.blocked = "批次已暂停或停止，主控拒绝提交许可";
        else if (task.intentAt) cmd.blocked = "本分配已有提交意图，禁止重复许可";
        else {
          task.intentAt = (/* @__PURE__ */ new Date()).toISOString();
          transition(task, "submitting", "提交意图已持久化");
          this.save();
          cmd.grant = { assignmentId: task.assignmentId, expires: Date.now() + 1e4 };
          this.lastSubmit = Date.now();
          set("lastSubmit:" + this.batch.identity.publisherId, this.lastSubmit);
        }
      } else if (r.type === "stage") {
        if (r.stage === "filling" && task.status === "pending") transition(task, "filling");
        if (r.stage === "verifying" && ["submitting", "uncertain", "created-unverified"].includes(task.status)) transition(task, "verifying");
      } else if (r.type === "result" || r.type === "error") {
        const idMismatch = !!task.actual?.unitId && !!r.actual?.unitId && task.actual.unitId !== r.actual.unitId;
        if (r.actual?.unitId && !idMismatch) task.actual = { ...task.actual, ...r.actual };
        let status = r.status || "uncertain";
        if (idMismatch) status = "created-unverified";
        if (r.type === "error" && status === "uncertain" && !task.intentAt && !task.actual?.unitId && cmd.blocked && !cmd.grant) status = "failed";
        if (task.intentAt && status === "failed") status = task.actual?.unitId ? "created-unverified" : "uncertain";
        if (status === "success" && (task.actual?.format !== this.batch.format || !sameIdentity(task.actual, this.batch.identity))) status = "created-unverified";
        if (["success", "exists"].includes(status) && ["submitting", "uncertain", "created-unverified"].includes(task.status)) transition(task, "verifying", "收集保存后的核验结果");
        if (status === "created-unverified" && ["pending", "filling"].includes(task.status)) transition(task, "uncertain", "取得ID，配置待核验");
        transition(task, status, idMismatch ? "执行页返回的ID与已取得ID不符；保留原ID等待核验" : r.reason || "执行页已返回");
        slot.busy = void 0;
        if (status === "success") {
          this.batch.canaryPassed = true;
          this.errors = 0;
        } else if (status === "exists") this.errors = 0;
        else if (["uncertain", "created-unverified"].includes(status)) {
          await this.pause("存在提交结果或配置不确定项，先核验再继续");
        } else if (status === "failed") this.errors++;
        if (r.fatal || this.errors >= 2) await this.pause(r.fatal ? "登录、账号、权限、币种或公共页面结构异常" : "连续两条失败，已暂停；可核验后改为单页重试");
      }
      this.save();
      cmd.ack = r.id;
      cmd.seq++;
      set("command:" + slot.id, cmd);
      slot.lastReport = r.id;
    }
    async tick() {
      if (this.tickBusy || this.actionBusy || !this.batch) return;
      this.tickBusy = true;
      try {
        for (const slot of this.slots.values()) {
          const r = get("report:" + slot.id, void 0);
          if (r && r.id !== slot.lastReport && r.type !== "hello") await this.handle(slot, r);
          if (slot.busy && Date.now() - slot.since > 12e4) {
            const t = this.batch.tasks.find((t2) => t2.assignmentId === slot.busy);
            if (t && ["pending", "filling", "submitting", "verifying"].includes(t.status)) {
              transition(t, t.actual?.unitId ? "created-unverified" : "uncertain", "执行页长时间无结果，可能被后台冻结；保留归属，不重派");
              await this.pause("执行页超时，保留原执行页并先核验");
              this.save();
            }
          }
        }
        if (this.batch.phase === "stopping" && ![...this.slots.values()].some((s) => s.busy)) {
          const unresolved = this.batch.tasks.some((t) => !["success", "exists"].includes(t.status) && !!t.intentAt || ["created-unverified", "submitting", "verifying"].includes(t.status));
          this.batch.phase = unresolved ? "paused" : "done";
          this.save();
        }
        if (this.batch.phase !== "running") return;
        if (Date.now() - this.lastIdentityCheck > 5e3 && !this.localBusy) {
          this.lastIdentityCheck = Date.now();
          try {
            await this.identify();
          } catch (e) {
            await this.pause("当前身份无法确认：" + e.message);
            return;
          }
        }
        const busy = [...this.slots.values()].filter((s) => s.busy).length;
        if (canDispatch(this.batch, busy)) {
          const task = this.batch.tasks.find((t) => t.status === "pending" && !t.assignmentId && Date.now() - Date.parse(t.logs.at(-1)?.at || this.batch.createdAt) > Math.max(0, t.attempts - 1) * 3e3);
          if (task) {
            let slot = [...this.slots.values()].find((s) => !s.busy && (this.batch.execution === "single" ? s.id.startsWith("single:") : s.probePassed && s.batchId === this.batch.id && !!s.identity && sameIdentity(s.identity, this.batch.identity)) && !s.tab?.closed);
            if (!slot) {
              if (this.batch.execution === "single") {
                slot = { id: "single:" + this.id, since: Date.now() };
                this.slots.set(slot.id, slot);
              } else slot = await this.probe();
            }
            if (this.batch.phase === "running" && task.status === "pending" && !task.assignmentId) await this.dispatch(slot, task);
          }
        }
        if (!this.batch.tasks.some((t) => ["pending", "filling", "submitting", "verifying"].includes(t.status)) && ![...this.slots.values()].some((s) => s.busy)) {
          this.batch.phase = this.batch.tasks.some((t) => ["uncertain", "created-unverified"].includes(t.status)) ? "paused" : "done";
          this.save();
          this.notice(this.batch.phase === "done" ? "批次执行结束，请核对并导出结果。" : "存在待核验结果，禁止自动重建。");
        }
      } finally {
        this.tickBusy = false;
      }
    }
    diagnostics() {
      const data = { schema: 1, at: (/* @__PURE__ */ new Date()).toISOString(), userAgent: navigator.userAgent, origin: location.origin, capabilities: { webLocks: !!navigator.locks, gmStorage: typeof GM_getValue === "function", gmNotifications: typeof GM_addValueChangeListener === "function", gmTabs: typeof GM_openInTab === "function" }, phase: this.batch?.phase, counts: this.batch?.tasks.reduce((a, t) => (a[t.status] = (a[t.status] || 0) + 1, a), {}), workers: [...this.slots.values()].map((s) => ({ busy: !!s.busy, probePassed: !!s.probePassed, closed: s.tab?.closed })), page: this.adapter.diagnostics() };
      download("AdMob-脱敏诊断-" + (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-") + ".json", JSON.stringify(data, null, 2), "application/json;charset=utf-8");
    }
  };

  // src/main.ts
  async function main() {
    if (window.top !== window.self || document.getElementById("abc-panel-host") || document.getElementById("abc-batch-creator") || document.getElementById("abc-worker-status")) return;
    const state = await tabState();
    const url = new URL(location.href), marker = url.searchParams.get("__admob_batch_worker");
    if (marker && /^[\w-]{20,80}$/.test(marker)) {
      state.abcWorkerId = marker;
      GM_saveTab(state);
      url.searchParams.delete("__admob_batch_worker");
      history.replaceState(history.state, "", url.href);
    }
    if (!state.abcTabId) {
      state.abcTabId = uuid();
      GM_saveTab(state);
    }
    const adapter = new AdMobAdapter();
    if (typeof state.abcWorkerId === "string") await runWorker(state.abcWorkerId, adapter);
    else await new Controller(adapter).init();
  }
  void main().catch((error) => {
    const box = document.createElement("div");
    box.id = "abc-batch-creator";
    box.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:16px;background:#fff1f0;border:1px solid #cc3333;color:#8b1111;max-width:420px;font:14px sans-serif";
    box.textContent = "AdMob Batch Creator 启动受阻：" + error.message;
    document.body.append(box);
  });
})();

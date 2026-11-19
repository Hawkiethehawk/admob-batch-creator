// ==UserScript==
// @name         AdMob Batch Creator
// @namespace    local.admob-batch-creator
// @version      0.5.10
// @description  中文 AdMob 六种格式批量创建、并发开页、串行、合作平台出价及核验导出
// @match        https://admob.google.com/*
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
// @grant        window.close
// ==/UserScript==

"use strict";
(() => {
  // src/types.ts
  var STATUS_ZH = { pending: "待执行", filling: "填表中", submitting: "提交中", verifying: "核验中", success: "成功", failed: "明确失败", uncertain: "结果不确定", "created-unverified": "已创建但配置待核验", exists: "已存在", conflict: "冲突", stopped: "已停止" };
  var FORMAT_ZH = { interstitial: "插页式", "app-open": "开屏", native: "信息流（原生高级广告）", banner: "横幅", rewarded: "激励广告", "rewarded-interstitial": "插页式激励广告" };
  var standardMedia = ["文字、图片和富媒体", "视频"];
  var MEDIA_DEFAULTS = {
    banner: standardMedia,
    interstitial: standardMedia,
    "app-open": standardMedia,
    native: ["图片", "视频"],
    rewarded: ["视频", "广告连播", "互动式"],
    "rewarded-interstitial": ["视频", "互动式"]
  };
  var REWARD_DEFAULT = { amount: "1", item: "Reward" };
  var MODE_ZH = { manual: "人工指定底价", auto: "由 Google 优化", disabled: "已停用" };

  // src/history.ts
  function summarizeBatch(batch) {
    return {
      id: batch.id,
      format: batch.format,
      mode: batch.mode ?? "manual",
      phase: batch.phase,
      createdAt: batch.createdAt,
      startedAt: batch.startedAt ?? batch.confirmedAt,
      completedAt: batch.completedAt,
      total: batch.tasks.length,
      succeeded: batch.tasks.filter((task) => ["success", "exists"].includes(task.status)).length
    };
  }
  function batchElapsed(batch, now = Date.now()) {
    if (!batch.startedAt || !batch.completedAt && batch.phase === "done") return "未知";
    const start = Date.parse(batch.startedAt), end = batch.completedAt ? Date.parse(batch.completedAt) : now;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "未知";
    return `${((end - start) / 1e3).toFixed(1)} 秒${batch.completedAt ? "" : "（进行中）"}`;
  }

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
    const manual = !options.mode || options.mode === "manual";
    const maxNameLength = Math.min(MAX_NAME_LENGTH, options.maxNameLength ?? MAX_NAME_LENGTH);
    if (!Number.isInteger(maxNameLength) || maxNameLength < 1) throw new Error("名称长度限制无效");
    const cleaned = text.replace(/^\uFEFF/, "");
    const records = readRecords(cleaned, detectDelimiter(cleaned));
    const headerName = /^(广告位名称|广告单元名称|名称|ad\s*unit\s*name)$/i;
    const headerFloor = /^(底价|底价usd|底价[（(]usd\s*[/／]\s*千次展示[）)]|floor(?:\s*usd)?)$/i;
    if (records[0]?.fields.length === 2 && headerName.test(records[0].fields[0].trim()) && headerFloor.test(records[0].fields[1].trim()) && !records[0].errors.length) records.shift();
    else if (!manual && records[0]?.fields.length === 1 && headerName.test(records[0].fields[0].trim()) && !records[0].errors.length) records.shift();
    const rows = records.map((record) => {
      const [name = "", rawFloor = ""] = record.fields;
      const errors = [...new Set(record.errors)];
      if (record.fields.length !== 2 && (manual || record.fields.length !== 1)) errors.push(`应为${manual ? "两列" : "名称一列或名称、底价两列"}，实际为 ${record.fields.length} 列`);
      if (!name.trim()) errors.push("广告位名称不能为空");
      if (name !== name.trim()) errors.push("名称前后存在空白，请明确修正");
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(name)) errors.push("名称包含不支持的控制字符");
      if (name.length > maxNameLength) errors.push(`名称超过限制 ${maxNameLength} 个字符，未截断`);
      let floor = rawFloor;
      if (manual) {
        if (!rawFloor.trim()) errors.push("缺失底价");
        else {
          try {
            floor = normalizeDecimal(rawFloor);
          } catch (error) {
            errors.push(error.message);
          }
        }
      }
      return { line: record.line, name, floor, errors };
    });
    return rows;
  }
  function matchesFloor(actual, floor, mode = "manual") {
    return actual.mode === mode && (mode !== "manual" || actual.currency === "USD" && actual.floor !== void 0 && decimalEqual(actual.floor, floor));
  }
  function matchesRequestedConfiguration(actual, floor, mode = "manual", partnerBidding = false) {
    return partnerBidding ? actual.partnerBidding === true && actual.mode === "partner-bidding" : actual.partnerBidding !== true && matchesFloor(actual, floor, mode);
  }
  function classifyLookup(lookup, identity, format, name, floor, mode = "manual") {
    if (!lookup.complete) return { status: "uncertain", reason: lookup.reason || "已有广告位读取不完整，不能判定不存在" };
    const matches = lookup.matches.filter((match) => match.name === name);
    if (matches.length === 0) return { status: "pending", reason: "已完整检查，未发现同名广告位" };
    if (matches.length > 1) return { status: "uncertain", reason: "存在多个同名广告位，需人工核验" };
    const actual = matches[0];
    if (actual.publisherId !== identity.publisherId || actual.appId !== identity.appId) return { status: "uncertain", reason: "同名结果所属发布商或应用无法确认", actual };
    if (!actual.unitId || !/^ca-app-pub-\d{16}\/\d{10}$/.test(actual.unitId) || !actual.unitId.startsWith(`ca-app-${identity.publisherId}/`)) return { status: "uncertain", reason: "未获得可核对的真实广告位 ID", actual };
    if (actual.format && actual.format !== format) return { status: "conflict", reason: "同名广告位的广告格式不同", actual };
    if (actual.mode && actual.mode !== mode) return { status: "conflict", reason: "同名广告位的底价模式不同", actual };
    if (mode === "manual" && actual.currency && actual.currency !== "USD") return { status: "conflict", reason: "同名广告位底价币种不是 USD", actual };
    if (mode === "manual" && actual.floor !== void 0 && !decimalEqual(actual.floor, floor)) return { status: "conflict", reason: "同名广告位底价金额不同或无法解释", actual };
    if (!actual.verified || actual.format !== format || !matchesFloor(actual, floor, mode)) return { status: "uncertain", reason: "同名广告位配置未完整核验", actual };
    return { status: "exists", reason: "已有同名、同格式、同底价配置广告位，跳过创建", actual };
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
      if (!actual?.verified || !actual.unitId || !/^ca-app-pub-\d{16}\/\d{10}$/.test(actual.unitId) || !actual.publisherId || !actual.appId || !actual.unitId.startsWith(`ca-app-${actual.publisherId}/`) || !actual.appId.startsWith(`ca-app-${actual.publisherId}~`) || actual.name !== task.name || !actual.format || !matchesRequestedConfiguration(actual, task.floor, task.mode ?? "manual", task.partnerBidding)) {
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
  function createBatch(rows, identity, format, concurrency, execution, sourceUrl, controllerId, mode = "manual", partnerBidding = false) {
    if (partnerBidding) mode = "disabled";
    if (!["manual", "auto", "disabled"].includes(mode)) throw new Error("不支持的底价模式");
    if (!Array.isArray(rows) || !rows.length) throw new Error("请输入至少一条广告位");
    for (const row of rows) {
      if (!row || !Array.isArray(row.errors) || row.errors.length) throw new Error("输入存在行级错误，请先修正");
      if (typeof row.name !== "string" || !row.name.trim() || row.name !== row.name.trim() || row.name.length > MAX_NAME_LENGTH || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(row.name)) throw new Error(`第 ${row.line} 行广告位名称无效或超过 ${MAX_NAME_LENGTH} 个字符`);
      if (!Number.isSafeInteger(row.line) || row.line < 1) throw new Error("输入原始行号无效");
      if (typeof row.floor !== "string") throw new Error(`第 ${row.line} 行底价须为十进制字符串`);
      if (mode === "manual") normalizeDecimal(row.floor);
    }
    if (!/^pub-\d{16}$/.test(identity.publisherId) || !/^ca-app-pub-\d{16}~\d{10}$/.test(identity.appId) || !identity.appId.startsWith(`ca-app-${identity.publisherId}~`)) throw new Error("发布商 ID 或应用 ID 无效或不匹配");
    if (![1, 2, 3, 4, 5].includes(concurrency)) throw new Error("并发数必须为 1、2、3、4 或 5");
    if (!Object.hasOwn(FORMAT_ZH, format)) throw new Error("不支持的广告格式");
    if (partnerBidding && format === "rewarded-interstitial") throw new Error("插页式激励广告不支持合作平台出价");
    if (!["tabs", "single", "paged"].includes(execution)) throw new Error("不支持的执行模式");
    if (typeof controllerId !== "string" || !controllerId.trim()) throw new Error("主控标识不能为空");
    return {
      schema: 1,
      id: newId(),
      identity: structuredClone(identity),
      format,
      mode,
      partnerBidding,
      currency: "USD",
      concurrency: execution === "tabs" ? concurrency : 1,
      execution,
      sourceUrl,
      phase: "draft",
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      canaryPassed: false,
      controllerId,
      tasks: rows.map((row) => ({ id: newId(), line: row.line, name: row.name, mode, ...partnerBidding ? { partnerBidding: true } : {}, floor: mode === "manual" ? normalizeDecimal(row.floor) : "", status: "pending", reason: "", attempts: 0, logs: [] }))
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
    const records = [["原始行号", "发布商ID", "应用名称", "App ID", "广告位名称", "广告格式", "请求底价模式", "请求底价USD", "实际底价模式", "实际底价", "实际币种", "广告位ID", "状态", "原因", "完成时间", "批次ID", "批次开始时间", "批次结束时间", "批次总耗时"]];
    const timing = summarizeBatch(batch);
    for (const task of tasks) records.push([task.line, batch.identity.publisherId, batch.identity.appName, batch.identity.appId, task.name, FORMAT_ZH[batch.format], batch.partnerBidding ? "不适用（合作平台出价）" : MODE_ZH[batch.mode ?? "manual"], batch.partnerBidding ? "" : task.floor, task.actual?.mode === "partner-bidding" ? "不适用（合作平台出价）" : task.actual?.mode, task.actual?.floor, task.actual?.currency, task.actual?.unitId, STATUS_ZH[task.status], task.reason, task.finishedAt, batch.id, timing.startedAt, timing.completedAt, batchElapsed(timing)]);
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
    gridLabel: ["广告单元"],
    publisher: ["发布商 ID", "发布商ID"],
    appId: ["应用 ID", "应用ID", "AdMob 应用 ID"],
    appName: ["应用名称", "当前应用"],
    units: ["广告单元"],
    add: ["添加广告单元"],
    create: ["创建广告单元"],
    name: ["广告单元名称", "输入广告单元名称"],
    advanced: ["高级设置"],
    manual: ["人工指定底价"],
    auto: ["由 Google 优化", "Google 优化"],
    disabled: ["已停用"],
    floorGroup: ["有效每千次展示费用底价"],
    floor: ["输入全球有效每千次展示费用底价", "全局底价", "全球底价"],
    format: ["广告格式"],
    unitId: ["广告单元 ID", "广告单元ID"],
    mode: ["底价模式"],
    amount: ["全局底价"],
    currency: ["底价币种", "币种"],
    banner: ["横幅广告", "横幅"],
    interstitial: ["插页式广告", "插页式", "插屏"],
    rewarded: ["激励广告", "激励"],
    "rewarded-interstitial": ["插页式激励广告", "激励插页式广告", "插页式激励", "激励插页式"],
    "app-open": ["开屏广告", "开屏"],
    native: ["原生高级广告", "原生广告", "原生"],
    next: ["转到下一页", "下一页"],
    first: ["转到首页", "第一页"],
    back: ["返回", "转到广告单元列表"]
  };
  var FORMAT_LABELS = {
    banner: ZH.banner,
    interstitial: ZH.interstitial,
    rewarded: ZH.rewarded,
    "rewarded-interstitial": ZH["rewarded-interstitial"],
    "app-open": ZH["app-open"],
    native: ZH.native
  };
  var FORMAT_PAGE = {
    banner: "横幅广告",
    interstitial: "插页式广告",
    rewarded: "激励广告",
    "rewarded-interstitial": "插页式激励广告",
    "app-open": "开屏广告",
    native: "原生高级广告"
  };
  var PUBLISHER_RX = /^pub-\d{16}$/;
  var APP_RX = /^ca-app-pub-(\d{16})~(\d{10})$/;
  var UNIT_RX = /^ca-app-pub-(\d{16})\/(\d{10})$/;
  var ANY_APP_RX = /ca-app-pub-\d{16}~\d{10}/;
  var ANY_UNIT_RX = /ca-app-pub-\d{16}\/\d{10}/;
  var SESSION_IDENTITY = "abc:live-identity:";
  var DEFAULT_MEDIA_TYPES = MEDIA_DEFAULTS.interstitial;
  var PARTNER_BIDDING_LABEL = "我目前在另一中介平台（而非 AdMob）上将此广告单元用于实时出价。";
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
  function fieldText(element2, preserveWhitespace = false) {
    if (!element2) return "";
    const copy = element2.cloneNode(true);
    for (const icon of copy.querySelectorAll("help-tooltip-icon, material-icon, .material-icons, .material-icons-extended")) icon.remove();
    const value = copy.textContent || "";
    return (preserveWhitespace ? value : value.replace(/\s+/g, " ")).trim();
  }
  var compact = (s) => s.replace(/[：:\s]/g, "");
  var sameLabel = (s, labels) => labels.some((x) => compact(s) === compact(x));
  var containsLabel = (s, labels) => labels.some((x) => compact(s).includes(compact(x)));
  function displayedDecimal(value) {
    if (!/^(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d+)?$/.test(value)) return void 0;
    return normalizeDecimal(value.replace(/,/g, ""));
  }
  function inputMatchesValue(input, expected) {
    if (input.value === expected || decimalEqual(input.value, expected)) return true;
    const displayed = input.tagName === "INPUT" && input.closest("manual-ecpm-floor-input") ? displayedDecimal(input.value) : void 0;
    return displayed !== void 0 && decimalEqual(displayed, expected);
  }
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
    return !e.hasAttribute("disabled") && e.getAttribute("aria-disabled") !== "true" && !e.classList.contains("is-disabled");
  }
  function accessibleName(e) {
    const refs = e.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => txt(e.ownerDocument.getElementById(id))).join(" ");
    return (e.getAttribute("aria-label") || refs || e.labels?.[0]?.textContent || txt(e)).trim();
  }
  function click(e, step) {
    if (!visible(e) || !enabled(e)) throw new AdapterError("STRUCTURE", `${step}：控件不可见或不可操作`);
    e.click();
  }
  function labelledInputs(scope, labels) {
    return elements(scope, 'input:not([type="hidden"]),textarea').filter((e) => containsLabel(accessibleName(e), labels));
  }
  function required(value, message) {
    if (value === void 0 || value === null || value === "") throw new AdapterError("STRUCTURE", message);
    return value;
  }
  var OTHER_CURRENCY = /\b(?:CNY|RMB|EUR|GBP|HKD|CAD|AUD|NZD|SGD|JPY|TWD|KRW|INR|BRL|MXN|CHF|SEK|NOK|DKK|PLN|TRY|RUB|ZAR)\b|人民币|欧元|港元|加元|澳元|新加坡元|日元|英镑|韩元|印度卢比|雷亚尔|比索|瑞士法郎|CN¥|HK\$|CA\$|A\$|[¥￥€£₩₹₽]/i;
  function currencyOf(input) {
    const container = input.closest("manual-ecpm-floor-input") || input.closest("material-input") || input.closest("label") || input.parentElement;
    const local = container ? container : input;
    const text = [accessibleName(input), txt(local)].join(" ");
    if (OTHER_CURRENCY.test(text)) throw new AdapterError("CURRENCY", "底价输入控件的币种不是 USD 或包含冲突币种");
    return "USD";
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
  function formatFrom(s) {
    if (!s) return void 0;
    const value = s.trim();
    return Object.keys(FORMAT_LABELS).find((format) => FORMAT_LABELS[format].includes(value));
  }
  function formatFromCell(s) {
    if (!s) return void 0;
    const exact = formatFrom(s);
    if (exact) return exact;
    const labels = Object.entries(FORMAT_LABELS).flatMap(([format, aliases]) => aliases.filter((label) => label.length > 2).map((label) => ({ format, label }))).sort((a, b) => b.label.length - a.label.length);
    let remaining = s;
    const matches = /* @__PURE__ */ new Set();
    for (const { format, label } of labels) {
      if (!remaining.includes(label)) continue;
      matches.add(format);
      remaining = remaining.replaceAll(label, " ");
    }
    return matches.size === 1 ? [...matches][0] : void 0;
  }
  function routeAppId(doc) {
    const match = doc.location?.pathname.match(/\/v2\/apps\/(\d{10})(?:\/|$)/);
    return match?.[1];
  }
  function appNameFromPage(doc) {
    const extract = (label) => {
      const match = label.match(/(.+?)(?:中的广告单元|的应用设置|应用概览|的屏蔽控制功能)/);
      return match ? match[1].replace(/^[“”"'‘’\s]+|[“”"'‘’\s]+$/g, "").trim() : "";
    };
    const selected = [];
    for (const el of doc.querySelectorAll('material-list-item.selected[aria-label], material-list-item[aria-selected="true"][aria-label]')) {
      const label = el.getAttribute("aria-label") || "";
      if (!/中的广告单元|的应用设置|应用概览|的屏蔽控制功能/.test(label)) continue;
      const name = extract(label);
      if (name) selected.push(name);
    }
    const selectedNames = [...new Set(selected.filter(Boolean))];
    if (selectedNames.length === 1) return selectedNames[0];
    if (selectedNames.length > 1) throw new AdapterError("IDENTITY", "侧栏出现多个选中的应用，无法确认当前应用");
    const primary = [];
    for (const el of doc.querySelectorAll("span.primary-label")) {
      const value = fieldText(el, true);
      if (value && !/^(AdMob|首页|应用|报告|中介|广告系列|政策中心)$/.test(value)) primary.push(value);
    }
    const primaryNames = [...new Set(primary.filter(Boolean))];
    if (primaryNames.length === 1) return primaryNames[0];
    if (primaryNames.length > 1) throw new AdapterError("IDENTITY", "页面出现多个不同应用名称，无法确认当前应用");
    const labelled = [];
    for (const el of doc.querySelectorAll('material-list-item[aria-label], [role="link"][aria-label]')) {
      const label = el.getAttribute("aria-label") || "";
      if (!/应用设置|应用概览|广告单元/.test(label)) continue;
      const name = extract(label);
      if (name) labelled.push(name);
    }
    const labelledNames = [...new Set(labelled.filter(Boolean))];
    if (labelledNames.length > 1) throw new AdapterError("IDENTITY", "页面出现多个不同应用名称，无法确认当前应用");
    return labelledNames[0] || "";
  }
  function appIdText(doc) {
    const values = [];
    for (const el of elements(doc, "span.copy-chip-text, [aria-label], output, p, div")) {
      if (el.childElementCount > 0) continue;
      const value = txt(el);
      if (ANY_APP_RX.test(value) && value.length <= 80) values.push(value);
    }
    const distinct = [...new Set(values)];
    if (distinct.length > 1) throw new AdapterError("IDENTITY", "页面出现多个不同 App ID，无法确认当前应用");
    return distinct[0];
  }
  function firstUnit(doc) {
    for (const el of elements(doc, 'a[href*="/adunits/"], ad-unit-with-id-cell, .ad-unit-id-container, div.panel-description')) {
      const match = (el.getAttribute("href") || txt(el)).match(ANY_UNIT_RX);
      if (match) return match[0];
    }
    return void 0;
  }
  var AdMobAdapter = class {
    doc;
    timeout;
    openingIdentity;
    prepared;
    submitted = false;
    constructor(doc = document, timeout = 2e4) {
      this.doc = doc;
      this.timeout = timeout;
    }
    sleep(ms) {
      return new Promise((resolve) => this.doc.defaultView.setTimeout(resolve, ms));
    }
    async wait(fn, step, timeout = this.timeout) {
      const initial = fn();
      if (initial) return initial;
      const view = this.doc.defaultView;
      return new Promise((resolve, reject) => {
        let timer = 0;
        let poll = 0;
        let settled = false;
        const finish = (err, value) => {
          if (settled) return;
          settled = true;
          observer.disconnect();
          view.clearTimeout(timer);
          view.clearInterval(poll);
          err ? reject(err) : resolve(value);
        };
        const observer = new view.MutationObserver(() => {
          if (settled) return;
          try {
            const value = fn();
            if (value) finish(void 0, value);
          } catch (err) {
            finish(err);
          }
        });
        observer.observe(this.doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        poll = view.setInterval(() => {
          if (settled) return;
          try {
            const value = fn();
            if (value) finish(void 0, value);
          } catch (err) {
            finish(err);
          }
        }, 250);
        timer = view.setTimeout(() => finish(new AdapterError("TIMEOUT", `${step}：等待页面条件超时，未确认结果`)), timeout);
      });
    }
    identityFromSession(app) {
      try {
        const raw = this.doc.defaultView?.sessionStorage.getItem(SESSION_IDENTITY + app);
        if (!raw) return void 0;
        const parsed = JSON.parse(raw);
        if (!parsed?.publisherId || !parsed?.appId || !parsed?.appName) return void 0;
        return parsed;
      } catch {
        return void 0;
      }
    }
    saveIdentity(identity, app) {
      try {
        this.doc.defaultView?.sessionStorage.setItem(SESSION_IDENTITY + app, JSON.stringify(identity));
      } catch {
      }
    }
    async identify() {
      const loc = this.doc.location;
      if (loc && /accounts\.google\.com$/.test(loc.hostname)) throw new AdapterError("LOGIN", "登录已失效，请在原浏览器恢复登录");
      const app = routeAppId(this.doc);
      if (!app) throw new AdapterError("IDENTITY", "当前 URL 中没有可确认的应用路由；请进入目标应用的广告单元页面");
      const snapshot = await this.wait(() => {
        const appName2 = appNameFromPage(this.doc);
        if (!appName2) return void 0;
        const appIdTextValue2 = appIdText(this.doc);
        const unit2 = firstUnit(this.doc);
        const cached2 = (this.onCreateRoute() ? this.openingIdentity : void 0) ?? this.identityFromSession(app);
        const cacheUsable = !!cached2 && cached2.appName === appName2 && cached2.appId.endsWith(`~${app}`);
        if (!appIdTextValue2 && !unit2 && !cacheUsable) return void 0;
        return { appName: appName2, appIdTextValue: appIdTextValue2, unit: unit2, cached: cacheUsable ? cached2 : void 0 };
      }, "等待当前应用身份");
      const { appName, appIdTextValue, unit, cached } = snapshot;
      let publisherId;
      let appId;
      if (appIdTextValue) {
        const match = appIdTextValue.match(APP_RX);
        if (!match || match[2] !== app) throw new AdapterError("IDENTITY", "当前 App ID 与当前应用路由不一致");
        publisherId = `pub-${match[1]}`;
        appId = appIdTextValue;
      } else if (unit) {
        const unitMatch = unit.match(UNIT_RX);
        if (unitMatch) {
          publisherId = `pub-${unitMatch[1]}`;
          appId = `ca-app-pub-${unitMatch[1]}~${app}`;
        }
      } else if (cached) {
        publisherId = cached.publisherId;
        appId = cached.appId;
      }
      if (!publisherId || !appId || !PUBLISHER_RX.test(publisherId) || !appId.startsWith(`ca-app-${publisherId}~`)) {
        throw new AdapterError("IDENTITY", "当前页面没有可核对的发布商 ID 或广告位 ID；请回广告单元列表重新识别");
      }
      if (!appId.endsWith(`~${app}`)) throw new AdapterError("IDENTITY", "App ID 与当前应用路由不一致");
      const identity = {
        publisherId,
        appId,
        appName,
        currency: "USD",
        evidence: [
          `当前应用路由 ${app}`,
          `当前页面应用名称「${appName}」`,
          appIdTextValue ? "应用设置页显式 App ID" : unit ? "广告位 ID 的发布商前缀与当前应用路由" : "已核对的应用路由、页面应用名称与同一执行页的身份记录",
          "底价币种采用用户已确定的批次 USD 配置，不代表页面字段实测币种"
        ]
      };
      this.saveIdentity(identity, app);
      return identity;
    }
    async identifyCreatePage(expected) {
      const app = this.targetListApp(expected);
      await this.wait(() => {
        if (!this.onCreateRoute() || routeAppId(this.doc) !== app) throw new AdapterError("IDENTITY", "执行页未进入目标应用的创建页");
        const name = appNameFromPage(this.doc);
        if (!name || !this.formatCards().length) return void 0;
        if (name !== expected.appName) throw new AdapterError("IDENTITY", "创建页应用名称与主控不一致");
        return true;
      }, "等待目标应用的广告格式选择页");
      this.openingIdentity = expected;
      try {
        const actual = await this.identify();
        if (actual.appId !== expected.appId || actual.publisherId !== expected.publisherId) throw new AdapterError("IDENTITY", "创建页身份与主控不一致");
        return actual;
      } finally {
        this.openingIdentity = void 0;
      }
    }
    async assertIdentity(identity) {
      const current = await this.identify();
      if (current.publisherId !== identity.publisherId || current.appId !== identity.appId) throw new AdapterError("IDENTITY", "当前发布商或应用与批次不一致，整批暂停");
    }
    grid() {
      const grids = elements(this.doc, 'div.ess-table-canvas[role="grid"], [role="grid"]').filter((e) => /广告单元/.test(e.getAttribute("aria-label") || ""));
      if (grids.length > 1) throw new AdapterError("STRUCTURE", "当前页面存在多个广告单元列表");
      return grids[0];
    }
    onListRoute() {
      return /\/adunits\/list\/?$/.test(this.doc.defaultView?.location.pathname || "");
    }
    onCreateRoute() {
      return /^\/v2\/apps\/\d{10}\/adunits\/create\/?$/.test(this.doc.location.pathname);
    }
    canRouteWithinDocument() {
      return this.doc.location.protocol === "https:" && ["admob.google.com", "apps.admob.com"].includes(this.doc.location.hostname);
    }
    async routeWithinDocument(path, ready, step, timeout = 4e3, replace = false) {
      if (!this.canRouteWithinDocument() || !/^\/v2\/apps\/\d{10}\/adunits\/(?:list|\d{10}\/edit)$/.test(path)) {
        throw new AdapterError("STRUCTURE", "不能导航到未经核对的应用或广告单元路径");
      }
      const view = this.doc.defaultView;
      if (view.location.pathname !== path) {
        if (replace) view.history.replaceState(view.history.state, "", path);
        else view.history.pushState(view.history.state, "", path);
      }
      view.dispatchEvent(new view.PopStateEvent("popstate", { state: view.history.state }));
      await this.wait(() => view.location.pathname === path && ready(), step, timeout);
    }
    targetListApp(expected) {
      const current = routeAppId(this.doc);
      const requested = expected?.appId.match(APP_RX);
      if (expected && (!requested || !PUBLISHER_RX.test(expected.publisherId) || `pub-${requested[1]}` !== expected.publisherId)) {
        throw new AdapterError("IDENTITY", "目标应用或发布商 ID 无效，未导航");
      }
      const app = requested?.[2] || current;
      if (!app) throw new AdapterError("IDENTITY", "无法确认目标应用，不能从应用总览猜测返回路径");
      if (current && current !== app) throw new AdapterError("IDENTITY", "当前页面是其他应用，未切换应用或执行提交");
      return app;
    }
    listReady(app) {
      if (!this.onListRoute() || routeAppId(this.doc) !== app || !this.grid()) return false;
      if (elements(this.doc, "format-creator, .instructions-container .instructions").length || elements(this.doc, "h1,h2").some((heading) => /^(创建|修改)广告单元/.test(fieldText(heading))) || elements(this.doc, 'div.header[aria-label="广告单元 ID"], [role="heading"][aria-label="广告单元 ID"]').length) return false;
      const add = elements(this.doc, 'material-button,button,[role="button"]').filter((control) => sameLabel(accessibleName(control), ZH.add) || sameLabel(fieldText(control), ZH.add));
      if (add.length > 1) one(add, "添加广告单元入口");
      return !!this.searchInput() && add.length === 1;
    }
    async home(expected) {
      await this.backToList(expected);
      if (expected) await this.assertIdentity(expected);
      const search = this.searchInput();
      if (search?.value.trim()) {
        await this.setInput(search, "", "清空广告单元搜索");
        await this.wait(() => !this.searchInput()?.value.trim(), "等待清空广告单元搜索", 1e4).catch(() => void 0);
      }
    }
    footerText() {
      const grid = this.grid();
      const scopes = [grid?.closest('main,[role="main"]'), grid?.parentElement, this.doc.body];
      for (const scope of scopes) {
        const found = txt(scope).match(/第\s*\d+\s*-\s*\d+\s*行[，,]\s*共\s*\d+\s*行/)?.[0];
        if (found) return found;
      }
      return "";
    }
    pageInfo() {
      const match = this.footerText().match(/第\s*(\d+)\s*-\s*(\d+)\s*行[，,]\s*共\s*(\d+)\s*行/);
      return match ? { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) } : void 0;
    }
    searchInput() {
      const grid = this.grid();
      const scopes = [grid?.closest('main,[role="main"]'), this.doc];
      for (const scope of scopes) {
        if (!scope) continue;
        const input = elements(scope, "input").find((e) => /广告单元名称/.test(accessibleName(e)) || /广告单元名称/.test(e.placeholder || ""));
        if (input) return input;
      }
      return void 0;
    }
    searchValue() {
      return this.searchInput()?.value.trim() || "";
    }
    rows() {
      const grid = this.grid();
      if (!grid) return [];
      return elements(grid, 'div.particle-table-row[role="row"]').filter((row) => row.querySelector('ess-cell[essfield="ad-unit-with-id-info"]'));
    }
    rowInfo(row) {
      const cell = row.querySelector('ess-cell[essfield="ad-unit-with-id-info"]');
      const link = cell?.querySelector('a[href*="/adunits/"]');
      const name = fieldText(link, true) || fieldText(cell?.querySelector("ad-unit-with-id-cell")?.firstElementChild, true);
      const unitId = txt(cell).match(ANY_UNIT_RX)?.[0];
      const formatText = txt(row.querySelector('ess-cell[essfield="ad-unit-format"]'));
      if (!name || !unitId) return void 0;
      return { name, unitId, format: formatFromCell(formatText), href: link?.href };
    }
    async waitPageChange(previous, step) {
      await this.wait(() => {
        const rows = this.rows();
        return rows.length && rows.map(txt).join("\n") !== previous;
      }, step);
    }
    savedField(label) {
      const values = [];
      const readableReferencedDescription = (element2) => {
        if (!element2.isConnected || !element2.matches(".panel-description") || element2.closest("[hidden],inert")) return false;
        for (let node = element2; node; node = node.parentElement) {
          if (node !== element2 && node.getAttribute("aria-hidden") === "true") return false;
          const style = element2.ownerDocument.defaultView?.getComputedStyle(node);
          if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return false;
        }
        return true;
      };
      const add = (element2, explicitlyReferenced = false) => {
        if (!element2 || !(visible(element2) || explicitlyReferenced && readableReferencedDescription(element2))) return;
        const value = fieldText(element2, label === "广告单元名称");
        if (!value) return;
        if (label === "广告单元 ID") {
          const ids = [...new Set(value.match(/ca-app-pub-\d{16}\/\d{10}/g) || [])];
          values.push(...ids);
        } else values.push(value);
      };
      for (const header of elements(this.doc, 'div.header[aria-label], [role="heading"][aria-label]')) {
        if (!sameLabel(header.getAttribute("aria-label") || "", [label])) continue;
        for (const id of (header.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean)) {
          const value = this.doc.getElementById(id);
          add(value, true);
        }
        const description = header.querySelector(".panel-description");
        add(description);
      }
      const labels = elements(this.doc, '.panel-name, .collapsed-title, [class*="panel-title"], div.header').filter((e) => sameLabel(txt(e), [label]));
      for (const e of labels) {
        const candidates = [
          e.closest("div.header")?.querySelector(".panel-description"),
          e.nextElementSibling?.matches(".panel-description") ? e.nextElementSibling : void 0,
          e.parentElement?.nextElementSibling?.matches(".panel-description") ? e.parentElement.nextElementSibling : void 0
        ];
        candidates.forEach((candidate) => add(candidate));
      }
      const distinct = [...new Set(values)];
      if (distinct.length > 1) throw new AdapterError("VERIFY", `保存后字段“${label}”出现多个不同值，不能确认同一广告单元的配置`);
      return distinct[0];
    }
    savedFloor(raw) {
      if (!raw) return { mode: "unknown", currency: "unknown", verified: false };
      if (/已停用/.test(raw) && !/人工指定底价|Google\s*优化|动态底价/.test(raw)) return { mode: "disabled", currency: "", verified: true };
      if (/Google\s*优化|动态底价/.test(raw) && !/已停用|人工指定底价|全球底价设为/.test(raw)) return { mode: "auto", currency: "", verified: true };
      const amount = raw.match(/[+-]?[\d.,][\d.,\s]*(?:[eE][+-]?\d+)?/)?.[0].trim();
      const floor = amount ? displayedDecimal(amount) : void 0;
      const manual = /全球底价设为|人工指定底价/.test(raw);
      const currency = OTHER_CURRENCY.test(raw) ? "other" : "USD";
      const verified = manual && !!floor && currency === "USD";
      return { mode: manual ? "manual" : "unknown", floor, currency, verified };
    }
    async findRowLink(href) {
      const first = elements(this.doc, '[aria-label="转到首页"], [aria-label="转到第一页"]').filter(enabled);
      if (first.length === 1) {
        const previous = this.rows().map(txt).join("\n");
        click(first[0], "返回列表第一页");
        await this.waitPageChange(previous, "等待列表第一页");
      }
      for (let pages = 0; pages < 200; pages++) {
        const links = elements(this.doc, "a[href]").filter((e) => e.href === href);
        if (links.length === 1) return links[0];
        if (links.length > 1) throw new AdapterError("STRUCTURE", "广告单元详情入口不唯一，已停止");
        const next = elements(this.doc, '[aria-label="转到下一页"], [aria-label="下一页"]');
        if (next.length !== 1 || !enabled(next[0])) break;
        const previous = this.rows().map(txt).join("\n");
        click(next[0], "查找广告单元详情");
        await this.waitPageChange(previous, "等待下一页列表");
      }
      throw new AdapterError("STRUCTURE", "列表中找不到已记录的广告单元详情入口");
    }
    async readUnitDetail(identity, href, expected) {
      click(await this.findRowLink(href), "打开广告单元详情");
      await this.wait(() => !this.onListRoute() && !this.activeForm() && this.savedField("广告单元 ID"), "等待广告单元详情");
      await this.assertIdentity(identity);
      const unitId = this.savedField("广告单元 ID");
      const name = this.savedField("广告单元名称");
      const formatText = this.savedField("广告格式");
      const floorText = this.savedField("有效每千次展示费用底价");
      const parsed = this.savedFloor(floorText);
      const actual = {
        publisherId: identity.publisherId,
        appId: identity.appId,
        name,
        unitId: unitId || expected.unitId,
        format: formatFrom(formatText),
        mode: parsed.mode,
        floor: parsed.floor,
        currency: parsed.currency,
        verified: false
      };
      if (!unitId || unitId !== expected.unitId) throw new AdapterError("VERIFY", "详情页广告位 ID 与列表不一致，不能合并两个单元的配置", true, actual);
      if (!name || name !== expected.name) throw new AdapterError("VERIFY", "详情页名称缺失或与列表不一致", true, actual);
      if (!actual.format || actual.format !== expected.format) throw new AdapterError("VERIFY", "详情页格式缺失或与列表不一致", true, actual);
      actual.verified = parsed.verified;
      await this.backToList(identity);
      return actual;
    }
    async backToList(expected) {
      const view = this.doc.defaultView;
      const app = this.targetListApp(expected);
      const waitForList = async () => {
        try {
          await this.wait(() => this.listReady(app), "等待广告单元列表内容就绪");
        } catch (error) {
          if (this.listReady(app)) return;
          if (!this.onListRoute() || routeAppId(this.doc) !== app) throw error;
          try {
            await this.wait(() => this.listReady(app), "等待已返回的广告单元列表内容就绪");
          } catch (finalError) {
            if (this.listReady(app)) return;
            throw finalError;
          }
        }
      };
      if (this.listReady(app)) return;
      if (this.canRouteWithinDocument()) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await this.routeWithinDocument(`/v2/apps/${app}/adunits/list`, () => this.listReady(app), "打开目标应用广告单元列表", this.timeout, true);
            return;
          } catch (error) {
            if (this.listReady(app)) return;
            if (!this.onListRoute() || routeAppId(this.doc) !== app || !(error instanceof AdapterError) || error.code !== "TIMEOUT" || attempt === 1) throw error;
          }
        }
      }
      if (this.onListRoute()) {
        await waitForList();
        return;
      }
      if (this.creationReceipt()) {
        const complete = elements(this.doc, 'material-button,button,[role="button"],a[href]').filter((control) => enabled(control) && ["完成", "返回广告单元列表", "转到广告单元列表"].some((label) => sameLabel(accessibleName(control), [label]) || sameLabel(fieldText(control), [label])));
        if (complete.length > 1) throw new AdapterError("STRUCTURE", "创建完成后的返回入口不唯一，未操作");
        if (complete.length === 1) {
          click(complete[0], "完成并返回广告单元列表");
          try {
            await waitForList();
            return;
          } catch {
          }
        }
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        this.targetListApp(expected);
        if (this.onListRoute()) {
          await waitForList();
          return;
        }
        const previous = view.location.href;
        let popped = false;
        const returned = () => {
          popped = true;
        };
        view.addEventListener("popstate", returned);
        try {
          view.history.back();
          await this.wait(() => popped || this.onListRoute() || view.location.href !== previous, "等待返回广告单元列表路由");
        } catch {
        } finally {
          view.removeEventListener("popstate", returned);
        }
        const current = routeAppId(this.doc);
        if (current !== app) throw new AdapterError("IDENTITY", "返回路径已离开目标应用，停止历史回退");
        if (this.onListRoute()) {
          await waitForList();
          return;
        }
        const link = elements(this.doc, "material-list-item[href],a[href]").find((control) => {
          try {
            const url = new URL(control.getAttribute("href"), this.doc.location.href);
            return url.origin === view.location.origin && url.pathname === `/v2/apps/${app}/adunits/list`;
          } catch {
            return false;
          }
        });
        if (link) {
          click(link, "返回广告单元列表");
          await waitForList();
          return;
        }
      }
      throw new AdapterError("STRUCTURE", "无法返回广告单元列表；未提交任何变更");
    }
    async awaitSearchRows(value, timeout = 15e3) {
      try {
        this.grid()?.scrollIntoView({ block: "start", inline: "nearest" });
      } catch {
      }
      const rendered = await this.wait(() => {
        if (this.searchInput()?.value.trim() !== value) return void 0;
        const rows = this.rows();
        const page = this.pageInfo();
        return rows.length > 0 || page && page.total === 0 ? true : void 0;
      }, "等待筛选结果行", timeout).catch(() => false);
      if (!rendered) {
        try {
          this.grid()?.scrollIntoView({ block: "start", inline: "nearest" });
        } catch {
        }
        await this.sleep(700);
      }
      return { rows: this.rows(), page: this.pageInfo() };
    }
    async lookup(identity, name) {
      await this.assertIdentity(identity);
      await this.home(identity);
      if (!this.onListRoute() || !this.grid()) return { complete: false, matches: [], reason: "无法返回广告单元列表，未提交任何变更" };
      await this.wait(() => this.pageInfo(), "等待广告单元列表总数", 15e3).catch(() => void 0);
      const search = this.searchInput();
      if (!search) return { complete: false, matches: [], reason: "未找到广告单元搜索框，无法完成同名查重" };
      await this.setInput(search, name, "按名称搜索广告单元");
      const filtered = await this.awaitSearchRows(name);
      if (this.searchInput()?.value.trim() !== name) return { complete: false, matches: [], reason: "广告单元搜索条件未生效，不能证明查重完整" };
      if (filtered.page?.total === 0) return { complete: true, matches: [] };
      if (!filtered.rows.length) return { complete: false, matches: [], reason: `按名称搜索返回 ${filtered.page?.total ?? "?"} 条，但当前未渲染出广告单元行；AdMob 允许重名，不阻止创建` };
      let resetClicks = 0;
      for (let guard = 0; guard < 200; guard++) {
        const back = elements(this.doc, '[aria-label="转到上一页"], [aria-label="上一页"]').filter(enabled);
        if (back.length > 1) return { complete: false, matches: [], reason: "列表上一页控件不唯一" };
        if (back.length === 0) break;
        const previous = this.rows().map(txt).join("\n");
        click(back[0], "返回列表上一页");
        resetClicks++;
        await this.waitPageChange(previous, "等待列表上一页");
        await this.wait(() => this.pageInfo(), "等待分页总数", 5e3).catch(() => void 0);
      }
      const resetPage = this.pageInfo();
      if (resetPage && resetPage.start !== 1) return { complete: false, matches: [], reason: "无法返回广告单元列表第一页，不能证明查重完整" };
      const matches = [];
      const seen = /* @__PURE__ */ new Set();
      let counted = 0;
      let total;
      for (let pages = 0; pages < 200; pages++) {
        await this.assertIdentity(identity);
        const rows = this.rows();
        const page = this.pageInfo();
        if (page && page.total === 0) return { complete: true, matches: [] };
        if (!rows.length && !page) return { complete: false, matches: [], reason: "列表为空但未声明总行数，不能证明完整" };
        const signature = rows.map(txt).join("\n");
        if (seen.has(signature)) return { complete: false, matches: matches.map((x) => x.match), reason: "列表分页重复或未更新" };
        seen.add(signature);
        counted += rows.length;
        const info = this.pageInfo();
        if (info) total = info.total;
        for (const row of rows) {
          const infoRow = this.rowInfo(row);
          if (!infoRow || infoRow.name !== name) continue;
          matches.push({ href: infoRow.href, match: { publisherId: identity.publisherId, appId: identity.appId, name, unitId: infoRow.unitId, format: infoRow.format, mode: "manual", floor: void 0, currency: "unknown", verified: false } });
        }
        if (total !== void 0 && counted >= total) break;
        const next = elements(this.doc, '[aria-label="转到下一页"], [aria-label="下一页"]');
        if (next.length !== 1 || !enabled(next[0])) return { complete: false, matches: matches.map((x) => x.match), reason: `缺少可核对的列表总数或下一页控件，不能证明分页完整（路由 ${this.doc.defaultView?.location.pathname || "?"}，回退 ${resetClicks} 次至第 ${resetPage?.start ?? "?"} 页，本页 ${rows.length} 行，累计 ${counted}/${total ?? "?"}，下一页 ${next.length}/${next[0] ? enabled(next[0]) : "?"}）` };
        const previous = signature;
        click(next[0], "下一页");
        await this.waitPageChange(previous, "等待下一页列表");
        await this.wait(() => this.pageInfo(), "等待分页总数", 5e3).catch(() => void 0);
      }
      if (total === void 0) return { complete: false, matches: matches.map((x) => x.match), reason: "列表没有声明总行数，不能证明结果完整" };
      if (counted !== total) return { complete: false, matches: matches.map((x) => x.match), reason: "列表总数与已读取行数不一致" };
      const detailed = [];
      for (const found of matches) {
        if (!found.href) {
          detailed.push({ ...found.match, verified: false });
          continue;
        }
        try {
          detailed.push(await this.readUnitDetail(identity, found.href, { name, unitId: found.match.unitId, format: found.match.format }));
        } catch (error) {
          if (error instanceof AdapterError && error.code === "VERIFY") {
            detailed.push({ ...found.match, ...error.actual, verified: false });
            continue;
          }
          return { complete: false, matches: detailed, reason: error.message };
        }
      }
      return { complete: true, matches: detailed };
    }
    activeForm() {
      const roots = elements(this.doc, "format-creator");
      if (roots.length) {
        if (!/\/adunits\/create\/?$/.test(this.doc.location.pathname)) return void 0;
        const formats = elements(this.doc, "div.format-label");
        if (formats.length !== 1 || !formatFrom(txt(formats[0]))) return void 0;
        const creators = roots.filter((root) => elements(root, "ad-unit-form").length === 1 && labelledInputs(root, ["输入广告单元名称", "广告单元名称"]).length === 1 && elements(root, 'material-button.btn-yes, [role="button"]').filter((button) => sameLabel(txt(button), ["创建广告单元"])).length === 1);
        if (creators.length > 1) throw new AdapterError("STRUCTURE", "创建广告单元表单不唯一，已停止");
        return creators[0];
      }
      if (this.formatCards().length) return void 0;
      const title = elements(this.doc, "h1,h2").find((e) => /创建广告单元/.test(txt(e)));
      if (title) return title.closest('main,[role="main"],form') || this.doc.body;
      return void 0;
    }
    nameInput(scope) {
      const inputs = elements(scope, 'material-input:not([type]) input[aria-labelledby], material-input:not([type="money64"]) input');
      const named = inputs.filter((e) => containsLabel(accessibleName(e), ["输入广告单元名称", "广告单元名称"]));
      return one(named.length ? named : inputs, "广告单元名称输入框");
    }
    formatLabel() {
      return txt(this.doc.querySelector("div.format-label")) || void 0;
    }
    partnerCheckbox(form) {
      const cards = elements(form, "third-party-bidding-card");
      if (!cards.length) return void 0;
      const card = one(cards, "合作平台出价组件");
      const controls = elements(card, '[role="checkbox"], input[type="checkbox"]').filter((control) => sameLabel(accessibleName(control), [PARTNER_BIDDING_LABEL, "合作平台出价"]) || sameLabel(fieldText(control.querySelector(".bidding-headline")), [PARTNER_BIDDING_LABEL]));
      return one(controls, "合作平台出价复选框");
    }
    partnerChecked(control) {
      if (control.tagName === "INPUT") return control.checked;
      const checked = control.getAttribute("aria-checked");
      if (checked !== "true" && checked !== "false") throw new AdapterError("STRUCTURE", "合作平台出价状态无法读回，未执行提交");
      return checked === "true";
    }
    async setPartnerBidding(form, expected, checkpoint) {
      const control = this.partnerCheckbox(form);
      if (!control) {
        if (expected) throw new AdapterError("ROW", "当前广告格式没有可确认的合作平台出价复选框，不能启用此设置", false);
        return false;
      }
      if (this.partnerChecked(control) !== expected) {
        await checkpoint();
        click(control, expected ? "启用合作平台出价" : "关闭合作平台出价");
        await this.wait(() => {
          const current = this.partnerCheckbox(form);
          return !!current && this.partnerChecked(current) === expected;
        }, "回读合作平台出价");
      }
      return true;
    }
    assertPartnerBidding(form, expected, previouslyPresent) {
      const control = this.partnerCheckbox(form);
      if (!control) {
        if (expected || previouslyPresent) throw new AdapterError("STRUCTURE", "提交前合作平台出价控件缺失，未执行提交");
        return;
      }
      if (this.partnerChecked(control) !== expected) throw new AdapterError("STRUCTURE", "提交前合作平台出价状态发生变化，未执行提交");
    }
    assertSavedPartnerBidding(expected, actual) {
      let value;
      try {
        value = this.savedField("合作平台出价");
      } catch (error) {
        if (error instanceof AdapterError) error.actual = { ...actual, ...error.actual };
        throw error;
      }
      const enabled2 = value && sameLabel(value, ["已启用", "启用", "是"]);
      const disabled = value && sameLabel(value, ["已停用", "停用", "未启用", "否"]);
      if (enabled2 || disabled) actual.partnerBidding = !!enabled2;
      if (value !== void 0 && !enabled2 && !disabled || actual.partnerBidding !== void 0 && actual.partnerBidding !== expected || expected && actual.partnerBidding === void 0) {
        throw new AdapterError("VERIFY", "保存后合作平台出价状态缺失、无法识别或与请求不一致，保留 ID 待核验", true, actual);
      }
    }
    assertPlatformDefaults(form) {
      const format = formatFrom(this.formatLabel());
      this.assertRewardDefaults(form, format);
      const expectedMedia = format ? MEDIA_DEFAULTS[format] : DEFAULT_MEDIA_TYPES;
      const mediaCards = elements(form, "ad-media-type-card");
      if (mediaCards.length > 1) throw new AdapterError("STRUCTURE", "广告类型组件不唯一，无法核对默认设置");
      for (const card of mediaCards) {
        const controls = elements(card, '[role="checkbox"], input[type="checkbox"]');
        const labelled = (control, label) => sameLabel(accessibleName(control), [label]) || sameLabel(fieldText(control), [label]);
        if (controls.some((control) => !expectedMedia.some((label) => labelled(control, label)))) {
          throw new AdapterError("STRUCTURE", "广告类型包含当前格式未识别的选项，无法核对默认设置");
        }
        for (const label of expectedMedia) {
          const choice = one(controls.filter((control) => labelled(control, label)), `默认广告类型“${label}”`);
          const checked = choice.tagName === "INPUT" ? choice.checked : choice.getAttribute("aria-checked") === "true";
          if (!checked) throw new AdapterError("STRUCTURE", `广告类型“${label}”未启用，未执行提交`);
        }
      }
      const frequencyCards = elements(form, "frequency-cap-card");
      if (frequencyCards.length > 1) throw new AdapterError("STRUCTURE", "频次上限组件不唯一，无法核对默认设置");
      for (const card of frequencyCards) {
        const control = one(elements(card, '[role="switch"]'), "频次上限开关");
        if (control.getAttribute("aria-checked") !== "false") throw new AdapterError("STRUCTURE", "频次上限未停用，未执行提交");
      }
    }
    assertRewardDefaults(form, format) {
      const cards = elements(form, "reward-settings-card");
      const rewarded = format === "rewarded" || format === "rewarded-interstitial";
      if (!rewarded) {
        if (cards.length) throw new AdapterError("STRUCTURE", "当前广告格式出现不适用的奖励设置，未执行提交");
        return;
      }
      if (!cards.length) {
        const bidding = this.partnerCheckbox(form);
        if (bidding && this.partnerChecked(bidding)) return;
      }
      const card = one(cards, "奖励设置组件");
      const inputs = elements(card, "input,textarea");
      const amount = one(inputs.filter((input) => sameLabel(accessibleName(input), ["输入奖品数量"])), "奖励数量输入框");
      const item = one(inputs.filter((input) => sameLabel(accessibleName(input), ["输入奖品"])), "奖励奖品输入框");
      if (amount.value !== REWARD_DEFAULT.amount || amount.getAttribute("aria-invalid") === "true" || !amount.validity.valid || item.value !== REWARD_DEFAULT.item || item.getAttribute("aria-invalid") === "true" || !item.validity.valid) {
        throw new AdapterError("STRUCTURE", `${FORMAT_PAGE[format]}的奖励设置与平台默认“${REWARD_DEFAULT.amount} ${REWARD_DEFAULT.item}”不一致或无效，未执行提交`);
      }
    }
    counter(scope) {
      const text = txt(scope.querySelector(".counter-container .counter, .counter"));
      const match = text.match(/(\d+)\s*\/\s*(\d+)/);
      return match ? { current: Number(match[1]), max: Number(match[2]) } : void 0;
    }
    errorText(scope) {
      return elements(scope, ".error-text").filter((e) => !e.classList.contains("hidden")).map(txt).filter(Boolean).join("；");
    }
    async setInput(input, value, step) {
      if (!enabled(input) || input.readOnly) throw new AdapterError("STRUCTURE", `${step}：输入控件不可编辑`);
      const view = input.ownerDocument.defaultView;
      input.focus();
      try {
        input.select();
      } catch {
      }
      let inserted = false;
      try {
        inserted = input.ownerDocument.execCommand("insertText", false, value);
      } catch {
        inserted = false;
      }
      if (!inserted || input.value !== value) {
        const proto = input.tagName === "TEXTAREA" ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
        input.dispatchEvent(new view.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
        input.dispatchEvent(new view.Event("change", { bubbles: true }));
      }
      await this.sleep(350);
      input.dispatchEvent(new view.Event("change", { bubbles: true }));
      await this.wait(() => inputMatchesValue(input, value), `${step}：等待输入回读`);
      input.blur();
      await this.sleep(250);
      if (!inputMatchesValue(input, value)) throw new AdapterError("ROW", `${step}：页面未接受输入值，未执行提交`, false);
    }
    formatCards() {
      return elements(this.doc, "section.ad-format-card");
    }
    async selectFormat(format, identity) {
      if (!this.onCreateRoute() || !this.formatCards().length) {
        await this.home(identity);
        const add = elements(this.doc, 'material-button[aria-label="添加广告单元"], [role="button"][aria-label="添加广告单元"]');
        click(one(add, "添加广告单元"), "添加广告单元");
        await this.wait(() => this.formatCards().length > 0, "等待广告格式选择");
      }
      const label = FORMAT_PAGE[format];
      const cards = this.formatCards().filter((card2) => {
        const title = txt(card2.querySelector(".header span") || card2.querySelector(".header"));
        return formatFrom(title) === format;
      });
      const card = one(cards, `定位${label}格式卡片`);
      const button = elements(card, 'material-button.select-button, [role="button"]').filter((e) => formatFrom(accessibleName(e)) === format);
      click(one(button, `选择${label}`), `选择${label}`);
      await this.wait(() => this.activeForm(), `等待${label}创建表单`);
    }
    floorRadio(mode) {
      const groups = elements(this.doc, "ecpm-settings-controls > material-radio-group");
      const group = groups.length ? one(groups, "底价模式主选项组") : void 0;
      const radios = elements(group || this.doc, '[role="radio"], input[type="radio"]').filter((control) => !group || control.closest("material-radio-group") === group);
      const found = radios.filter((control) => {
        const content = [...control.children].find((child) => child.matches("div.content"));
        const labels = content ? [fieldText(content)] : [accessibleName(control), fieldText(control)];
        for (const id of (control.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)) labels.push(fieldText(this.doc.getElementById(id)));
        if (control.tagName === "INPUT") for (const label of control.labels || []) labels.push(fieldText(label));
        return ZH[mode].some((label) => labels.some((value) => sameLabel(value, [label])));
      });
      return found.length ? one(found, "底价模式选项") : void 0;
    }
    async selectFloorMode(mode, checkpoint) {
      const advanced = elements(this.doc, 'a.advanced-settings-toggle, [role="button"]').filter((e) => containsLabel(txt(e), ["高级设置"]));
      if (advanced.length !== 1) throw new AdapterError("STRUCTURE", "高级设置入口不唯一");
      if ((advanced[0].getAttribute("aria-expanded") || "false") !== "true") {
        click(advanced[0], "展开高级设置");
      }
      const radio = await this.wait(() => this.floorRadio(mode), "等待底价模式选项");
      if (checkpoint) await checkpoint();
      click(radio, "选择底价模式");
      await this.wait(() => radio.getAttribute("aria-checked") === "true" || radio.checked === true, "回读底价模式");
    }
    async manualFloorControl(checkpoint) {
      await this.selectFloorMode("manual", checkpoint);
      const wrap = await this.wait(() => {
        const found = elements(this.doc, "manual-ecpm-floor-input");
        return found.length ? one(found, "全局底价输入组件") : void 0;
      }, "等待底价输入");
      const label = txt(wrap.querySelector(".global-ecpm-input-label"));
      if (!/全球/.test(label) || !/底价/.test(label)) throw new AdapterError("STRUCTURE", "底价组件不是全局底价，已停止");
      const input = one(elements(wrap, "input"), "全局底价输入框");
      if (currencyOf(input) !== "USD") throw new AdapterError("CURRENCY", "底价控件关联币种不是 USD");
      return { wrap, input };
    }
    async prepare(identity, format, name, floor, checkpoint, mode = "manual", partnerBidding = false) {
      this.prepared = void 0;
      this.submitted = false;
      await checkpoint();
      await this.assertIdentity(identity);
      if (!this.activeForm()) await this.selectFormat(format, identity);
      const form = required(this.activeForm(), "未识别到创建广告单元表单");
      await checkpoint();
      await this.assertIdentity(identity);
      const declared = this.formatLabel();
      if (!formatFrom(declared) || formatFrom(declared) !== format) throw new AdapterError("STRUCTURE", `创建表单广告格式“${declared || "未知"}”与请求不一致`);
      const partnerControlPresent = await this.setPartnerBidding(form, partnerBidding, checkpoint);
      const nameInput = this.nameInput(form);
      const counter = this.counter(form.closest("main") || this.doc);
      const maxLength = counter?.max ?? nameInput.maxLength;
      if (maxLength >= 0 && name.length > maxLength) throw new AdapterError("ROW", `名称超过当前页面上限 ${maxLength}，未截断`, false);
      await this.setInput(nameInput, name, "广告单元名称");
      let floorInput;
      if (!partnerBidding) {
        if (mode === "manual") {
          ({ input: floorInput } = await this.manualFloorControl(checkpoint));
          checkConstraints(floorInput, floor);
          await this.setInput(floorInput, normalizeDecimal(floor), "全局底价");
          if (!inputMatchesValue(floorInput, floor)) throw new AdapterError("ROW", "底价输入回读不一致，未执行提交", false);
        } else await this.selectFloorMode(mode, checkpoint);
      }
      const errors = this.errorText(form);
      if (errors) throw new AdapterError("ROW", errors, false);
      if (nameInput.getAttribute("aria-invalid") === "true" || floorInput?.getAttribute("aria-invalid") === "true") throw new AdapterError("ROW", "名称或底价未通过页面校验，未执行提交", false);
      const counterAfter = this.counter(form.closest("main") || this.doc);
      if (counterAfter && counterAfter.current !== name.length) throw new AdapterError("ROW", `名称计数回读为 ${counterAfter.current}/${counterAfter.max}，未执行提交`, false);
      const create = elements(this.doc, 'material-button.btn-yes, [role="button"]').filter((e) => sameLabel(txt(e), ["创建广告单元"]));
      const createButton = one(create, "创建广告单元按钮");
      if (!enabled(createButton)) throw new AdapterError("ROW", "创建广告单元按钮仍不可用，底价或名称未通过页面校验", false);
      this.assertPlatformDefaults(form);
      this.assertPartnerBidding(form, partnerBidding, partnerControlPresent);
      this.prepared = { identity, format, name, floor: !partnerBidding && mode === "manual" ? normalizeDecimal(floor) : "", mode, partnerBidding, partnerControlPresent, nameInput, floorInput, form };
    }
    async submit(beforeClick) {
      const state = this.prepared;
      if (!state || this.submitted) throw new AdapterError("SUBMIT_GUARD", "当前表单未通过准备或已经执行过提交");
      await this.assertIdentity(state.identity);
      const form = this.activeForm();
      if (!form || form !== state.form) throw new AdapterError("STRUCTURE", "提交前表单被替换，需重新预检");
      const nameInput = this.nameInput(form);
      if (nameInput.value !== state.name) throw new AdapterError("STRUCTURE", "提交前名称发生变化");
      if (!state.partnerBidding) {
        const radio = required(this.floorRadio(state.mode), "提交前缺少底价模式选项");
        if (!(radio.getAttribute("aria-checked") === "true" || radio.checked === true)) throw new AdapterError("STRUCTURE", "提交前底价模式发生变化");
        if (state.mode === "manual") {
          const floorWrap = required(this.doc.querySelector("manual-ecpm-floor-input"), "提交前缺少底价组件");
          const floorInput = required(floorWrap.querySelector("input"), "提交前缺少底价输入");
          if (!inputMatchesValue(floorInput, state.floor)) throw new AdapterError("STRUCTURE", "提交前名称或底价发生变化");
          if (currencyOf(floorInput) !== "USD") throw new AdapterError("CURRENCY", "提交前底价币种不是 USD");
          checkConstraints(floorInput, state.floor);
        }
      }
      if (formatFrom(this.formatLabel()) !== state.format) throw new AdapterError("STRUCTURE", "提交前广告格式发生变化");
      const create = elements(this.doc, 'material-button.btn-yes, [role="button"]').filter((e) => sameLabel(txt(e), ["创建广告单元"]));
      const createButton = one(create, "提交前创建按钮");
      if (!enabled(createButton)) throw new AdapterError("ROW", "提交前创建按钮不可用", false);
      this.assertPlatformDefaults(form);
      this.assertPartnerBidding(form, state.partnerBidding, state.partnerControlPresent);
      beforeClick?.();
      this.submitted = true;
      click(createButton, "创建广告单元");
    }
    async verifyById(identity, unitId, name, format, floor, mode = "manual", partnerBidding = false) {
      await this.assertIdentity(identity);
      if (!UNIT_RX.test(unitId) || !unitId.startsWith(`ca-app-${identity.publisherId}/`)) {
        throw new AdapterError("VERIFY", "已知广告位 ID 与当前发布商不匹配", true, { unitId, publisherId: identity.publisherId, appId: identity.appId });
      }
      const app = identity.appId.match(APP_RX);
      const known = unitId.match(UNIT_RX);
      if (!app || !known || app[1] !== known[1] || `pub-${app[1]}` !== identity.publisherId) throw new AdapterError("IDENTITY", "应用和广告单元的发布商不一致");
      const listPath = `/v2/apps/${app[2]}/adunits/list`;
      let directlyOpened = false;
      if (this.canRouteWithinDocument()) {
        const detailPath = `/v2/apps/${app[2]}/adunits/${known[2]}/edit`;
        let fingerprint = "", firstObserved = 0;
        const settled = () => {
          if (this.doc.location.pathname !== detailPath || this.activeForm() || this.savedField("广告单元 ID") !== unitId) {
            fingerprint = "";
            return false;
          }
          const savedName2 = this.savedField("广告单元名称"), savedFormat2 = this.savedField("广告格式");
          const savedFloor = partnerBidding ? void 0 : this.savedField("有效每千次展示费用底价");
          if (savedName2 === void 0 || savedFormat2 === void 0 || !partnerBidding && savedFloor === void 0) {
            fingerprint = "";
            return false;
          }
          const current = JSON.stringify([unitId, savedName2, savedFormat2, savedFloor]);
          if (current !== fingerprint) {
            fingerprint = current;
            firstObserved = Date.now();
            return false;
          }
          return Date.now() - firstObserved >= 200;
        };
        for (let attempt = 0; attempt < 2 && !directlyOpened; attempt++) {
          try {
            await this.routeWithinDocument(detailPath, settled, "按已知 ID 打开保存后配置", this.timeout);
            directlyOpened = true;
          } catch (error) {
            if (settled()) {
              directlyOpened = true;
              break;
            }
            if (!(error instanceof AdapterError) || error.code !== "TIMEOUT" || attempt === 1) break;
            this.targetListApp(identity);
          }
        }
      }
      if (!directlyOpened) {
        await this.home(identity);
        const search = this.searchInput();
        if (!search) throw new AdapterError("VERIFY", "未找到广告单元搜索框，无法按已知 ID 核验");
        await this.setInput(search, unitId, "按已知广告位 ID 搜索");
        try {
          this.grid()?.scrollIntoView({ block: "start", inline: "nearest" });
        } catch {
        }
        const matches = await this.wait(() => {
          if (this.searchInput()?.value.trim() !== unitId) return void 0;
          const exact = this.rows().filter((candidate) => this.rowInfo(candidate)?.unitId === unitId);
          return exact.length ? exact : void 0;
        }, "等待已知广告位 ID 搜索结果", 2e4).catch((error) => {
          if (error instanceof AdapterError && error.code === "TIMEOUT") return [];
          throw error;
        });
        if (matches.length !== 1) throw new AdapterError("VERIFY", "按已知广告位 ID 未找到唯一记录", true, { unitId, publisherId: identity.publisherId, appId: identity.appId });
        const row = matches[0];
        const cell = row.querySelector('ess-cell[essfield="ad-unit-with-id-info"]');
        const clickable = cell?.querySelector('a[href*="/adunits/"], .u-primary-text.u-clickable-link, [role="link"]') || cell || row;
        click(clickable, "打开已知广告位保存后编辑页");
        await this.wait(() => !this.onListRoute() && !this.activeForm() && this.savedField("广告单元 ID"), "等待已知广告位保存后编辑页");
      }
      await this.assertIdentity(identity);
      const savedUnit = this.savedField("广告单元 ID");
      const savedName = this.savedField("广告单元名称");
      const savedFormat = formatFrom(this.savedField("广告格式"));
      const parsed = partnerBidding ? { mode: "partner-bidding", floor: "", currency: "", verified: true } : this.savedFloor(this.savedField("有效每千次展示费用底价"));
      const actual = {
        unitId,
        publisherId: identity.publisherId,
        appId: identity.appId,
        name: savedName,
        format: savedFormat,
        mode: parsed.mode,
        floor: parsed.floor ?? (parsed.mode === "auto" || parsed.mode === "disabled" ? "" : void 0),
        currency: parsed.currency,
        verified: false
      };
      if (savedUnit !== unitId) throw new AdapterError("VERIFY", "保存后编辑页广告位 ID 与已知 ID 不一致", true, actual);
      if (savedName !== name) throw new AdapterError("VERIFY", "保存后广告单元名称与请求不一致", true, actual);
      if (savedFormat !== format) throw new AdapterError("VERIFY", "保存后广告格式与请求不一致", true, actual);
      if (!partnerBidding && (!parsed.verified || !matchesFloor(parsed, floor, mode))) {
        throw new AdapterError("VERIFY", "保存后底价模式或金额与请求不一致", true, actual);
      }
      this.assertSavedPartnerBidding(partnerBidding, actual);
      actual.verified = true;
      try {
        if (directlyOpened) await this.routeWithinDocument(listPath, () => this.listReady(app[2]), "返回广告单元列表", 4e3, true);
        else await this.backToList(identity);
      } catch {
      }
      return actual;
    }
    creationReceipt() {
      const instructionScopes = elements(this.doc, ".instructions-container .instructions").filter((scope2) => elements(scope2, "ol > li").some((li) => /请使用下面的广告单元\s*ID\s*来集成代码/.test(txt(li))));
      if (!instructionScopes.length) return void 0;
      const fail = (message) => {
        throw new AdapterError("VERIFY", "创建完成说明：" + message);
      };
      if (instructionScopes.length !== 1) return fail("出现多个成功说明区域，不能确认本次广告单元");
      const scope = instructionScopes[0];
      const rows = elements(scope, "ol > li");
      const unitRows = rows.filter((li) => /请使用下面的广告单元\s*ID\s*来集成代码/.test(txt(li)));
      const appRows = rows.filter((li) => /使用下面这个应用\s*ID\s*完成/.test(txt(li)));
      if (unitRows.length !== 1 || appRows.length !== 1) return fail("应用 ID 或广告单元 ID 的说明行不唯一");
      const card = (row) => {
        const copies = elements(row, "div.copy-button[data-value]");
        if (copies.length !== 1) return fail("说明行的复制 ID 控件不唯一");
        const copy = copies[0];
        const value = copy.previousElementSibling;
        const id = copy.getAttribute("data-value") || "";
        if (!value || !visible(value) || txt(value) !== id) return fail("复制 ID 与相邻可见文字不一致");
        const images = copy.parentElement ? elements(copy.parentElement, "img[alt]") : [];
        if (images.length !== 1 || !images[0].getAttribute("alt")?.trim()) return fail("ID 卡片缺少唯一名称");
        return { id, name: images[0].getAttribute("alt"), image: images[0] };
      };
      const unit = card(unitRows[0]);
      const app = card(appRows[0]);
      const unitMatch = unit.id.match(UNIT_RX);
      const appMatch = app.id.match(APP_RX);
      if (!unitMatch || !appMatch) return fail("应用 ID 与广告单元 ID 类型或格式不正确");
      if (unitMatch[1] !== appMatch[1] || routeAppId(this.doc) !== appMatch[2]) return fail("发布商或应用与当前应用路由不一致");
      const formats = /* @__PURE__ */ new Set();
      for (const link of elements(unitRows[0], "a[href]")) {
        const url = new URL(link.getAttribute("href"), this.doc.location.href);
        if (url.hostname !== "developers.google.com") continue;
        const match = url.pathname.match(/^\/admob\/(?:android|ios)\/(banner|interstitial|rewarded-interstitial|rewarded|app-open|native)(?:\/|$)/);
        if (match) formats.add(match[1]);
      }
      if (formats.size !== 1) return fail("广告单元植入指南未明确对应唯一广告格式");
      const format = [...formats][0];
      const iconFormat = (unit.image.getAttribute("src") || "").match(/admob_format_(banner|interstitial|rewarded_interstitial|rewarded-interstitial|rewarded|app_open|app-open|native)_icon/);
      if (iconFormat && iconFormat[1].replaceAll("_", "-") !== format) return fail("广告格式图标与植入指南冲突");
      return { unitId: unit.id, appId: app.id, publisherId: `pub-${unitMatch[1]}`, name: unit.name, appName: app.name, format };
    }
    recoverCreatedId(identity, name, format) {
      const receipt = this.creationReceipt();
      if (!receipt) return void 0;
      if (receipt.publisherId !== identity.publisherId || receipt.appId !== identity.appId || receipt.appName !== identity.appName) {
        throw new AdapterError("VERIFY", "创建完成说明的发布商或应用与本任务不一致");
      }
      if (receipt.name !== name || receipt.format !== format) throw new AdapterError("VERIFY", "创建完成说明的广告单元名称或格式与本任务不一致");
      return receipt.unitId;
    }
    async waitForUnitId() {
      const unitId = await this.wait(() => {
        const receipt = this.creationReceipt();
        if (receipt) return receipt.unitId;
        if (this.onListRoute() || this.activeForm()) return void 0;
        const saved = this.savedField("广告单元 ID");
        if (saved && UNIT_RX.test(saved)) return saved;
        return void 0;
      }, "等待真实广告单元 ID");
      if (!UNIT_RX.test(unitId)) throw new AdapterError("VERIFY", "取得的广告单元 ID 格式无效", true);
      return unitId;
    }
    async verify(identity, format, name, floor, mode = "manual", partnerBidding = false) {
      await this.assertIdentity(identity);
      const unitId = await this.waitForUnitId();
      const partial = { unitId, publisherId: identity.publisherId, appId: identity.appId, verified: false };
      try {
        if (!unitId.startsWith(`ca-app-${identity.publisherId}/`)) throw new AdapterError("IDENTITY", "广告单元 ID 所属发布商不一致");
        if (this.creationReceipt()) {
          if (this.recoverCreatedId(identity, name, format) !== unitId) throw new AdapterError("VERIFY", "创建完成说明的广告单元 ID 发生变化");
          return await this.verifyById(identity, unitId, name, format, floor, mode, partnerBidding);
        }
        if (this.activeForm()) throw new AdapterError("VERIFY", "仍停留在可编辑创建表单，不能作为已保存配置证据");
        const savedUnit = this.savedField("广告单元 ID");
        if (savedUnit !== unitId) throw new AdapterError("VERIFY", "保存后详情的广告单元 ID 与最初取得的 ID 不一致");
        const savedName = this.savedField("广告单元名称");
        const savedFormat = formatFrom(this.savedField("广告格式"));
        const parsed = partnerBidding ? { mode: "partner-bidding", floor: "", currency: "", verified: true } : this.savedFloor(this.savedField("有效每千次展示费用底价"));
        Object.assign(partial, { name: savedName, format: savedFormat, mode: parsed.mode, floor: parsed.floor ?? (parsed.mode === "auto" || parsed.mode === "disabled" ? "" : void 0), currency: parsed.currency });
        if (!savedName || !savedFormat || !partnerBidding && (parsed.mode === "unknown" || mode === "manual" && !parsed.floor)) throw new AdapterError("VERIFY", "已取得 ID，但保存后页面缺少名称、格式或底价字段");
        if (savedName !== name || savedFormat !== format || !partnerBidding && !matchesFloor(parsed, floor, mode)) {
          throw new AdapterError("VERIFY", "已创建，但保存后配置与请求不一致");
        }
        this.assertSavedPartnerBidding(partnerBidding, partial);
        return { ...partial, verified: true };
      } catch (error) {
        if (error instanceof AdapterError) {
          error.actual = { ...partial, ...error.actual || {} };
          throw error;
        }
        throw new AdapterError("VERIFY", "已取得 ID，但保存后的配置无法可靠读取", true, partial);
      }
    }
    diagnostics() {
      const redact = (s) => s.replace(/ca-app-pub-\d{16}[~/]\d+/g, "[已隐去广告ID]").replace(/pub-\d+/g, "[已隐去发布商ID]").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[已隐去邮箱]");
      const knownLabels = Object.values(ZH).flat();
      const numericAttr = (e, key) => {
        const s = e.getAttribute(key);
        return s && /^(?:\d+(?:\.\d+)?|any)$/.test(s) ? s : void 0;
      };
      const safeLabel = (s) => knownLabels.find((x) => compact(x) === compact(s)) || (s.includes("US$") ? "[关联标签含US$]" : s.includes("USD") ? "[关联标签含USD]" : s.includes("$") ? "[关联标签仅含$]" : "[未在诊断白名单中的文字]");
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
      return { adapter: "live-chromium126-2026-11-13", time: (/* @__PURE__ */ new Date()).toISOString(), origin: this.doc.location?.origin, controls: items, omitted: "不导出 URL 路径、查询参数、DOM HTML、输入值、账号 ID、应用名、Cookie、Token、密码或任意页面正文" };
    }
  };

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
    return batch.phase === "running" && busy < (batch.execution === "tabs" ? batch.concurrency : 1);
  }
  function canSubmitPrepared(batch, task) {
    if (!batch || batch.phase !== "running" || !batch.tasks.some((row) => row.id === task.id && row.assignmentId === task.assignmentId && row.workerId === task.workerId)) return false;
    if (batch.execution !== "tabs" || batch.canaryPassed) return true;
    const first = batch.tasks.find((row) => !["success", "exists", "failed", "conflict", "stopped"].includes(row.status));
    return first?.id === task.id;
  }
  function canRecoverUnsubmitted(job, batch, command, journal) {
    const task = batch.tasks.find((task2) => task2.id === job.task.id);
    return job.kind === "create" && batch.id === job.batch.id && batch.identity.publisherId === job.batch.identity.publisherId && batch.identity.appId === job.batch.identity.appId && command.job?.assignmentId === job.assignmentId && command.job.workerId === job.workerId && !!task && task.assignmentId === job.assignmentId && task.workerId === job.workerId && ["pending", "filling", "uncertain"].includes(task.status) && !task.intentAt && !task.actual && !command.grant && journal?.state === "filling" && journal.assignmentId === job.assignmentId && journal.taskId === task.id && journal.batchId === batch.id;
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
  var PREVIEW_STYLE = `
.prefix-switch,.bidding-option{display:inline-flex;align-items:center;gap:7px;cursor:pointer}
.input-table input[readonly]{background:#f1f5fa;color:#324c6b}
.creation-preview{width:min(790px,calc(100vw - 32px));max-height:calc(100vh - 48px);padding:18px 20px;border:1px solid #bac9dc;border-radius:10px;color:#192331;background:white;box-shadow:0 12px 44px #12263f44}
.creation-preview::backdrop{background:#12263f80}
.creation-preview .table-scroll{max-height:min(45vh,380px);margin:12px 0}
.creation-preview td{overflow-wrap:anywhere}
.creation-preview th:first-child{min-width:140px}
.preview-actions{justify-content:flex-end}
.run-feedback{position:sticky;top:0;z-index:3;padding:8px 14px;background:white;border-bottom:1px solid #d5e1ef}
.run-feedback .notice{margin:0}
.run-feedback a{display:inline-block;margin-top:6px;padding:5px 9px;color:#155db4;border:1px solid #bac9dc;border-radius:5px}
.run-feedback a[hidden]{display:none}
`;
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
    shadow.append(element("style", STYLE + PREVIEW_STYLE));
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
    let pendingPreview;
    let renderedBatch = "";
    let restoredBatchId = "";
    let lastBatchPhase = "";
    let editorBatchId = "";
    const clearedStoppedEditors = /* @__PURE__ */ new Set();
    const updateObservedInputs = [];
    const editableControls = [];
    const buttons = {};
    const feedback = element("div", void 0, "run-feedback");
    feedback.hidden = true;
    const notice = element("div", "", "notice");
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    feedback.append(notice);
    body.append(feedback);
    const section = (heading) => {
      const n = element("section");
      n.append(element("h3", heading));
      body.append(n);
      return n;
    };
    const accountSection = section("当前页面");
    const identityList = element("dl", void 0, "identity");
    const identityValues = {};
    for (const [key, label] of [["publisherId", "发布商 ID"], ["appName", "当前应用"], ["appId", "AdMob App ID"]]) {
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
      b.dataset.action = key;
      b.addEventListener("click", () => {
        if (!b.disabled) void invoke(callback);
      });
      return b;
    }
    const accountActions = element("div", void 0, "actions spacer");
    const workerLink = element("a", "打开执行页");
    workerLink.dataset.action = "open-worker";
    workerLink.target = "_blank";
    workerLink.rel = "noopener";
    workerLink.hidden = true;
    accountActions.append(button("identify", "重新识别", actions.identify), button("probe", "检测跨页能力", actions.probe), button("diagnostics", "导出脱敏诊断", actions.diagnostics));
    feedback.append(workerLink);
    accountSection.append(accountActions, capabilities);
    accountSection.append(element("p", "按所选底价模式创建，每条取得新 ID 后自动核验保存配置。", "muted spacer"));
    const settings = section("整批设置");
    const config = element("div", void 0, "config");
    const format = element("select");
    format.setAttribute("aria-label", "广告格式");
    for (const value of ["interstitial", "app-open", "banner", "native", "rewarded", "rewarded-interstitial"]) {
      format.append(option(value, value === "interstitial" ? "插页式 / 插屏" : FORMAT_ZH[value]));
    }
    const mode = element("select");
    mode.setAttribute("aria-label", "底价模式");
    for (const value of ["manual", "auto", "disabled"]) mode.append(option(value, MODE_ZH[value]));
    mode.value = "manual";
    const partnerBidding = element("input");
    partnerBidding.type = "checkbox";
    partnerBidding.setAttribute("aria-label", "合作平台出价");
    const biddingLabel = element("label", void 0, "bidding-option spacer");
    biddingLabel.append(partnerBidding, element("span", "合作平台出价"));
    partnerBidding.addEventListener("change", () => {
      if (partnerBidding.checked) applyPrefix.checked = false;
      invalidate();
      renderRows();
    });
    const execution = element("select");
    execution.setAttribute("aria-label", "执行方式");
    execution.append(option("paged", "并发"), option("single", "串行（当前页逐条执行）"));
    const controls = [["广告格式", format], ["底价模式", mode], ["执行方式", execution]];
    for (const [labelText, control] of controls) {
      const label = element("label", void 0, "field");
      label.append(element("span", labelText), control);
      config.append(label);
    }
    editableControls.push(format, mode, execution, partnerBidding);
    settings.append(config, biddingLabel);
    const modeNote = element("p", "", "muted spacer mode-note");
    settings.append(modeNote);
    const biddingNote = element("p", "", "muted spacer");
    settings.append(biddingNote);
    execution.addEventListener("change", () => invalidate());
    format.addEventListener("change", () => {
      if (format.value === "rewarded-interstitial") partnerBidding.checked = false;
      invalidate();
      renderRows();
    });
    mode.addEventListener("change", () => {
      if (mode.value !== "manual") applyPrefix.checked = false;
      invalidate();
      renderRows();
    });
    const inputSection = element("section");
    body.append(inputSection);
    const add = element("button", "增加一行");
    add.type = "button";
    add.addEventListener("click", () => {
      inputRows.push({ line: Math.max(0, ...inputRows.map((r) => r.line)) + 1, name: "", floor: "", errors: [] });
      invalidate();
      renderRows();
      const row = rowNodes.at(-1);
      (applyPrefix.checked ? row?.floor : row?.name)?.focus();
    });
    editableControls.push(add);
    const prefixRow = element("div", void 0, "actions spacer");
    const prefix = element("input");
    prefix.type = "text";
    prefix.placeholder = "例如 admob_int_";
    prefix.setAttribute("aria-label", "名称前缀");
    const applyPrefix = element("input");
    applyPrefix.type = "checkbox";
    applyPrefix.setAttribute("role", "switch");
    applyPrefix.setAttribute("aria-label", "批量应用前缀");
    const prefixLabel = element("label", void 0, "prefix-switch");
    prefixLabel.append(applyPrefix, element("span", "批量应用前缀"));
    applyPrefix.addEventListener("change", () => {
      invalidate();
      validateRows();
    });
    prefix.addEventListener("input", () => {
      invalidate();
      validateRows();
    });
    prefixRow.append(prefixLabel, prefix);
    inputSection.append(prefixRow);
    const inputSummary = element("p", "暂无广告位。", "summary");
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
    inputSection.append(add);
    const runSection = section("执行任务");
    const checklist = element("ul", void 0, "checks");
    runSection.append(checklist);
    const runActions = element("div", void 0, "actions");
    runActions.append(button("start", "开始创建", async () => openPreview(), "primary"), button("pause", "暂停", actions.pause), button("resume", "继续", actions.resume), button("stop", "停止", actions.stop, "danger"));
    const preview = element("dialog", void 0, "creation-preview");
    preview.setAttribute("role", "dialog");
    preview.setAttribute("aria-modal", "true");
    const previewTitle = element("h2", "创建预览");
    previewTitle.id = "abc-preview-title";
    preview.setAttribute("aria-labelledby", previewTitle.id);
    const previewApp = element("dl", void 0, "identity");
    const previewTable = element("table");
    previewTable.setAttribute("aria-label", "即将创建的广告单元");
    const previewHead = element("thead");
    const previewHeadRow = element("tr");
    for (const label of ["广告位名称", "格式", "广告类型", "频次上限", "底价", "合作平台出价"]) previewHeadRow.append(element("th", label));
    previewHead.append(previewHeadRow);
    const previewRows = element("tbody");
    previewTable.append(previewHead, previewRows);
    const previewScroll = element("div", void 0, "table-scroll");
    previewScroll.tabIndex = 0;
    previewScroll.append(previewTable);
    const previewActions = element("div", void 0, "actions preview-actions");
    const cancelPreview = element("button", "取消");
    cancelPreview.type = "button";
    cancelPreview.dataset.action = "cancel-preview";
    cancelPreview.autofocus = true;
    cancelPreview.addEventListener("click", closePreview);
    preview.addEventListener("cancel", (event) => {
      event.preventDefault();
      closePreview();
    });
    previewActions.append(cancelPreview, button("confirm-create", "确认创建", confirmPreview, "primary"));
    preview.append(previewTitle, previewApp, previewScroll, previewActions);
    shadow.append(preview);
    const recoveryActions = element("div", void 0, "actions spacer");
    recoveryActions.append(button("retry", "重试明确失败项", actions.retry), button("verify", "核验结果不确定项", async () => {
      const archive = displayedArchive();
      if (archive && actions.verifyHistory) await actions.verifyHistory(archive.id);
      else await actions.verify();
    }), button("degrade", "降级为单页", actions.degrade));
    if (actions.switchToPaged) recoveryActions.append(button("switch-to-paged", "改为并发", actions.switchToPaged));
    buttons.degrade.title = "停止增加执行标签页，保留旧执行页并继续收集其结果；后续任务在当前页执行";
    runSection.append(runActions, recoveryActions);
    const resumeHint = element("p", "", "muted spacer");
    resumeHint.setAttribute("aria-live", "polite");
    runSection.append(resumeHint);
    const resultSection = section("结果");
    const historyRow = element("div", void 0, "actions");
    const historySelect = element("select");
    historySelect.setAttribute("aria-label", "任务批次");
    historySelect.append(option("", "当前任务"));
    historySelect.addEventListener("change", () => {
      closePreview();
      if (actions.viewHistory) void invoke(() => actions.viewHistory(historySelect.value));
    });
    historyRow.append(element("span", "历史结果"), historySelect);
    if (actions.history) historyRow.append(button("history", "刷新历史", actions.history));
    resultSection.append(historyRow);
    const batchMeta = element("p", "暂无批次", "muted batch-meta");
    const resultSummary = element("p", "", "summary");
    const batchTiming = element("p", "", "summary batch-timing");
    const resultScroll = element("div", void 0, "table-scroll");
    const resultTable = element("table", void 0, "result-table");
    resultTable.setAttribute("aria-label", "广告单元创建结果");
    const resultHead = element("thead");
    const resultHeadRow = element("tr");
    for (const name of ["原行", "广告位名称", "请求底价 / 模式", "实际底价 / 模式", "状态", "广告位 ID", "原因"]) resultHeadRow.append(element("th", name));
    resultHead.append(resultHeadRow);
    const resultTbody = element("tbody");
    resultTable.append(resultHead, resultTbody);
    resultScroll.append(resultTable);
    const exports = element("div", void 0, "actions spacer");
    exports.append(button("export-all", "导出全部", () => actions.export("all", historySelect.value || void 0)), button("export-success", "导出成功", () => actions.export("success", historySelect.value || void 0)), button("export-exceptions", "导出异常", () => actions.export("exceptions", historySelect.value || void 0)), button("copy", "复制“名称 + ID”", () => actions.copy(historySelect.value || void 0)));
    resultSection.append(batchMeta, batchTiming, resultSummary, resultScroll, exports);
    const logsDetails = element("details");
    logsDetails.append(element("summary", "查看执行日志"));
    const logs = element("div", "", "log spacer");
    logsDetails.append(logs);
    resultSection.append(logsDetails);
    body.append(element("div", "记录仅保存在当前浏览器配置。停止不会删除已创建的广告单元。", "footer"));
    const rowNodes = [];
    function restoreDraftInput(batch) {
      if (!batch || batch.phase === "done" || inputRows.length || restoredBatchId === batch.id) return;
      inputRows = batch.tasks.map((task) => ({ line: task.line, name: task.name, floor: task.floor, errors: [] }));
      restoredBatchId = batch.id;
      editorBatchId = batch.id;
      renderRows();
    }
    function stoppedArchive(batch) {
      return batch?.phase === "done" && !!batch.stopRequestedAt;
    }
    function displayedArchive() {
      const batch = historySelect.value ? state.historyBatch : state.batch;
      return stoppedArchive(batch) ? batch : void 0;
    }
    function retireStoppedEditor(batch) {
      if (!stoppedArchive(batch) || clearedStoppedEditors.has(batch.id)) return;
      clearedStoppedEditors.add(batch.id);
      const rows = reviewedRows();
      const matches = rows.length > 0 && rows.length === batch.tasks.length && rows.every((row, index) => row.name === batch.tasks[index].name && row.floor === batch.tasks[index].floor);
      if (editorBatchId !== batch.id && !matches) return;
      inputRows = [];
      editorBatchId = "";
      applyPrefix.checked = false;
      state.ready = false;
      state.checks = [];
      closePreview();
      renderRows();
    }
    function reviewedRows() {
      const automaticNames = applyPrefix.checked && manualFloor();
      const prefixText = prefix.value.trim();
      const names = /* @__PURE__ */ new Map();
      const rows = inputRows.map((row) => {
        let name = row.name;
        if (automaticNames) {
          let suffix = "";
          try {
            suffix = normalizeDecimal(row.floor);
          } catch {
          }
          name = prefixText && suffix ? prefixText + suffix : "";
        }
        const floor = partnerBidding.checked ? "" : row.floor;
        const parsed = parseInput(`广告位名称,底价USD\r
${csvCell2(name)},${csvCell2(floor)}`, { mode: requestedMode() })[0];
        const errors = parsed?.errors ?? ["广告位名称不能为空"];
        if (automaticNames && !prefixText) errors.push("请输入名称前缀");
        if (automaticNames && name) names.set(name, (names.get(name) ?? 0) + 1);
        return { line: row.line, name, floor: parsed?.floor ?? floor, errors };
      });
      for (const row of rows) if ((names.get(row.name) ?? 0) > 1) row.errors.push("按底价生成的广告位名称重复");
      return rows;
    }
    function validateRows() {
      const rows = reviewedRows();
      const errors = rows.filter((row) => row.errors.length).length;
      inputSummary.textContent = rows.length ? `${rows.length} 个广告位${errors ? `，${errors} 行待修正` : ""}` : "暂无广告位。";
      rowNodes.forEach((nodes, index) => {
        const row = rows[index];
        inputRows[index].errors = row.errors;
        nodes.name.readOnly = applyPrefix.checked;
        if (nodes.name.value !== row.name) nodes.name.value = row.name;
        nodes.error.textContent = row.errors.join("；");
        nodes.errorRow.hidden = !row.errors.length;
        nodes.name.setAttribute("aria-invalid", String(row.errors.some((error) => /名称|重复|列数|解析/.test(error))));
        nodes.floor.setAttribute("aria-invalid", String(row.errors.some((error) => /底价|金额|数字|十进制|列数|解析/.test(error))));
      });
      updateControls();
    }
    function renderRows() {
      inputTbody.replaceChildren();
      rowNodes.length = 0;
      inputHeadRow.cells[2].hidden = !manualFloor();
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
        floorCell.hidden = !manualFloor();
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
        nameInput.addEventListener("input", () => {
          if (!applyPrefix.checked) row.name = nameInput.value;
          invalidate();
          validateRows();
        });
        floorInput.addEventListener("input", () => {
          row.floor = floorInput.value;
          invalidate();
          validateRows();
        });
      }
      validateRows();
    }
    function requestedMode() {
      return partnerBidding.checked ? "disabled" : mode.value;
    }
    function manualFloor() {
      return requestedMode() === "manual";
    }
    function getConfig() {
      const rows = reviewedRows();
      const text = rows.map((row) => `${csvCell2(row.name)},${csvCell2(row.floor)}`).join("\r\n");
      return { format: format.value, mode: requestedMode(), partnerBidding: partnerBidding.checked, concurrency: 1, execution: execution.value, text, rows };
    }
    function displayedIdentity() {
      const identity = state.identity;
      if (state.identityError || !identity || !/^pub-\d{16}$/.test(identity.publisherId) || !/^ca-app-pub-\d{16}~\d{10}$/.test(identity.appId) || !identity.appId.startsWith(`ca-app-${identity.publisherId}~`)) return void 0;
      return { publisherId: identity.publisherId, appId: identity.appId };
    }
    function openPreview() {
      const identity = displayedIdentity();
      const config2 = getConfig();
      if (!identity || !config2.rows.length || config2.rows.some((row) => row.errors.length) || isFrozen() || historySelect.value) return;
      pendingPreview = { ...config2, confirmedIdentity: identity };
      previewApp.replaceChildren();
      for (const [label, value] of [
        ["应用", state.identity.appName],
        ["AdMob App ID", identity.appId],
        ["发布商 ID", identity.publisherId]
      ]) previewApp.append(element("dt", label), element("dd", value));
      const floorMode = config2.mode ?? "manual";
      previewRows.replaceChildren(...config2.rows.map((row) => {
        const tr = element("tr");
        const floor = config2.partnerBidding ? "不适用" : floorMode === "manual" ? `${row.floor} USD / 千次` : MODE_ZH[floorMode];
        const reward = config2.format === "rewarded" || config2.format === "rewarded-interstitial";
        const formatLabel = FORMAT_ZH[config2.format] + (reward ? `（${REWARD_DEFAULT.amount} ${REWARD_DEFAULT.item}）` : "");
        const media = config2.partnerBidding ? "不适用" : MEDIA_DEFAULTS[config2.format].join(" + ");
        const frequency = config2.partnerBidding || config2.format === "banner" || config2.format === "native" ? "不适用" : "已停用";
        for (const value of [row.name, formatLabel, media, frequency, floor, config2.partnerBidding ? "已勾选" : "未勾选"]) tr.append(element("td", value));
        return tr;
      }));
      if (typeof preview.showModal === "function") preview.showModal();
      else preview.setAttribute("open", "");
      updateControls();
      cancelPreview.focus();
    }
    function closePreview() {
      pendingPreview = void 0;
      if (!preview.open) return;
      if (typeof preview.close === "function") preview.close();
      else preview.removeAttribute("open");
      updateControls();
      if (!buttons.start.disabled) buttons.start.focus();
    }
    async function confirmPreview() {
      const confirmed = pendingPreview;
      if (!confirmed || !preview.open || isFrozen() || historySelect.value || state.busy) return;
      const current = { ...getConfig(), confirmedIdentity: displayedIdentity() };
      closePreview();
      if (JSON.stringify(current) !== JSON.stringify(confirmed)) throw new Error("应用或广告位设置发生变化，请重新预览");
      await actions.start(confirmed);
    }
    function invalidate() {
      state.ready = false;
      state.checks = [];
      closePreview();
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
      const busy = isBusy(), viewingHistory = !!historySelect.value, frozen = isFrozen() || viewingHistory, batch = state.batch;
      const locked = busy || frozen || !!pendingPreview;
      editableControls.forEach((control) => {
        control.disabled = locked;
      });
      mode.disabled = locked || partnerBidding.checked || applyPrefix.checked;
      partnerBidding.disabled = locked || format.value === "rewarded-interstitial";
      biddingNote.textContent = format.value === "rewarded-interstitial" ? "插页式激励广告不支持合作平台出价。" : partnerBidding.checked ? "合作平台出价不设置底价。" : "";
      modeNote.textContent = execution.value === "single" ? "在当前页逐条创建和核验。" : "按任务数量批量打开创建页，再逐页创建、核验和关闭。";
      applyPrefix.disabled = locked || !manualFloor();
      prefix.disabled = locked || !manualFloor();
      rowNodes.forEach((nodes) => {
        nodes.name.disabled = locked;
        nodes.floor.disabled = locked;
        nodes.remove.disabled = locked;
      });
      const identity = displayedIdentity();
      Object.values(buttons).forEach((b) => {
        b.disabled = busy || !!pendingPreview;
      });
      buttons["confirm-create"].disabled = busy || frozen || !pendingPreview || !identity;
      historySelect.disabled = busy || !!pendingPreview;
      const valid = inputRows.length > 0 && inputRows.every((row) => !row.errors.length);
      buttons.start.disabled = locked || !valid || !identity;
      buttons.pause.disabled = busy || batch?.phase !== "running";
      const unresolved = batch?.tasks.filter((t) => needsVerification(t) && !["success", "exists"].includes(t.status)).length ?? 0;
      const resumable = !viewingHistory && batch?.phase === "paused" && !!batch.confirmedAt && !batch.stopRequestedAt;
      const resumeBlocked = resumable && unresolved > 0;
      buttons.resume.disabled = busy || batch?.phase !== "paused" || !batch.confirmedAt || !!batch.stopRequestedAt || resumeBlocked;
      buttons.resume.title = resumeBlocked ? `还有 ${unresolved} 条提交结果或配置待核验，请先核验` : "";
      resumeHint.textContent = resumeBlocked ? `还有 ${unresolved} 条提交结果或配置待核验。请先点击“核验结果不确定项”，核验通过后再继续；只读预检和核验均不提交广告位。` : "";
      resumeHint.hidden = !resumeBlocked;
      buttons.stop.disabled = busy || !batch || !["draft", "running", "paused", "stopping"].includes(batch.phase);
      buttons.retry.disabled = busy || !batch || !!batch.stopRequestedAt || batch.phase === "running" || batch.phase === "stopping" || !batch.tasks.some((t) => t.status === "failed" && !t.intentAt && !t.actual?.unitId && t.attempts < 3);
      buttons.verify.disabled = busy || !batch || batch.phase === "running" || !batch.tasks.some((t) => ["uncertain", "created-unverified", "submitting", "verifying"].includes(t.status));
      buttons.degrade.disabled = busy || !batch || batch.execution !== "tabs" || !["running", "paused"].includes(batch.phase);
      if (buttons["switch-to-paged"]) buttons["switch-to-paged"].disabled = busy || viewingHistory || batch?.execution !== "tabs" || batch.phase !== "paused" || unresolved > 0;
      for (const key of ["pause", "resume", "stop", "retry", "degrade"]) if (viewingHistory) buttons[key].disabled = true;
      if (viewingHistory || stoppedArchive(batch)) {
        const archive = displayedArchive();
        buttons.verify.disabled = busy || !actions.verifyHistory || !archive || batch?.phase === "running" || batch?.phase === "stopping" || !archive.tasks.some((task) => needsVerification(task) && !["success", "exists"].includes(task.status));
      }
      for (const update of updateObservedInputs) update();
      for (const key of ["export-all", "export-success", "export-exceptions", "copy"]) buttons[key].disabled = busy || !(viewingHistory ? state.historyBatch : batch);
    }
    function renderNotice() {
      notice.textContent = state.notice ?? "";
      let valid = false;
      if (state.workerUrl) try {
        const url = new URL(state.workerUrl);
        valid = url.protocol === "https:" && ["admob.google.com", "apps.admob.com"].includes(url.hostname) && /^[\w-]{20,80}$/.test(url.searchParams.get("__admob_batch_worker") || "");
      } catch {
      }
      workerLink.hidden = !valid;
      feedback.hidden = !state.notice && !valid;
      if (valid) workerLink.href = state.workerUrl;
      else workerLink.removeAttribute("href");
    }
    function renderIdentity() {
      for (const key of ["publisherId", "appName", "appId"]) identityValues[key].textContent = state.identity?.[key] || "未识别";
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
      if (!state.checks?.length) checklist.append(element("li", "确认预览后检查账号和执行页，再创建广告位。", "muted"));
    }
    function renderHistory() {
      const selected = historySelect.value;
      const rows = new Map((state.history ?? []).map((batch) => [batch.id, batch]));
      if (state.batch) rows.set(state.batch.id, summarizeBatch(state.batch));
      historySelect.replaceChildren(option("", "当前任务"));
      for (const batch of [...rows.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
        if (batch.id === state.batch?.id) continue;
        historySelect.append(option(batch.id, `${batch.startedAt ? localTime(batch.startedAt) : "开始时间未知"} · ${FORMAT_ZH[batch.format]} · ${batch.succeeded}/${batch.total} 成功 · ${batch.id}`));
      }
      if ([...historySelect.options].some((item) => item.value === selected)) historySelect.value = selected;
    }
    function localTime(value) {
      return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未知";
    }
    function renderTiming() {
      const batch = historySelect.value ? state.historyBatch : state.batch;
      if (!batch) {
        batchTiming.textContent = "";
        return;
      }
      const summary = summarizeBatch(batch);
      batchTiming.textContent = `开始：${localTime(summary.startedAt)} · 结束：${localTime(summary.completedAt)} · 总耗时：${batchElapsed(summary)}（含检查、等待与暂停）`;
    }
    function renderResults() {
      const batch = historySelect.value ? state.historyBatch : state.batch;
      const signature = batch ? JSON.stringify(batch) : "";
      if (signature === renderedBatch) return;
      renderedBatch = signature;
      updateObservedInputs.length = 0;
      resultTbody.replaceChildren();
      if (!batch) {
        batchMeta.textContent = "暂无批次";
        resultSummary.textContent = "";
        logs.textContent = "";
        return;
      }
      const executionLabel = { paged: "并发", single: "串行", tabs: "旧版并行" }[batch.execution];
      const phaseLabel = stoppedArchive(batch) ? "已停止" : { draft: "待开始", running: "执行中", paused: "已暂停", stopping: "停止中，正在收集结果", done: "已结束" }[batch.phase];
      batchMeta.textContent = `批次 ${batch.id} · ${FORMAT_ZH[batch.format]} · ${phaseLabel} · ${executionLabel}`;
      const counts = /* @__PURE__ */ new Map();
      for (const task of batch.tasks) {
        counts.set(STATUS_ZH[task.status], (counts.get(STATUS_ZH[task.status]) ?? 0) + 1);
        const tr = element("tr");
        const actual = task.actual;
        const badge = element("span", STATUS_ZH[task.status], `badge ${["success", "exists"].includes(task.status) ? "good" : ["failed", "uncertain", "created-unverified", "conflict"].includes(task.status) ? "bad" : ""}`);
        const status = element("td");
        status.append(badge);
        const requested = batch.partnerBidding ? "不适用（合作平台出价）" : batch.mode === "manual" ? task.floor : MODE_ZH[batch.mode];
        const saved = actual?.mode === "partner-bidding" ? "不适用（合作平台出价）" : actual?.mode && actual.mode !== "manual" ? MODE_ZH[actual.mode] ?? "未读取" : actual?.floor ? `${actual.floor} ${actual.currency || "币种未确认"}` : "未读取";
        tr.append(element("td", String(task.line)), element("td", task.name), element("td", requested), element("td", saved), status, element("td", actual?.unitId || "—"), element("td", task.reason || "—", "error-cell"));
        const archived = stoppedArchive(batch);
        const canRecord = archived ? !!actions.recordHistoryObservedId : !historySelect.value && !!actions.recordObservedId && batch.phase === "paused";
        if (canRecord && task.intentAt && needsVerification(task) && !["success", "exists"].includes(task.status) && !actual?.unitId) {
          const cell = tr.cells[5];
          const id = element("input");
          id.placeholder = "成功说明中的广告位 ID";
          id.setAttribute("aria-label", `${task.name} 已观察到的广告位 ID`);
          const record = element("button", "记录 ID 并核验");
          record.type = "button";
          record.dataset.action = "record-observed-id";
          record.dataset.taskId = task.id;
          if (archived) record.dataset.batchId = batch.id;
          const update = () => {
            const blocked = localBusy || !!state.busy || archived && ["running", "stopping"].includes(state.batch?.phase || "");
            id.disabled = blocked;
            record.disabled = blocked || !new RegExp(`^ca-app-${batch.identity.publisherId}/\\d{10}$`).test(id.value.trim());
          };
          updateObservedInputs.push(update);
          id.addEventListener("input", update);
          update();
          record.addEventListener("click", () => {
            if (record.disabled) return;
            const unitId = id.value.trim();
            void invoke(async () => {
              if (archived) await actions.recordHistoryObservedId(batch.id, task.id, unitId);
              else await actions.recordObservedId(task.id, unitId);
            });
          });
          cell.append(id, record);
        }
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
    const panelView = host.ownerDocument.defaultView;
    const timingTimer = panelView.setInterval(renderTiming, 1e3);
    return {
      getConfig,
      update(patch) {
        const previousIdentity = state.identity;
        if (patch.identityError || "identity" in patch && (patch.identity?.publisherId !== previousIdentity?.publisherId || patch.identity?.appId !== previousIdentity?.appId || patch.identity?.appName !== previousIdentity?.appName)) closePreview();
        if (patch.batch) {
          const phase = `${patch.batch.id}:${patch.batch.phase}`;
          if (phase !== lastBatchPhase) closePreview();
          lastBatchPhase = phase;
        }
        Object.assign(state, patch);
        if (patch.batch && (isFrozen() || patch.batch.phase === "draft")) {
          const previouslyManual = manualFloor();
          format.value = patch.batch.format;
          mode.value = patch.batch.mode ?? "manual";
          execution.value = patch.batch.execution === "single" ? "single" : "paged";
          partnerBidding.checked = patch.batch.partnerBidding === true;
          if (!manualFloor()) applyPrefix.checked = false;
          if (previouslyManual !== manualFloor()) renderRows();
        }
        if (patch.batch) {
          const batch = patch.batch;
          retireStoppedEditor(batch);
          restoreDraftInput(batch);
          if (!stoppedArchive(batch) && ["draft", "running", "paused", "stopping"].includes(batch.phase)) {
            const rows = reviewedRows();
            if (rows.length === batch.tasks.length && rows.every((row, index) => row.name === batch.tasks[index].name && row.floor === batch.tasks[index].floor)) editorBatchId = batch.id;
          }
        }
        renderHistory();
        renderIdentity();
        renderNotice();
        renderChecks();
        renderResults();
        renderTiming();
        updateControls();
      },
      destroy() {
        panelView.clearInterval(timingTimer);
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
    if (typeof GM_getTab !== "function") return {};
    return new Promise((resolve) => {
      let settled = false;
      const finish = (tab) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(tab || {});
      };
      const timer = setTimeout(() => finish({}), 2e3);
      try {
        GM_getTab((tab) => finish(tab));
      } catch {
        finish({});
      }
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
  async function serializeSubmission(publisherId, submit) {
    if (!navigator.locks) throw new Error("当前环境不支持 Web Locks，无法保证账号提交间隔；已禁用创建");
    await navigator.locks.request("admob-batch-submit:" + publisherId, { mode: "exclusive" }, async () => {
      const clockKey = "lastClick:" + publisherId;
      const previous = get(clockKey, void 0);
      const last = previous?.pending ? Date.now() : previous?.at;
      const delay = last === void 0 ? 0 : Math.max(0, 2500 - (Date.now() - last));
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      let armed = false;
      try {
        await submit(() => {
          set(clockKey, { at: Date.now(), pending: true });
          armed = true;
        });
      } finally {
        if (armed) {
          try {
            set(clockKey, { at: Date.now(), pending: false });
          } catch {
          }
        }
      }
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
  async function waitFor(read, timeout = 15e3, watchKey) {
    const current = read();
    if (current !== void 0) return current;
    return new Promise((resolve, reject) => {
      let remove = () => {
      }, settled = false;
      const finish = () => {
        settled = true;
        clearInterval(poll);
        clearTimeout(timer);
        remove();
      };
      const check = () => {
        if (settled) return;
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
        check();
        if (settled) return;
        finish();
        reject(new Error("跨页通信等待超时；不会自动重派原任务"));
      }, timeout);
      if (watchKey) {
        try {
          remove = listen(watchKey, check);
        } catch {
        }
        if (settled) remove();
        else check();
      }
    });
  }

  // src/worker.ts
  function ownsJournal(job, journal) {
    return journal.assignmentId === job.assignmentId && journal.taskId === job.task.id && journal.batchId === job.batch.id;
  }
  function knownId(job, actual) {
    return !!actual?.unitId && /^ca-app-pub-\d{16}\/\d{10}$/.test(actual.unitId) && actual.unitId.startsWith(`ca-app-${job.batch.identity.publisherId}/`);
  }
  function ownsReport(job, report) {
    return report.assignmentId === job.assignmentId && report.taskId === job.task.id && report.workerId === job.workerId;
  }
  function persistStage(job, report) {
    const key = "journal:" + job.assignmentId;
    const previous = get(key, void 0);
    if (!previous || !ownsJournal(job, previous) || !ownsReport(job, report)) throw new Error("执行进度缺少匹配的持久化分配，已阻止覆盖");
    if (previous.state === "done") return;
    const priorId = previous.report?.actual?.unitId;
    if (priorId && report.actual?.unitId && priorId !== report.actual.unitId) throw new Error("本分配已取得不同广告位 ID，保留原 ID 等待核验");
    if (priorId && !report.actual?.unitId) return;
    set(key, { ...previous, report });
  }
  async function performJob(job, adapter, emit, permission) {
    const { batch, task, assignmentId, workerId } = job;
    const journalKey = "journal:" + assignmentId;
    const old = get(journalKey, void 0);
    const report = (r) => emit({ ...r, assignmentId, taskId: task.id });
    if (old) {
      if (!ownsJournal(job, old)) throw new Error("持久化分配属于其他任务或批次，禁止执行或覆盖");
      if (old.state === "done" && old.report) {
        if (!ownsReport(job, old.report)) throw new Error("终态回执与原任务分配不匹配，禁止覆盖");
        await report(old.report);
        return;
      }
      if (old.state === "intent") {
        const actual = old.report && ownsReport(job, old.report) && knownId(job, old.report.actual) ? { ...old.report.actual, verified: false } : void 0;
        await report({ type: "result", status: actual ? "created-unverified" : "uncertain", actual, reason: "执行页在提交意图后恢复，禁止再次点击创建；请核验真实结果" });
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
    const foreground = async () => {
      if (!job.requireForeground) return;
      await permission();
      if (document.visibilityState === "visible") return;
      await new Promise((resolve, reject) => {
        let settled = false;
        const removers = [];
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          document.removeEventListener("visibilitychange", check);
          for (const remove of removers) remove();
          if (error) reject(error);
          else resolve();
        };
        const check = () => {
          try {
            permission();
            if (document.visibilityState === "visible") finish();
          } catch (error) {
            finish(error);
          }
        };
        const timer = setTimeout(() => {
          check();
          if (!settled) finish(new Error("执行页未到前台，未填写或提交广告位"));
        }, 3e4);
        document.addEventListener("visibilitychange", check);
        for (const key of ["command:" + workerId, "batch:" + batch.identity.publisherId + ":" + batch.identity.appId + ":" + batch.id]) {
          try {
            const remove = listen(key, check);
            if (settled) remove();
            else removers.push(remove);
          } catch {
          }
        }
        check();
      });
      await permission();
    };
    const checkpoint = async () => {
      await permission();
      await foreground();
      await checkIdentity();
    };
    let intent = !!task.intentAt || job.kind === "verify";
    let latestActual = task.actual;
    try {
      await foreground();
      await checkIdentity();
      if (job.kind === "verify") {
        if (!task.actual?.unitId) {
          await report({ type: "result", status: "uncertain", reason: "缺少本次创建的广告位 ID，请保留原执行页或录入成功说明中的 ID 后核验" });
          return;
        }
        if (task.actual?.unitId && adapter.verifyById) {
          try {
            const actual3 = await adapter.verifyById(batch.identity, task.actual.unitId, task.name, batch.format, task.floor, batch.mode ?? task.mode ?? "manual", batch.partnerBidding);
            await report({ type: "result", status: actual3.verified ? "success" : "created-unverified", actual: actual3, reason: actual3.verified ? "按已知广告位 ID 核验保存配置一致" : "已取得 ID，保存后配置未完整核验" });
          } catch (error) {
            const e = error;
            await report({ type: "error", status: "created-unverified", actual: e.actual || task.actual, reason: e.message });
          }
          return;
        }
        if (batch.partnerBidding === true) {
          await report({ type: "result", status: "created-unverified", actual: task.actual, reason: "无法按 ID 核验合作平台出价设置，保留已知 ID" });
          return;
        }
        await adapter.home(batch.identity);
        const found = await adapter.lookup(batch.identity, task.name);
        const classification = classifyLookup(found, batch.identity, batch.format, task.name, task.floor, batch.mode ?? task.mode ?? "manual");
        const actual2 = classification.actual;
        const exactKnownId = !!task.actual?.unitId && actual2?.unitId === task.actual.unitId;
        if (task.actual?.unitId && !exactKnownId) {
          await report({ type: "result", status: "created-unverified", actual: task.actual, reason: "同名查询结果与已取得广告位ID不一致，保留原ID等待核验" });
          return;
        }
        await report({ type: "result", status: classification.status === "exists" && exactKnownId ? "success" : "created-unverified", actual: exactKnownId ? actual2 : task.actual, reason: classification.status === "pending" ? "暂未找到记录，不能证明创建失败；继续保留待核验" : classification.reason });
        return;
      }
      await checkpoint();
      set(journalKey, { assignmentId, taskId: task.id, batchId: batch.id, state: "filling" });
      await report({ type: "stage", stage: "filling" });
      await adapter.prepare(batch.identity, batch.format, task.name, task.floor, checkpoint, batch.mode ?? task.mode ?? "manual", batch.partnerBidding);
      await report({ type: "stage", stage: "filling", reason: "表单已读回，等待提交许可" });
      await checkpoint();
      if (job.parallelPreparation) {
        const batchKey = "batch:" + batch.identity.publisherId + ":" + batch.identity.appId + ":" + batch.id;
        await waitFor(() => {
          permission();
          const current = get(batchKey, void 0);
          if (!current || current.controllerId !== batch.controllerId || current.id !== batch.id) throw new Error("任务归属已变更，停止等待首条核验");
          if (current.phase !== "running") throw new Error("批次已暂停或停止，停止等待首条核验");
          const assigned = current.tasks.find((row) => row.id === task.id && row.assignmentId === assignmentId && row.workerId === workerId);
          if (!assigned) throw new Error("任务分配已变化，停止等待首条核验");
          return canSubmitPrepared(current, assigned) ? true : void 0;
        }, 12e4, batchKey);
        await checkpoint();
      }
      await serializeSubmission(batch.identity.publisherId, async (recordClick) => {
        await checkpoint();
        intent = true;
        await report({ type: "intent" });
        await checkpoint();
        set(journalKey, { assignmentId, taskId: task.id, batchId: batch.id, state: "intent" });
        await adapter.submit(() => {
          permission(true);
          recordClick();
        });
      });
      if (adapter.waitForUnitId) {
        const createdId = await adapter.waitForUnitId().catch(() => void 0);
        if (createdId) {
          if (!knownId(job, { unitId: createdId })) throw new Error("创建说明返回的广告位 ID 与本发布商不符，保留提交意图等待核验");
          const mode = batch.partnerBidding ? "partner-bidding" : batch.mode ?? task.mode ?? "manual";
          latestActual = { unitId: createdId, publisherId: batch.identity.publisherId, appId: batch.identity.appId, name: task.name, format: batch.format, mode, partnerBidding: batch.partnerBidding === true, floor: mode === "manual" ? task.floor : "", currency: mode === "manual" ? "USD" : "", verified: false };
          persistStage(job, { id: uuid(), at: Date.now(), workerId, assignmentId, taskId: task.id, type: "stage", stage: "created", actual: latestActual });
          await report({ type: "stage", stage: "created", actual: latestActual });
        }
      }
      await report({ type: "stage", stage: "verifying", actual: latestActual });
      const actual = await adapter.verify(batch.identity, batch.format, task.name, task.floor, batch.mode ?? task.mode ?? "manual", batch.partnerBidding);
      if (latestActual?.unitId && actual.unitId !== latestActual.unitId) throw Object.assign(new Error("保存后核验返回不同广告位 ID，保留原 ID 等待核验"), { actual: { ...latestActual, verified: false } });
      latestActual = actual;
      await report({ type: "result", status: actual.verified ? "success" : "created-unverified", actual, reason: actual.verified ? "保存后配置核验一致" : "已取得广告位 ID，配置尚未全部核验" });
    } catch (error) {
      const e = error;
      const completed = get(journalKey, void 0);
      if (completed?.state === "done" && completed.report) return;
      let actual = latestActual?.unitId ? e.actual?.unitId && latestActual.unitId !== e.actual.unitId ? { ...latestActual, verified: false } : { ...latestActual, ...e.actual, unitId: latestActual.unitId, verified: false } : e.actual || latestActual;
      if (intent && !actual?.unitId && adapter.recoverCreatedId) {
        try {
          const recovered = adapter.recoverCreatedId(batch.identity, task.name, batch.format);
          if (recovered && /^ca-app-pub-\d{16}\/\d{10}$/.test(recovered) && recovered.startsWith(`ca-app-${batch.identity.publisherId}/`)) {
            actual = { unitId: recovered, publisherId: batch.identity.publisherId, appId: batch.identity.appId, name: task.name, format: batch.format, verified: false };
          }
        } catch {
        }
      }
      const status = actual?.unitId ? "created-unverified" : intent ? "uncertain" : "failed";
      await report({ type: "error", status, reason: e.message, actual, fatal: e.fatal });
    }
  }
  async function runWorker(workerId, adapter) {
    const release = await holdLock("admob-batch-worker:" + workerId);
    const cmdKey = "command:" + workerId, outKey = "report:" + workerId;
    const status = document.createElement("div");
    status.id = "abc-worker-status";
    status.style.cssText = "position:fixed;bottom:8px;right:8px;z-index:2147483647;padding:10px;background:#152238;color:white;font:14px sans-serif;max-width:380px";
    status.textContent = "AdMob 批量执行页：等待主控。不要手动修改此页。";
    document.body.append(status);
    let running = false, seen = "", closed = false;
    let activeJob;
    let lastCommand = { seq: 0 };
    let poll;
    let notificationReceived = false;
    let removeListener = () => {
    };
    let activationNonce = "";
    const visibilityChanged = () => {
      const command = get(cmdKey, { seq: 0 });
      if (!closed && !running && activationNonce && command.activate?.nonce === activationNonce) publishActivation(activationNonce);
    };
    document.addEventListener?.("visibilitychange", visibilityChanged);
    try {
      removeListener = listen(cmdKey, () => {
        notificationReceived = true;
        void tick();
      });
    } catch {
    }
    if (closed) removeListener();
    function readCommand() {
      const command = get(cmdKey, { seq: 0 });
      if (command.close && activeJob && !canCloseActive(command)) {
        const { close: _close, ...updates } = command;
        lastCommand = { ...lastCommand, ...updates, job: command.job || lastCommand.job };
      } else {
        lastCommand = command;
        if (command.close) activeJob = void 0;
      }
      return lastCommand;
    }
    function canCloseActive(command) {
      if (!activeJob) return true;
      if (command.job && command.job.assignmentId !== activeJob.assignmentId) return false;
      const journal = get("journal:" + activeJob.assignmentId, void 0);
      const terminal = journal?.report;
      if (!journal || !ownsJournal(activeJob, journal) || journal.state !== "done" || !terminal || !["result", "error"].includes(terminal.type) || terminal.assignmentId !== activeJob.assignmentId || terminal.taskId !== activeJob.task.id || terminal.workerId !== workerId || command.ack !== terminal.id) return false;
      return knownId(activeJob, terminal.actual) || terminal.status === "failed" && activeJob.kind === "create" && !activeJob.task.intentAt && !activeJob.task.actual?.unitId;
    }
    function finishRunning() {
      running = false;
      if (!closed) void Promise.resolve().then(tick).catch((e) => {
        status.textContent = "执行页通信中断：" + e.message + "。保持此页，返回主控恢复核验。";
      });
    }
    function closeDiagnostic(command) {
      if (closed || activeJob) return;
      closed = true;
      removeListener();
      document.removeEventListener?.("visibilitychange", visibilityChanged);
      if (poll !== void 0) clearInterval(poll);
      if (!command.closeAfterReload) release();
      status.textContent = "AdMob 执行页已安全释放。";
      try {
        set(outKey, { id: uuid(), at: Date.now(), workerId, type: "closed", closingSeq: command.seq });
      } finally {
        if (typeof window !== "undefined") window.close();
      }
    }
    function publishControl(data) {
      set(outKey, { ...data, id: uuid(), at: Date.now(), workerId });
    }
    function publishActivation(nonce) {
      publishControl({ type: "active", activation: { nonce, visible: document.visibilityState === "visible" } });
    }
    async function emit(data) {
      const r = { ...data, id: uuid(), at: Date.now(), workerId };
      if (data.assignmentId && data.type === "stage") {
        if (!activeJob || activeJob.assignmentId !== data.assignmentId || activeJob.task.id !== data.taskId) throw new Error("执行进度与当前任务不匹配，已阻止覆盖");
        persistStage(activeJob, r);
      }
      if (data.assignmentId && ["result", "error"].includes(data.type)) {
        const prior = get("journal:" + data.assignmentId, void 0);
        const batchId = prior?.batchId || activeJob?.batch.id;
        if (!batchId) throw new Error("终态记录缺少批次归属，已阻止覆盖");
        set("journal:" + data.assignmentId, { assignmentId: data.assignmentId, taskId: data.taskId, batchId, state: "done", report: r });
      }
      set(outKey, r);
      status.textContent = "AdMob 批量执行页：" + (data.reason || data.stage || data.type);
      if (data.type === "stage") return;
      await waitFor(() => readCommand().ack === r.id ? true : void 0, 6e4, cmdKey);
    }
    async function tick() {
      if (closed) return;
      const cmd = readCommand();
      if (cmd.close) {
        closeDiagnostic(cmd);
        return;
      }
      if (running) return;
      if (cmd.activate && activationNonce !== cmd.activate.nonce) {
        activationNonce = cmd.activate.nonce;
        if (document.visibilityState !== "visible") try {
          window.focus();
        } catch {
        }
        publishActivation(activationNonce);
        return;
      }
      if (cmd.probe && seen !== cmd.probe.nonce) {
        running = true;
        seen = cmd.probe.nonce;
        try {
          let identity, error;
          const expected = cmd.probe.createIdentity;
          if (expected || cmd.probe.identify !== false) {
            try {
              identity = expected && adapter.identifyCreatePage ? await adapter.identifyCreatePage(expected) : await adapter.identify();
            } catch (e) {
              error = e.message;
            }
          }
          const locked = await lockUnavailable(cmd.probe.lockName);
          const latest = get(cmdKey, { seq: 0 });
          if (latest.close) {
            closeDiagnostic(latest);
            return;
          }
          if (closed || latest.probe?.nonce !== cmd.probe.nonce) return;
          set(outKey, { id: uuid(), at: Date.now(), workerId, type: "hello", probe: { nonce: cmd.probe.nonce, locked, identity, error, notifications: notificationReceived } });
        } finally {
          finishRunning();
        }
        return;
      }
      if (!cmd.job || seen === cmd.job.assignmentId) return;
      const job = cmd.job;
      activationNonce = "";
      const batch = get("batch:" + job.batch.identity.publisherId + ":" + job.batch.identity.appId + ":" + job.batch.id, void 0);
      if (!batch || !["running", "paused", "stopping"].includes(batch.phase)) return;
      if (batch.controllerId !== job.batch.controllerId) {
        const journal = get("journal:" + job.assignmentId, void 0);
        if (!canRecoverUnsubmitted(job, batch, cmd, journal)) return;
        seen = job.assignmentId;
        running = true;
        activeJob = job;
        try {
          await emit({ type: "error", assignmentId: job.assignmentId, taskId: job.task.id, status: "failed", reason: "旧主控已恢复，执行页的匹配填表记录无提交意图、结果或许可；确认未提交，等待手动重试" });
        } catch (e) {
          status.textContent = "执行页通信中断：" + e.message + "。保持此页，返回主控恢复核验。";
        } finally {
          finishRunning();
        }
        return;
      }
      seen = job.assignmentId;
      running = true;
      activeJob = job;
      try {
        await performJob(job, adapter, emit, (beforeClick) => {
          const latest = readCommand();
          const control = get("batch:" + job.batch.identity.publisherId + ":" + job.batch.identity.appId + ":" + job.batch.id, void 0);
          if (latest.job?.assignmentId !== job.assignmentId || !control || control.controllerId !== job.batch.controllerId) throw Object.assign(new Error("任务归属已变更，停止当前执行"), { fatal: true });
          if (latest.blocked) throw new Error(latest.blocked);
          if (control.phase !== "running") throw new Error(control.phase === "stopping" ? "批次已停止，未发起提交" : "批次已暂停，在提交前安全停止");
          if (beforeClick && job.requireForeground && document.visibilityState !== "visible") throw new Error("执行页已离开前台，未点击创建");
          const report = get(outKey, void 0);
          if ((beforeClick || report?.type === "intent") && (!latest.grant || latest.grant.assignmentId !== job.assignmentId || latest.grant.expires <= Date.now())) throw new Error("提交许可缺失或过期，未点击创建");
        });
      } catch (e) {
        status.textContent = "执行页通信中断：" + e.message + "。保持此页，返回主控恢复核验。";
      } finally {
        finishRunning();
      }
    }
    if (!closed) poll = setInterval(() => void tick(), 1300);
    await tick();
  }

  // src/controller.ts
  var WorkerCapabilityUnavailable = class extends Error {
  };
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
    reportTickPending = false;
    preflightSignature = "";
    lastSubmit = 0;
    lastIdentityCheck = 0;
    errors = 0;
    localBusy = false;
    probing = false;
    reportWork = /* @__PURE__ */ new Map();
    handledReports = /* @__PURE__ */ new Set();
    grantTail = Promise.resolve();
    cleanupWork = /* @__PURE__ */ new Map();
    identityWork;
    cleanupError;
    archives = /* @__PURE__ */ new Map();
    archiveWork = /* @__PURE__ */ new Map();
    selectedHistoryId;
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
        recordObservedId: (taskId, unitId) => this.action(() => this.recordObservedId(taskId, unitId)),
        verifyHistory: (id) => this.action(() => this.verifyHistory(id)),
        recordHistoryObservedId: (id, taskId, unitId) => this.action(() => this.recordHistoryObservedId(id, taskId, unitId)),
        history: async () => this.refreshHistory(),
        viewHistory: async (id) => {
          this.selectedHistoryId = id;
          this.panel.update({ historyBatch: id ? this.readHistory(id) : void 0 });
        },
        degrade: async () => {
          this.requireBatch();
          await this.pause("用户降级单页");
          this.batch.execution = "single";
          this.batch.concurrency = 1;
          this.save();
          this.notice("已降级单页。旧执行页仍保留并继续收集结果；点击继续后，后续任务在当前页处理。");
        },
        switchToPaged: () => this.action(() => this.switchToPaged()),
        export: async (filter, id) => {
          const batch = id ? this.readHistory(id) : this.batch;
          if (!batch) throw new Error("没有可导出的批次");
          download("AdMob-" + batch.id + "-" + filter + ".csv", exportCsv(batch, filter), "text/csv;charset=utf-8");
        },
        copy: async (id) => {
          const batch = id ? this.readHistory(id) : this.batch;
          if (!batch) throw new Error("没有可复制的批次");
          GM_setClipboard(copyPairs(batch), "text");
          this.notice("已复制有真实广告位 ID 的名称与 ID");
        },
        diagnostics: async () => this.diagnostics(),
        probe: () => this.action(() => this.checkCrossPage(this.panel.getConfig().execution === "paged"))
      });
      this.panel.update({ capabilities: "并发模式批量打开创建页，逐页核验并关闭。串行模式使用当前页。" });
      try {
        await this.identify();
        await this.load();
        this.refreshHistory();
      } catch (e) {
        this.panel.update({ identityError: e.message });
      }
      setInterval(() => void this.tick().catch((e) => this.pause("调度异常：" + e.message)), 1200);
      window.addEventListener("beforeunload", () => {
        if (this.batch?.phase === "running") {
          this.batch.phase = "paused";
          this.save();
        }
        for (const slot of this.slots.values()) {
          if (slot.directCreate && slot.tab && !slot.closing && this.safeToClose(slot)) {
            const command = get("command:" + slot.id, { seq: 0 });
            set("command:" + slot.id, { ...command, seq: command.seq + 1, close: true });
            slot.tab.close();
          }
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
        if (this.reportTickPending) this.reportChanged();
      }
    }
    reportChanged() {
      this.reportTickPending = true;
      this.collectArchives();
      this.drainReports();
      if (this.tickBusy || this.actionBusy) return;
      this.reportTickPending = false;
      void this.tick().catch((e) => this.pause("调度异常：" + e.message));
    }
    drainReports() {
      const immediate = [];
      for (const slot of this.slots.values()) {
        if (slot.closing) continue;
        const report = this.savedReport(slot);
        if (!report || !["stage", "intent", "result", "error"].includes(report.type) || report.id === slot.lastReport || this.handledReports.has(report.id)) continue;
        const prior = this.reportWork.get(slot.id);
        if (prior && (prior.report.id === report.id || prior.report.type !== "intent")) {
          if (prior.report.type !== "intent") immediate.push(prior.promise);
          continue;
        }
        const batch = this.batch;
        const work = { report, promise: Promise.resolve() };
        this.reportWork.set(slot.id, work);
        work.promise = Promise.resolve().then(() => this.handle(slot, report)).catch(async (error) => {
          if (this.batch === batch) {
            try {
              await this.pause("报告处理异常：" + error.message);
            } catch {
            }
          }
        }).finally(() => {
          if (this.reportWork.get(slot.id) === work) this.reportWork.delete(slot.id);
          try {
            const latest = this.savedReport(slot);
            if (latest && latest.id !== report.id && !this.handledReports.has(latest.id)) this.reportChanged();
          } catch {
          }
        });
        if (report.type !== "intent") immediate.push(work.promise);
      }
      return immediate;
    }
    addSlot(slot) {
      this.slots.get(slot.id)?.removeReportListener?.();
      this.slots.set(slot.id, slot);
      slot.removeReportListener = listen("report:" + slot.id, () => this.reportChanged());
    }
    removeSlot(id) {
      this.slots.get(id)?.removeReportListener?.();
      this.slots.delete(id);
    }
    savedReport(slot) {
      const assignment = slot.busy || get("command:" + slot.id, { seq: 0 }).job?.assignmentId;
      const task = this.batch?.tasks.find((task2) => task2.assignmentId === assignment && task2.workerId === slot.id);
      if (task) {
        const journal = get("journal:" + assignment, void 0);
        if (journal && journal.batchId === this.batch.id && journal.taskId === task.id && journal.assignmentId === assignment && journal.report && reportBelongs(journal.report, task, slot.id) && ["stage", "result", "error"].includes(journal.report.type)) {
          if (journal.state === "done" && ["result", "error"].includes(journal.report.type)) return journal.report;
          const mailbox = get("report:" + slot.id, void 0);
          if (journal.report.actual?.unitId && !task.actual?.unitId) return journal.report;
          if (!mailbox || !reportBelongs(mailbox, task, slot.id) || journal.report.at >= mailbox.at) return journal.report;
          return mailbox;
        }
      }
      return get("report:" + slot.id, void 0);
    }
    notice(text) {
      this.panel.update({ notice: text });
    }
    requireBatch() {
      if (!this.batch) throw new Error("当前没有批次，请填写清单后开始创建");
    }
    key(batch = this.batch) {
      return "batch:" + batch.identity.publisherId + ":" + batch.identity.appId + ":" + batch.id;
    }
    readHistory(id) {
      if (!this.identity || !/^[\w-]{1,100}$/.test(id)) throw new Error("批次或当前应用无效");
      const batch = get("batch:" + this.identity.publisherId + ":" + this.identity.appId + ":" + id, void 0);
      if (!batch || batch.schema !== 1 || batch.id !== id || !sameIdentity(batch.identity, this.identity)) throw new Error("未找到当前发布商与应用的历史批次");
      return batch;
    }
    refreshHistory() {
      if (!this.identity || typeof GM_listValues !== "function") return;
      const prefix = "abc:v1:batch:" + this.identity.publisherId + ":" + this.identity.appId + ":";
      const history = GM_listValues().filter((key) => key.startsWith(prefix)).flatMap((key) => {
        try {
          return [summarizeBatch(this.readHistory(key.slice(prefix.length)))];
        } catch {
          return [];
        }
      }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      this.panel.update({ history });
    }
    save() {
      if (this.batch) {
        if (this.batch.phase === "done" && this.batch.startedAt && !this.batch.completedAt) this.batch.completedAt = (/* @__PURE__ */ new Date()).toISOString();
        set(this.key(), this.batch);
        const latestKey = "latest:" + this.batch.identity.publisherId + ":" + this.batch.identity.appId;
        if (get(latestKey, void 0) !== this.batch.id) set(latestKey, this.batch.id);
        this.panel.update({ batch: this.batch });
      }
    }
    saveArchive(batch) {
      if (this.batch === batch) this.save();
      else set(this.key(batch), batch);
      if (this.selectedHistoryId === batch.id) this.panel.update({ historyBatch: batch });
      this.refreshHistory();
    }
    matchingCommand(batch, task) {
      if (!task.workerId || !task.assignmentId) return void 0;
      const command = get("command:" + task.workerId, void 0), job = command?.job;
      return job?.batch.id === batch.id && sameIdentity(job.batch.identity, batch.identity) && job.task.id === task.id && job.workerId === task.workerId && job.assignmentId === task.assignmentId ? command : void 0;
    }
    archiveStopped(batch) {
      batch.phase = "stopping";
      for (const task of batch.tasks) if (task.status === "pending" && !task.assignmentId) transition(task, "stopped", "用户停止");
      set(this.key(batch), batch);
      for (const task of batch.tasks) {
        const command = this.matchingCommand(batch, task);
        if (!command) continue;
        set("command:" + task.workerId, { ...command, seq: command.seq + 1, grant: void 0, blocked: "批次已停止并归档；禁止继续创建或重放原分配" });
      }
      for (const task of batch.tasks) if (["pending", "filling", "submitting", "verifying"].includes(task.status)) {
        if (task.actual?.unitId && ["pending", "filling"].includes(task.status)) transition(task, "uncertain", "已取得真实 ID，转入停止批次历史核验");
        transition(task, task.actual?.unitId ? "created-unverified" : "uncertain", "批次已停止；原分配与提交证据保留，结果转入历史核验");
      }
      batch.phase = "done";
      batch.completedAt ??= (/* @__PURE__ */ new Date()).toISOString();
      const archive = this.archives.get(batch.id) || { batch, slots: /* @__PURE__ */ new Map() };
      archive.batch = batch;
      this.archives.set(batch.id, archive);
      if (this.batch === batch) this.grantTail = Promise.resolve();
      for (const slot of [...this.slots.values()]) {
        const assignment = slot.busy || get("command:" + slot.id, { seq: 0 }).job?.assignmentId;
        const task = batch.tasks.find((task2) => task2.workerId === slot.id && task2.assignmentId === assignment);
        if (!task && slot.batchId !== batch.id) continue;
        this.removeSlot(slot.id);
        slot.batchId = batch.id;
        archive.slots.set(slot.id, slot);
        if (task) slot.taskId = task.id;
        if (task && ["success", "exists"].includes(task.status) && task.actual?.unitId) slot.busy = void 0;
        slot.removeReportListener = listen("report:" + slot.id, () => this.collectArchives());
      }
      for (const task of batch.tasks) if (task.workerId && task.assignmentId && !archive.slots.has(task.workerId)) {
        const slot = { id: task.workerId, busy: task.assignmentId, since: Date.now(), batchId: batch.id, taskId: task.id };
        archive.slots.set(slot.id, slot);
        slot.removeReportListener = listen("report:" + slot.id, () => this.collectArchives());
      }
      this.saveArchive(batch);
      const active = get("active:" + batch.identity.publisherId, void 0);
      if (active?.id === batch.id && active.appId === batch.identity.appId) GM_deleteValue("abc:v1:active:" + batch.identity.publisherId);
      this.collectArchives();
      for (const slot of archive.slots.values()) this.cleanupArchivedSlot(batch, slot);
    }
    collectArchives() {
      for (const archive of this.archives.values()) for (const slot of archive.slots.values()) {
        if (slot.closing || this.archiveWork.has(slot.id)) continue;
        const task = archive.batch.tasks.find((task2) => task2.workerId === slot.id && task2.id === slot.taskId) || archive.batch.tasks.find((task2) => task2.workerId === slot.id && task2.assignmentId === slot.busy);
        if (!task) continue;
        const journal = get("journal:" + task.assignmentId, void 0), mailbox = get("report:" + slot.id, void 0);
        const durable = journal?.batchId === archive.batch.id && journal.taskId === task.id && journal.assignmentId === task.assignmentId && journal.report && reportBelongs(journal.report, task, slot.id) ? journal.report : void 0;
        const report = durable && (journal?.state === "done" || !mailbox || !reportBelongs(mailbox, task, slot.id) || durable.at >= mailbox.at) ? durable : mailbox;
        if (!report || !reportBelongs(report, task, slot.id) || !["stage", "result", "error"].includes(report.type) || slot.lastReport === report.id || this.handledReports.has(report.id)) continue;
        const work = Promise.resolve().then(() => this.handleArchived(archive.batch, slot, task, report)).catch(() => {
        }).finally(() => {
          this.archiveWork.delete(slot.id);
        });
        this.archiveWork.set(slot.id, work);
      }
    }
    async handleArchived(batch, slot, task, report) {
      if (!batch.stopRequestedAt || batch.phase !== "done" || !reportBelongs(report, task, slot.id)) return;
      const command = this.matchingCommand(batch, task);
      const mismatch = !!task.actual?.unitId && !!report.actual?.unitId && task.actual.unitId !== report.actual.unitId;
      if (!["success", "exists"].includes(task.status) && !mismatch && report.actual?.unitId && new RegExp(`^ca-app-${batch.identity.publisherId}/\\d{10}$`).test(report.actual.unitId)) task.actual = { ...task.actual, ...report.actual };
      const terminal = ["result", "error"].includes(report.type);
      if (terminal && !["success", "exists"].includes(task.status)) {
        let status = report.status || "uncertain";
        if (mismatch) status = "created-unverified";
        if (task.intentAt && status === "failed") status = task.actual?.unitId ? "created-unverified" : "uncertain";
        if (status === "success" && (task.actual?.format !== batch.format || !sameIdentity(task.actual, batch.identity) || !matchesRequestedConfiguration(task.actual, task.floor, batch.mode, batch.partnerBidding))) status = "created-unverified";
        if (["success", "exists"].includes(status) && ["submitting", "uncertain", "created-unverified"].includes(task.status)) transition(task, "verifying", "收集停止批次的迟到核验结果");
        if (status === "created-unverified" && ["pending", "filling"].includes(task.status)) transition(task, "uncertain", "停止批次取得真实 ID，配置待核验");
        transition(task, status, mismatch ? "迟到报告 ID 与原 ID 不同，保留原 ID" : report.reason || "收集停止批次的迟到结果");
      }
      this.saveArchive(batch);
      if (terminal && command) {
        command.grant = void 0;
        command.ack = report.id;
        command.seq++;
        set("command:" + slot.id, command);
        slot.busy = void 0;
      }
      slot.lastReport = report.id;
      this.handledReports.add(report.id);
      if (terminal) this.cleanupArchivedSlot(batch, slot);
    }
    cleanupArchivedSlot(batch, slot) {
      if (!slot.tab || slot.busy || slot.closing) return;
      const command = get("command:" + slot.id, { seq: 0 }), task = batch.tasks.find((task2) => task2.workerId === slot.id && (task2.id === slot.taskId || task2.assignmentId === command.job?.assignmentId));
      if (task && !task.actual?.unitId && (task.intentAt || command.grant || !["failed", "stopped"].includes(task.status))) return;
      if (command.job && (!task || command.job.batch.id !== batch.id || !sameIdentity(command.job.batch.identity, batch.identity) || !task.actual?.unitId && (task.intentAt || command.grant || !["failed", "stopped"].includes(task.status)))) return;
      slot.closing = true;
      void Promise.resolve().then(async () => {
        set("command:" + slot.id, { ...command, seq: command.seq + 1, close: true });
        await this.closeKnownTab(slot);
        slot.removeReportListener?.();
        this.archives.get(batch.id)?.slots.delete(slot.id);
        const latest = get("command:" + slot.id, { seq: 0 });
        if (!latest.job || latest.job.batch.id === batch.id && latest.job.assignmentId === command.job?.assignmentId) {
          GM_deleteValue("abc:v1:command:" + slot.id);
          GM_deleteValue("abc:v1:report:" + slot.id);
        }
      }).catch(() => {
        slot.closing = false;
      });
    }
    async identify() {
      let identity;
      try {
        identity = await this.adapter.identify();
      } catch (error) {
        this.preflightSignature = "";
        this.panel.update({ identityError: error.message, ready: false });
        throw error;
      }
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
        if (batch.partnerBidding === true) task.partnerBidding = true;
        const remote = !!task.workerId && !task.workerId.startsWith("single:");
        if (batch.phase !== "done" && batch.execution === "single" && task.status === "uncertain" && !task.intentAt && !task.actual && task.assignmentId && task.workerId?.startsWith("single:") && task.workerId !== "single:" + this.id) {
          const journal2 = get("journal:" + task.assignmentId, void 0);
          const command = get("command:" + task.workerId, void 0);
          if (journal2?.state === "filling" && journal2.assignmentId === task.assignmentId && journal2.taskId === task.id && journal2.batchId === batch.id && !command?.grant) {
            transition(task, "failed", "旧单页实例已结束，匹配的填表记录无提交意图、结果或许可；确认未提交，可手动重试");
          }
        }
        if (!batch.stopRequestedAt && batch.phase !== "done" && remote && task.status === "filling") transition(task, "uncertain", "主控已刷新，等待原执行页报告");
        else if (!batch.stopRequestedAt && ["filling", "submitting", "verifying"].includes(task.status)) recoverTask(task);
        const journal = task.assignmentId ? get("journal:" + task.assignmentId, void 0) : void 0;
        const completed = journal?.state === "done" && journal.batchId === batch.id && journal.taskId === task.id && journal.assignmentId === task.assignmentId && !!journal.report && reportBelongs(journal.report, task, task.workerId || "") && ["result", "error"].includes(journal.report.type);
        if (batch.phase !== "done" && task.assignmentId && task.workerId && !["success", "exists", "stopped", "conflict"].includes(task.status) && (remote || completed)) {
          this.addSlot({ id: task.workerId, busy: task.assignmentId, since: Date.now() });
        }
      }
      if (batch.stopRequestedAt) {
        this.archiveStopped(batch);
        this.notice("已恢复已停止批次；未决结果及已知 ID 保留在历史中，可填写新清单。");
        return;
      }
      this.save();
      for (const slot of this.slots.values()) {
        const report = this.savedReport(slot);
        if (report && ["result", "error"].includes(report.type)) await this.handle(slot, report);
      }
      this.notice(batch.phase === "draft" ? "已恢复未确认草稿。检查清单后点击开始创建，将自动检查执行条件。" : batch.phase === "done" ? "已恢复已结束批次，可查看历史结果或填写新清单。" : "已恢复历史批次并暂停。提交过或结果不确定的任务只允许先核验；点击继续才会派发尚未提交的任务。");
    }
    signature(config) {
      return JSON.stringify([config.format, config.partnerBidding ? "disabled" : config.mode ?? "manual", config.partnerBidding ?? false, config.concurrency, config.execution, config.rows, this.identity?.publisherId, this.identity?.appId]);
    }
    checkConfirmedIdentity(config) {
      if (!config.confirmedIdentity || !this.identity || !sameIdentity(config.confirmedIdentity, this.identity)) {
        this.preflightSignature = "";
        this.panel.update({ ready: false });
        throw new Error("当前账号或应用与已确认的预览不一致，请核对当前页面并重新确认创建预览");
      }
    }
    workerUrl(identity, id, destination) {
      const url = new URL(typeof location === "undefined" ? this.batch.sourceUrl : location.href);
      url.pathname = "/v2/apps/" + identity.appId.split("~")[1] + "/adunits/" + destination;
      url.search = "";
      url.hash = "";
      url.searchParams.set("__admob_batch_worker", id);
      return url.href;
    }
    waitForProbe(slot, nonce, timeout = 25e3) {
      return waitFor(() => {
        const reply = get("report:" + slot.id, void 0);
        return reply?.workerId === slot.id && reply.type === "hello" && reply.probe?.nonce === nonce ? reply : void 0;
      }, timeout, "report:" + slot.id);
    }
    async openCreatePages(identity, taskIds, batch) {
      if (!taskIds.length) return [];
      const phase = batch?.phase;
      const nonce = uuid(), lockName = "admob-batch-probe:" + nonce;
      const release = await holdLock(lockName);
      const slots = [];
      const checkBatch = () => {
        if (batch && (this.batch !== batch || batch.phase !== phase || batch.stopRequestedAt)) throw new Error("批次已变化，停止打开创建页");
      };
      try {
        if (typeof document !== "undefined" && document.getElementById("abc-panel-host")?.hasAttribute("data-manual-tabs")) throw new WorkerCapabilityUnavailable("当前环境无法自动打开创建页");
        this.notice(`正在批量打开 ${taskIds.length} 个广告单元创建页…`);
        for (const taskId of [...taskIds].reverse()) {
          checkBatch();
          const slot = { id: uuid(), since: Date.now(), identity, batchId: batch?.id, taskId, directCreate: true };
          slots.push(slot);
          set("command:" + slot.id, { seq: 1, probe: { nonce, lockName, identify: false } });
          slot.tab = GM_openInTab(this.workerUrl(identity, slot.id, "create"), { active: true, insert: true, setParent: true });
          if (!slot.tab || typeof slot.tab.focus !== "function") throw new WorkerCapabilityUnavailable("浏览器无法切换到批量打开的创建页");
          this.addSlot(slot);
        }
        const replies = await Promise.allSettled(slots.map((slot) => this.waitForProbe(slot, nonce, 5e3)));
        for (const [index, reply] of replies.entries()) {
          checkBatch();
          const slot = slots[index];
          let hello = reply.status === "fulfilled" ? reply.value : get("report:" + slot.id, void 0);
          if (hello?.workerId !== slot.id || hello.type !== "hello" || hello.probe?.nonce !== nonce) {
            slot.tab.focus();
            hello = await this.waitForProbe(slot, nonce, 2e4).catch(() => {
              throw new WorkerCapabilityUnavailable("创建页启动超时，未提交广告位");
            });
          }
          if (!hello.probe?.locked) throw new WorkerCapabilityUnavailable("创建页跨页锁检查未通过");
          slot.lastReport = hello.id;
          slot.probePassed = true;
        }
        checkBatch();
        return slots.reverse();
      } catch (error) {
        await Promise.allSettled(slots.map((slot) => this.closeProbe(slot)));
        throw error;
      } finally {
        release();
      }
    }
    async warmPaged() {
      const batch = this.batch;
      const opened = new Set([...this.slots.values()].filter((slot) => slot.batchId === batch.id && slot.probePassed && !slot.closing && !slot.tab?.closed).map((slot) => slot.taskId));
      const tasks = batch.tasks.filter((task) => task.status === "pending" && !task.assignmentId && !task.intentAt && !task.actual?.unitId && !opened.has(task.id));
      await this.openCreatePages(batch.identity, tasks.map((task) => task.id), batch);
    }
    async activatePagedSlot(slot) {
      if (!slot.tab || typeof slot.tab.focus !== "function" || slot.tab.closed) throw new Error("创建页缺少可用的前台切换句柄，未提交任务");
      const nonce = uuid(), command = get("command:" + slot.id, { seq: 0 });
      set("command:" + slot.id, { ...command, seq: command.seq + 1, activate: { nonce } });
      slot.tab.focus();
      const report = await waitFor(() => {
        const value = get("report:" + slot.id, void 0);
        return value?.workerId === slot.id && value.type === "active" && value.activation?.nonce === nonce && value.activation.visible ? value : void 0;
      }, 1e4, "report:" + slot.id);
      if (report.activation?.error) throw new Error("执行页前台切换失败：" + report.activation.error);
      if (slot.directCreate && slot.identity) {
        const challenge = uuid(), lockName = "admob-batch-probe:" + challenge;
        const release = await holdLock(lockName);
        try {
          set("command:" + slot.id, { seq: command.seq + 2, probe: { nonce: challenge, lockName, createIdentity: slot.identity } });
          const reply = await this.waitForProbe(slot, challenge);
          if (reply.probe?.error) throw new Error("创建页检查失败：" + reply.probe.error);
          if (!reply.probe?.locked || !reply.probe.notifications || !reply.probe.identity || !sameIdentity(reply.probe.identity, slot.identity)) throw new Error("创建页的账号、应用或跨页通信检查未通过");
          slot.lastReport = reply.id;
        } finally {
          release();
        }
      }
    }
    safeToClose(slot) {
      if (slot.busy || slot.id.startsWith("single:")) return false;
      const command = get("command:" + slot.id, { seq: 0 });
      if (!command.job) return true;
      const job = command.job, batch = get("batch:" + job.batch.identity.publisherId + ":" + job.batch.identity.appId + ":" + job.batch.id, void 0);
      const task = batch?.tasks.find((row) => row.id === job.task.id && row.assignmentId === job.assignmentId && row.workerId === slot.id);
      if (!task) return false;
      if (task.actual?.unitId) return true;
      if (task.intentAt || command.grant || !["failed", "stopped"].includes(task.status)) return false;
      const journal = get("journal:" + job.assignmentId, void 0);
      return !!command.blocked || !!(journal?.state === "done" && journal.batchId === batch.id && journal.taskId === task.id && journal.assignmentId === job.assignmentId && journal.report && reportBelongs(journal.report, task, slot.id) && journal.report.type === "error" && !journal.report.actual?.unitId);
    }
    async closeKnownTab(slot) {
      if (!slot.tab) throw new Error("无法确认执行页的自有关闭句柄，保留该页及任务记录");
      const tab = slot.tab, previous = tab.onclose;
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearInterval(poll);
          clearTimeout(timer);
          tab.onclose = previous;
          error ? reject(error) : resolve();
        };
        const check = () => {
          if (tab.closed) finish();
        };
        const poll = setInterval(check, 250), timer = setTimeout(() => {
          if (tab.closed) finish();
          else finish(new Error("执行页尚未确认关闭，已停止开启下一页"));
        }, 1e4);
        tab.onclose = () => {
          try {
            previous?.();
          } finally {
            check();
          }
        };
        try {
          tab.close();
          check();
        } catch (error) {
          finish(error);
        }
      });
    }
    scheduleCleanup(slot) {
      if (this.cleanupError || slot.closing || this.cleanupWork.has(slot.id) || !this.safeToClose(slot)) return;
      const batch = this.batch;
      slot.closing = true;
      const work = Promise.resolve().then(async () => {
        const command = get("command:" + slot.id, { seq: 0 });
        if (slot.tab) {
          set("command:" + slot.id, { ...command, seq: command.seq + 1, close: true });
          await this.closeKnownTab(slot);
        } else {
          const seq = command.closeAfterReload ? command.seq : command.seq + 1;
          if (!command.closeAfterReload) set("command:" + slot.id, { ...command, seq, close: true, closeAfterReload: true });
          await waitFor(() => {
            const report = get("report:" + slot.id, void 0);
            return report?.workerId === slot.id && report.type === "closed" && report.closingSeq === seq ? report : void 0;
          }, 1e4, "report:" + slot.id);
          await navigator.locks.request("admob-batch-worker:" + slot.id, { signal: AbortSignal.timeout(1e4) }, () => {
          });
        }
        this.removeSlot(slot.id);
        GM_deleteValue("abc:v1:command:" + slot.id);
        GM_deleteValue("abc:v1:report:" + slot.id);
      }).catch(async (error) => {
        slot.closing = false;
        this.cleanupError = error;
        if (this.batch === batch) {
          try {
            await this.pause("执行页清理未完成：" + error.message);
          } catch {
          }
        }
      }).finally(() => {
        this.cleanupWork.delete(slot.id);
        this.reportChanged();
      });
      this.cleanupWork.set(slot.id, work);
    }
    cleanupIdlePages() {
      for (const slot of [...this.slots.values()].reverse()) {
        if (!slot.busy && !slot.id.startsWith("single:") && (slot.tab || this.batch?.execution === "paged" && get("command:" + slot.id, { seq: 0 }).job)) {
          this.scheduleCleanup(slot);
        }
      }
    }
    async switchToPaged() {
      this.requireBatch();
      await this.identify();
      await this.acquire();
      if (this.batch.phase !== "paused" || this.localBusy || [...this.slots.values()].some((slot) => !!slot.busy) || this.batch.tasks.some((task) => needsVerification(task) && !["success", "exists"].includes(task.status))) throw new Error("请先收齐并核验已有提交结果，再切换逐页创建；原任务不会重新创建。");
      this.cleanupIdlePages();
      await Promise.all(this.cleanupWork.values());
      if (this.cleanupError) throw this.cleanupError;
      this.batch.execution = "paged";
      this.batch.concurrency = 1;
      this.preflightSignature = "";
      this.save();
      this.notice("已改为并发；继续后批量打开创建页，再逐页创建、核验并关闭。");
    }
    async warmPool(target) {
      const existing = new Set(this.slots.keys());
      const ready = [...this.slots.values()].filter((slot) => !slot.busy && slot.probePassed && !slot.tab?.closed && slot.batchId === this.batch?.id && slot.identity && this.identity && sameIdentity(slot.identity, this.identity)).length;
      try {
        for (let index = ready; index < target; index++) {
          this.notice(`正在预热执行页 ${index + 1}/${target}：检查跨页锁、通知及账号（不提交）…`);
          await this.probe(true, false, `预热执行页 ${index + 1}/${target}`);
        }
      } catch (error) {
        for (const slot of [...this.slots.values()]) if (!existing.has(slot.id) && !slot.busy) await this.closeProbe(slot);
        throw error;
      }
    }
    async preflight(config) {
      if (this.batch?.phase === "paused") {
        await this.identify();
        await this.acquire();
        const unresolved = this.batch.tasks.filter((t) => needsVerification(t) && !["success", "exists"].includes(t.status)).length;
        if (!unresolved && this.batch.execution === "tabs") {
          const pending2 = this.batch.tasks.filter((task) => task.status === "pending" && !task.assignmentId).length;
          await this.warmPool(Math.min(this.batch.concurrency, pending2));
        }
        if (!unresolved && this.batch.execution === "paged") await this.warmPaged();
        this.panel.update({ ready: false, checks: [
          { label: "已重新核对批次原发布商和应用，主控锁有效", ok: true },
          { label: "保留原清单、已知 ID、提交意图和执行归属；本次不提交", ok: true },
          { label: unresolved ? `${unresolved} 条提交结果或配置待核验，请先点击“核验结果不确定项”` : "没有待核验的提交结果", ok: unresolved === 0 },
          { label: this.batch.partnerBidding ? "按批次合作平台出价设置创建并核验，无需填写底价" : this.batch.mode === "manual" ? "底价按已确定的逐行金额与整批 USD 使用，无需单独确认" : "按批次已确定的底价模式创建，无需填写金额", ok: true }
        ] });
        this.notice("暂停批次检查完成。" + (unresolved ? "请先核验已有提交，核验通过后再继续。" : "点击继续执行尚未提交的任务，按批次底价模式保存并核验。"));
        return;
      }
      if (this.batch && this.batch.phase !== "done" && this.batch.phase !== "draft") throw new Error("请先处理当前批次；不能覆盖未完成批次");
      if (!config.rows.length || config.rows.some((r) => r.errors.length)) throw new Error("请先修正创建清单中的全部行级错误");
      const requestedMode = config.partnerBidding ? "disabled" : config.mode ?? "manual";
      this.preflightSignature = "";
      this.panel.update({ ready: false });
      this.cleanupIdlePages();
      await Promise.all(this.cleanupWork.values());
      if (this.cleanupError) throw this.cleanupError;
      for (const [id, slot] of this.slots) if (!slot.busy && !slot.tab) this.removeSlot(id);
      this.notice("预检：确认当前账号、主控锁和输入…");
      await this.identify();
      if (config.confirmedIdentity) this.checkConfirmedIdentity(config);
      await this.acquire();
      const active = get("active:" + this.identity.publisherId, void 0);
      if (active && active.id !== this.batch?.id) {
        const old = get("batch:" + this.identity.publisherId + ":" + active.appId + ":" + active.id, void 0);
        if (old?.stopRequestedAt) this.archiveStopped(old);
        else if (old && old.phase !== "done") throw new Error("此发布商还有未完成批次，请进入原应用恢复：" + active.appId);
      }
      let canaryEvidence;
      const previous = this.batch;
      if (config.execution === "tabs" && previous?.phase === "done" && sameIdentity(previous.identity, this.identity) && previous.format === config.format && previous.mode === requestedMode && (previous.partnerBidding ?? false) === (config.partnerBidding ?? false) && this.adapter.verifyById) {
        const sample = previous.tasks.find((task) => task.status === "success" && task.actual?.verified === true && sameIdentity(task.actual, this.identity) && task.actual.format === config.format && task.actual.name === task.name && matchesRequestedConfiguration(task.actual, task.floor, previous.mode, previous.partnerBidding) && new RegExp(`^ca-app-${this.identity.publisherId}/\\d{10}$`).test(task.actual.unitId || ""));
        if (sample) {
          this.notice("预检：按 ID 只读复核历史成功样本，确认后让新清单直接并发…");
          try {
            const actual = await this.adapter.verifyById(this.identity, sample.actual.unitId, sample.name, config.format, sample.floor, previous.mode, previous.partnerBidding);
            if (!actual.verified || !sameIdentity(actual, this.identity) || actual.unitId !== sample.actual.unitId || actual.name !== sample.name || actual.format !== config.format || !matchesRequestedConfiguration(actual, sample.floor, previous.mode, previous.partnerBidding)) throw new Error("历史样本配置已变化");
            canaryEvidence = { sourceBatchId: previous.id, unitId: actual.unitId, verifiedAt: (/* @__PURE__ */ new Date()).toISOString() };
          } catch {
            await this.adapter.home(previous.identity);
            await this.identify();
            await this.acquire();
            if (!sameIdentity(previous.identity, this.identity)) throw new Error("历史样本检查期间账号或应用发生变化，已停止");
            this.notice("历史样本不可用，本批先核验首条再扩展并发。");
          }
        }
      }
      const batch = createBatch(config.rows, this.identity, config.format, config.concurrency, config.execution, location.href, this.id, requestedMode, config.partnerBidding ?? false);
      if (canaryEvidence) {
        batch.canaryPassed = true;
        batch.canaryEvidence = canaryEvidence;
      }
      this.batch = batch;
      for (const task of batch.tasks) {
        transition(task, "pending", "AdMob 允许重名；预检不查询同名，创建后立即记录新广告位 ID");
      }
      this.save();
      this.refreshHistory();
      if (config.execution === "tabs") {
        await this.warmPool(batch.concurrency);
      } else if (config.execution === "paged") await this.warmPaged();
      this.preflightSignature = this.signature(config);
      const pending = batch.tasks.filter((t) => t.status === "pending").length;
      const blocked = batch.tasks.filter((t) => ["uncertain", "conflict"].includes(t.status)).length;
      this.panel.update({ ready: pending > 0, checks: [{ label: "已固定发布商及应用", ok: true }, { label: "创建清单有效", ok: true }, { label: "AdMob 允许重名；检查不查询同名、不阻止创建", ok: true }, { label: blocked ? `${blocked} 行冲突/待核验，不会提交` : "无冲突或待核验项", ok: blocked === 0 }, { label: batch.partnerBidding ? "按合作平台出价设置创建，保存后核验此设置" : batch.mode === "manual" ? "底价按已确定的逐行金额与整批 USD 使用，执行时自动填写和读回" : "按所选底价模式创建，保存后核验模式", ok: true }, { label: canaryEvidence ? "历史成功样本已按 ID 复核，新清单可直接并发；每行仍独立保存后核验" : batch.execution === "tabs" ? "先并行准备表单，首条核验通过后放行其他提交" : "按行创建并核验", ok: true }, { label: batch.execution === "tabs" ? `${batch.concurrency} 个执行页已完成前台启动，跨页互斥、通知及账号检查均通过` : batch.execution === "paged" ? `${pending} 个任务页已预开并通过检查；逐页切到前台，核验并确认关闭后进入下一页` : "单页执行；已取得账号主控锁", ok: true }] });
      this.notice("执行条件检查通过。待创建 " + pending + " 条；AdMob 允许重名，每行创建后立即记录新 ID，并核验保存后的" + (batch.partnerBidding ? "合作平台出价设置。" : "底价模式及配置。"));
    }
    async checkCrossPage(checkFocus = false) {
      if (this.batch && ["running", "stopping"].includes(this.batch.phase) || [...this.slots.values()].some((slot) => !!slot.busy)) throw new Error("当前批次仍在执行或收集结果，暂不进行独立跨页检查；不会中断已有任务。");
      const hadLock = !!this.lockRelease;
      this.notice("跨页检查 1/3：正在识别当前账号和应用（不创建广告位）…");
      try {
        const identity = await this.adapter.identify();
        if (this.batch && this.batch.phase !== "done" && !sameIdentity(identity, this.batch.identity)) throw new Error("当前应用与未结束批次不一致；请回到原应用后检查，原批次保持不变。");
        this.identity = identity;
        this.panel.update({ identity, identityError: "" });
        this.notice("跨页检查 1/3：正在检查主控锁和 GM 存取…");
        await this.acquire();
        if (checkFocus) {
          const probes = await this.openCreatePages(identity, [void 0, void 0]);
          try {
            for (const slot of probes) await this.activatePagedSlot(slot);
          } finally {
            const closed = [];
            for (const slot of probes.reverse()) closed.push(await this.closeProbe(slot));
            if (closed.includes(false)) throw new Error("部分诊断执行页尚未确认关闭");
          }
          this.notice("跨页检查通过：已批量打开两个创建页，均完成前台核对和关闭。");
        } else await this.probe(true, true, "跨页检查");
      } catch (error) {
        this.notice("跨页检查失败：" + error.message);
        throw error;
      } finally {
        if (!hadLock && this.lockRelease) {
          this.lockRelease();
          this.lockRelease = void 0;
          this.lockedPublisher = "";
        }
      }
    }
    async closeProbe(slot) {
      if (slot.busy) return false;
      let mayClean = false;
      try {
        const command = get("command:" + slot.id, { seq: 0 });
        if (command.job) return false;
        set("command:" + slot.id, { seq: command.seq + 1, close: true });
        const disconnected = slot.lastReport ? await waitFor(() => get("report:" + slot.id, void 0)?.type === "closed" ? true : void 0, 1500, "report:" + slot.id).catch(() => false) : false;
        if (slot.tab) {
          await this.closeKnownTab(slot);
          mayClean = true;
          return true;
        }
        mayClean = disconnected;
        return disconnected;
      } catch {
        try {
          if (slot.tab) {
            await this.closeKnownTab(slot);
            mayClean = true;
            return true;
          }
        } catch {
        }
        if (slot.tab && !slot.tab.closed) {
          this.cleanupError = new Error("执行页未确认关闭，保留其归属并停止后续开页");
          if (!this.slots.has(slot.id)) this.addSlot(slot);
        }
        return false;
      } finally {
        if (mayClean) {
          try {
            this.removeSlot(slot.id);
          } catch {
            this.slots.delete(slot.id);
          }
          for (const key of ["command:", "report:"]) try {
            GM_deleteValue("abc:v1:" + key + slot.id);
          } catch {
          }
        }
      }
    }
    async probe(forceNew = false, diagnostic = false, label = "执行页连接", taskId) {
      if (!this.identity) throw new Error("未识别账号");
      const reusable = [...this.slots.values()].find((s) => !s.busy && s.probePassed && !s.tab?.closed && s.identity && sameIdentity(s.identity, this.identity) && s.batchId === this.batch?.id);
      if (reusable && !forceNew && !diagnostic) return reusable;
      if (this.probing) throw new Error("执行页连接检查仍在进行，请等待本次结果。");
      this.probing = true;
      const identity = structuredClone(this.identity);
      const nonce = uuid(), lockName = "admob-batch-probe:" + nonce;
      let release = () => {
      }, started = false, passed = false, stage = "启动";
      const slot = { id: uuid(), since: Date.now(), identity, batchId: diagnostic ? void 0 : this.batch?.id, taskId };
      try {
        release = await holdLock(lockName);
        if (!diagnostic) this.addSlot(slot);
        const url = this.workerUrl(identity, slot.id, "list");
        started = true;
        set("command:" + slot.id, { seq: 1, probe: { nonce, lockName, identify: false } });
        const startupTimeout = 25e3;
        this.panel.update({ workerUrl: diagnostic ? url : "" });
        let automatic = true;
        this.notice(diagnostic ? `${label} 2/3：已请求前台打开执行页，等待启动回应。也可点击“打开执行页”手动连接（不提交）…` : `${label} 2/3：正在前台打开执行页并自动检查。保持所选并行模式；当前不提交广告位。`);
        try {
          if (typeof document !== "undefined" && document.getElementById("abc-panel-host")?.hasAttribute("data-manual-tabs")) automatic = false;
          else slot.tab = GM_openInTab(url, { active: true, insert: true, setParent: true });
        } catch {
          automatic = false;
        }
        if (!automatic) {
          if (!diagnostic) throw new WorkerCapabilityUnavailable("并行启动失败：当前环境未能自动打开执行页，已保留并行配置且未提交。可选择串行模式后重新确认。");
          this.notice(`${label} 2/3：自动打开不可用，请点击“打开执行页”；连接后继续检查，25 秒内等待手动连接，不提交广告位。`);
        }
        const openedAt = Date.now();
        let remaining = -1;
        const first = await waitFor(() => {
          const r = get("report:" + slot.id, void 0);
          if (r?.workerId === slot.id && r.type === "hello" && r.probe?.nonce === nonce) return r;
          const elapsed = Date.now() - openedAt, seconds = Math.max(0, Math.ceil((startupTimeout - elapsed) / 1e3));
          if (elapsed >= 3e3 && seconds !== remaining) {
            remaining = seconds;
            this.notice(diagnostic ? `${label} 2/3：${automatic ? "自动打开尚未收到执行页回应" : "等待手动打开执行页"}。请点击“打开执行页”，保持新页加载；还可等待 ${seconds} 秒。当前未提交广告位。` : `${label} 2/3：前台执行页尚未回应，还可等待 ${seconds} 秒；未派发创建任务，保持并行配置。`);
          }
          return void 0;
        }, startupTimeout, "report:" + slot.id);
        slot.lastReport = first.id;
        if (first.probe?.error) throw /超时|timeout/i.test(first.probe.error) ? new WorkerCapabilityUnavailable("执行页账号识别超时：" + first.probe.error) : new Error("执行页已连接，但账号识别失败：" + first.probe.error);
        stage = "通知及身份";
        this.notice(`${label} 3/3：执行页已回应，正在检查跨页锁、GM 通知和同一账号/应用（不提交）…`);
        const challenge = uuid();
        set("command:" + slot.id, { seq: 2, probe: { nonce: challenge, lockName, identify: true } });
        const report = await this.waitForProbe(slot, challenge);
        if (report.probe?.identity && !sameIdentity(report.probe.identity, identity) || !this.identity || !sameIdentity(this.identity, identity)) throw new Error("执行页账号或应用检查失败：与本次主控身份不一致，未派发任何新任务。");
        if (report.probe?.error) throw /超时|timeout/i.test(report.probe.error) ? new WorkerCapabilityUnavailable("执行页账号识别超时：" + report.probe.error) : new Error("执行页账号识别失败：" + report.probe.error);
        if (!report.probe?.locked) throw new WorkerCapabilityUnavailable("跨页锁能力检查未通过");
        if (!report.probe.notifications) throw new WorkerCapabilityUnavailable("GM 通知能力检查未通过");
        if (!report.probe.identity) throw new WorkerCapabilityUnavailable("执行页未完成账号身份读取");
        slot.probePassed = true;
        slot.lastReport = report.id;
        passed = true;
        this.notice(diagnostic ? "跨页检查通过：执行页连接、跨页锁、GM 通知和账号均正常；未创建广告位，正在清理诊断页。" : `${label}通过：连接、跨页锁、GM 通知和账号均正常；尚未提交广告位。`);
        return slot;
      } catch (error) {
        const message = error.message;
        const timedOut = message.includes("跨页通信等待超时");
        const detail = timedOut ? stage === "启动" ? diagnostic ? "执行页启动超时：25 秒内未收到新页回应。自动开页未建立连接；可重新检查并在等待期间点击“打开执行页”，或改为单页模式。" : "并行启动超时：前台开页后 25 秒内未收到执行页回应；已保留并行配置，未提交广告位。可选择串行模式后重新确认。" : "通知及账号检查超时：执行页已启动，但 25 秒内未完成 GM 通知和身份回读" : message;
        this.notice(`${label}失败：${detail}`);
        throw timedOut || error instanceof WorkerCapabilityUnavailable ? new WorkerCapabilityUnavailable(detail) : new Error(detail);
      } finally {
        let disconnected = false;
        try {
          if (started && (diagnostic || !passed)) disconnected = await this.closeProbe(slot);
          else if (!passed) this.removeSlot(slot.id);
        } finally {
          this.probing = false;
          try {
            release();
          } finally {
            this.panel.update({ workerUrl: "" });
          }
        }
        if (diagnostic && passed) this.notice("跨页检查通过：执行页连接、跨页锁、GM 通知和账号均正常；未创建广告位。" + (disconnected ? "诊断连接已释放。" : "已请求关闭诊断页；如页面仍打开，可手动关闭。"));
      }
    }
    async start(config) {
      const requestedAt = (/* @__PURE__ */ new Date()).toISOString();
      if (this.batch && !["draft", "done"].includes(this.batch.phase)) throw new Error("当前批次尚未结束，请使用暂停、继续或停止");
      this.checkConfirmedIdentity(config);
      if (!this.batch || this.batch.phase !== "draft" || this.preflightSignature !== this.signature(config)) await this.preflight(config);
      this.requireBatch();
      await this.identify();
      this.checkConfirmedIdentity(config);
      await this.acquire();
      if (this.batch.phase !== "draft" || this.preflightSignature !== this.signature(config)) throw new Error("输入或账号已变化，请检查清单后重新点击开始创建");
      this.batch.startedAt = requestedAt;
      delete this.batch.completedAt;
      this.batch.confirmedAt = (/* @__PURE__ */ new Date()).toISOString();
      this.batch.phase = "running";
      set("active:" + this.batch.identity.publisherId, { appId: this.batch.identity.appId, id: this.batch.id });
      this.save();
      this.refreshHistory();
      this.notice(this.batch.execution === "paged" ? "并发批次已开始。创建页已批量打开，插件将逐页核对、创建、核验并关闭。" : this.batch.execution === "single" ? "批次已开始，在当前页逐条创建并核验。" : this.batch.canaryEvidence ? "并行批次已开始。历史成功样本已重新核验，各页准备和核验并发，提交按账号间隔执行。" : "并行批次已开始。各执行页同时准备表单，首条保存后核验通过后自动放行其他提交。");
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
      const batch = this.batch;
      batch.stopRequestedAt ??= (/* @__PURE__ */ new Date()).toISOString();
      batch.phase = "stopping";
      this.preflightSignature = "";
      this.panel.update({ ready: false });
      this.save();
      this.archiveStopped(batch);
      this.notice("批次已停止并归档，可填写新清单。未决结果、已知 ID 和原执行页保留，可在历史中只读核验。");
    }
    async resume() {
      this.requireBatch();
      await this.identify();
      await this.acquire();
      if (this.batch.stopRequestedAt) throw new Error("批次已停止；先核验已提交结果，或明确点击重试尚未提交的失败项");
      if (!this.batch.confirmedAt) throw new Error("草稿尚未确认开始；检查清单后点击开始创建");
      if (!sameIdentity(this.identity, this.batch.identity)) throw new Error("请回到批次原发布商与原应用");
      if (this.batch.phase === "stopping") throw new Error("批次已停止；仅可核验已有提交或重试明确失败项");
      if (this.batch.phase !== "paused") throw new Error("只有已暂停且已确认的批次可以继续");
      const unresolved = this.batch.tasks.filter((t) => needsVerification(t) && !["success", "exists"].includes(t.status));
      if (unresolved.length) throw new Error(`还有 ${unresolved.length} 条提交结果或配置待核验；请先点击“核验结果不确定项”，核验通过后再继续`);
      await Promise.all(this.cleanupWork.values());
      if (this.cleanupError) {
        this.cleanupError = void 0;
        this.cleanupIdlePages();
        await Promise.all(this.cleanupWork.values());
        if (this.cleanupError) throw this.cleanupError;
      }
      if (this.batch.execution === "paged") await this.warmPaged();
      this.batch.phase = "running";
      this.errors = 0;
      this.save();
      this.notice("批次已继续。执行尚未提交的任务，按批次底价模式保存并核验，页面明确冲突时会报告。");
    }
    async retry() {
      this.requireBatch();
      if (this.batch.stopRequestedAt) throw new Error("已停止批次仅可在历史中核验或导出；请填写新清单创建新批次");
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
        delete this.batch.completedAt;
        this.batch.phase = "paused";
      }
      this.save();
      this.notice("已准备 " + count + " 条安全重试项（最多三次，按尝试次数退避）；" + (count > 0 ? "点击继续后执行。" : "保持原批次状态。"));
    }
    async recordObservedId(taskId, unitId) {
      this.requireBatch();
      if (this.batch.phase !== "paused") throw new Error("请先暂停批次，再录入已观察到的广告位 ID");
      const task = this.batch.tasks.find((task2) => task2.id === taskId);
      if (!task || !task.intentAt || !needsVerification(task) || !["uncertain", "created-unverified", "submitting", "verifying"].includes(task.status)) throw new Error("只有已有提交意图且结果待核验的任务可录入已观察 ID");
      const observed = unitId.trim();
      if (!/^ca-app-pub-\d{16}\/\d{10}$/.test(observed) || !observed.startsWith(`ca-app-${this.batch.identity.publisherId}/`)) throw new Error("广告位 ID 格式无效或与批次发布商不匹配");
      if (task.actual?.unitId && task.actual.unitId !== observed) throw new Error("已知广告位 ID 与录入值不同；保留原 ID，禁止覆盖");
      task.actual = { ...task.actual, unitId: observed, publisherId: this.batch.identity.publisherId, appId: this.batch.identity.appId, verified: false };
      transition(task, "created-unverified", "已记录用户观察到的广告位 ID；保存后配置待核验");
      this.save();
      await this.verify();
    }
    async stoppedHistory(id) {
      if (this.localBusy || this.batch && ["running", "stopping"].includes(this.batch.phase)) throw new Error("当前批次仍在执行，请暂停并收齐结果后再核验历史");
      await this.identify();
      await this.acquire();
      const stored = this.readHistory(id);
      if (stored.phase !== "done" || !stored.stopRequestedAt) throw new Error("仅可只读恢复已停止的历史批次");
      const batch = this.batch?.id === id ? this.batch : this.archives.get(id)?.batch || stored;
      if (!this.archives.has(id)) {
        const archive = { batch, slots: /* @__PURE__ */ new Map() };
        this.archives.set(id, archive);
        for (const task of batch.tasks) if (task.workerId && task.assignmentId) {
          const slot = { id: task.workerId, busy: task.assignmentId, since: Date.now(), batchId: id, taskId: task.id };
          archive.slots.set(slot.id, slot);
          slot.removeReportListener = listen("report:" + slot.id, () => this.collectArchives());
        }
      }
      this.collectArchives();
      await Promise.all(this.archiveWork.values());
      return batch;
    }
    async recordHistoryObservedId(id, taskId, unitId) {
      const batch = await this.stoppedHistory(id), task = batch.tasks.find((task2) => task2.id === taskId), observed = unitId.trim();
      if (!task || !task.intentAt || !needsVerification(task) || ["success", "exists"].includes(task.status)) throw new Error("只有已有提交意图且结果待核验的历史任务可录入 ID");
      if (!/^ca-app-pub-\d{16}\/\d{10}$/.test(observed) || !observed.startsWith(`ca-app-${batch.identity.publisherId}/`)) throw new Error("广告位 ID 格式无效或与历史批次发布商不匹配");
      if (task.actual?.unitId && task.actual.unitId !== observed) throw new Error("已知广告位 ID 与录入值不同；保留原 ID，禁止覆盖");
      task.actual = { ...task.actual, unitId: observed, publisherId: batch.identity.publisherId, appId: batch.identity.appId, verified: false };
      transition(task, "created-unverified", "已记录历史任务观察到的广告位 ID，等待只读核验");
      this.saveArchive(batch);
      await this.verifyStoppedHistory(batch);
    }
    async verifyHistory(id) {
      await this.verifyStoppedHistory(await this.stoppedHistory(id));
    }
    async verifyStoppedHistory(batch) {
      if (this.localBusy) throw new Error("当前页面仍在收集执行结果，请稍后核验历史");
      this.localBusy = true;
      try {
        for (const task of batch.tasks.filter((task2) => needsVerification(task2) && !["success", "exists"].includes(task2.status))) {
          const knownId2 = task.actual?.unitId;
          if (!knownId2) {
            this.saveArchive(batch);
            continue;
          }
          if (!new RegExp(`^ca-app-${batch.identity.publisherId}/\\d{10}$`).test(knownId2)) continue;
          if (!this.adapter.verifyById) {
            task.reason = "历史任务需要按已知 ID 核验，当前页面暂不支持；原记录保留";
            this.saveArchive(batch);
            continue;
          }
          transition(task, "verifying", "只读核验已停止历史批次的真实 ID");
          try {
            const actual = await this.adapter.verifyById(batch.identity, knownId2, task.name, batch.format, task.floor, batch.mode, batch.partnerBidding);
            if (["success", "exists"].includes(task.status)) continue;
            if (actual.unitId !== knownId2) {
              transition(task, "created-unverified", "详情返回不同 ID，保留历史原 ID，禁止重新创建");
            } else {
              task.actual = actual;
              const verified = actual.verified && sameIdentity(actual, batch.identity) && actual.format === batch.format && matchesRequestedConfiguration(actual, task.floor, batch.mode, batch.partnerBidding);
              transition(task, verified ? "success" : "created-unverified", verified ? "历史批次已按真实 ID 核验保存配置" : "历史真实 ID 配置尚未完整核验");
            }
          } catch (error) {
            if (!["success", "exists"].includes(task.status)) transition(task, "created-unverified", "历史只读核验失败：" + error.message + "；保留原 ID，禁止重新创建");
          }
          this.saveArchive(batch);
        }
        await this.adapter.home(batch.identity);
        await this.identify();
        this.notice("历史只读核验结束；已停止批次保持归档，原未决结果及 ID 保留，不会恢复创建。");
      } finally {
        this.localBusy = false;
        this.saveArchive(batch);
      }
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
            const knownId2 = task.actual?.unitId;
            if (knownId2 && this.adapter.verifyById) {
              const actual = await this.adapter.verifyById(this.batch.identity, knownId2, task.name, this.batch.format, task.floor, this.batch.mode, this.batch.partnerBidding);
              if (actual.unitId !== knownId2) {
                transition(task, "created-unverified", "保存详情返回的 ID 与已知 ID 不一致；保留原 ID，禁止重新创建");
                this.save();
                continue;
              }
              task.actual = actual;
              if (actual.verified && sameIdentity(actual, this.batch.identity) && actual.format === this.batch.format && matchesRequestedConfiguration(actual, task.floor, this.batch.mode, this.batch.partnerBidding)) {
                transition(task, "success", "已按已知 ID 核验保存配置");
                this.batch.canaryPassed = true;
                if (task.workerId) {
                  const slot = this.slots.get(task.workerId);
                  if (slot) {
                    const command = get("command:" + slot.id, { seq: 0 });
                    set("command:" + slot.id, { seq: command.seq + 1, blocked: "此任务已由主控完成只读核验，原创建分配已撤销" });
                    slot.busy = void 0;
                    slot.probePassed = false;
                  }
                }
              } else transition(task, "created-unverified", "已取得 ID，保存后配置未完整核验");
              this.save();
              continue;
            }
            if (!knownId2) {
              transition(task, "uncertain", "缺少本次创建的广告位 ID，请保留原执行页或录入成功说明中的 ID 后核验");
              this.save();
              continue;
            }
            if (this.batch.partnerBidding === true) {
              transition(task, "created-unverified", "无法按 ID 核验合作平台出价设置，保留已知 ID");
              this.save();
              continue;
            }
            const lookup = await this.adapter.lookup(this.batch.identity, task.name);
            const c = classifyLookup(lookup, this.batch.identity, this.batch.format, task.name, task.floor, this.batch.mode);
            if (c.status === "exists") {
              const prior = task.actual?.unitId;
              if (prior && c.actual?.unitId !== prior) {
                transition(task, "created-unverified", "同名条目 ID 与已取得 ID 不符，保留原记录等待人工核验");
                this.save();
                continue;
              }
              task.actual = c.actual;
              transition(task, prior ? "success" : "exists", prior ? "已按已知 ID 核验保存配置" : "发现同名同配置广告位；无法判定是否本批创建，记录为已存在");
              if (prior) this.batch.canaryPassed = true;
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
        await this.adapter.home(this.batch.identity);
        await this.identify();
        const remaining = this.batch.tasks.filter((t) => needsVerification(t) && !["success", "exists"].includes(t.status)).length;
        this.notice(remaining ? `只读核验结束，仍有 ${remaining} 条结果或配置待核验；保留已知 ID，禁止重新创建。` : "只读核验通过。批次保持暂停，点击继续才会执行尚未提交的任务。");
      } finally {
        this.localBusy = false;
        this.save();
      }
    }
    async dispatch(slot, task) {
      const batch = this.batch;
      if (!batch.tasks.includes(task)) throw new Error("任务不属于当前批次，禁止派发。");
      if (task.status !== "pending" || task.assignmentId || task.intentAt || task.actual?.unitId) throw new Error("任务已有归属、提交意图或真实 ID，禁止派发新的创建任务。");
      task.workerId = slot.id;
      task.assignmentId = uuid();
      task.attempts++;
      slot.busy = task.assignmentId;
      slot.since = Date.now();
      const job = { batch: { id: batch.id, identity: structuredClone(batch.identity), format: batch.format, mode: batch.mode, partnerBidding: batch.partnerBidding, controllerId: batch.controllerId, phase: batch.phase }, task: structuredClone(task), assignmentId: task.assignmentId, workerId: slot.id, kind: "create", parallelPreparation: batch.execution === "tabs" && batch.concurrency > 1, requireForeground: batch.execution === "paged" };
      this.save();
      const priorCommand = get("command:" + slot.id, { seq: 0 });
      set("command:" + slot.id, { seq: priorCommand.seq + 1, job, ack: priorCommand.ack });
      if (batch.execution === "single") {
        this.localBusy = true;
        void performJob(job, this.adapter, async (data) => {
          await this.handle(slot, { ...data, id: uuid(), at: Date.now(), workerId: slot.id });
        }, (beforeClick) => {
          if (this.batch?.phase !== "running") throw new Error("任务已暂停或停止，在提交前安全停下");
          const control = get(this.key(batch), void 0);
          const command = get("command:" + slot.id, { seq: 0 });
          if (!control || control.controllerId !== job.batch.controllerId || command.job?.assignmentId !== job.assignmentId) throw new Error("任务归属已变更，停止当前执行");
          if (control.phase !== "running") throw new Error("任务已暂停或停止，在提交前安全停下");
          if (command.blocked) throw new Error(command.blocked);
          if ((beforeClick || task.intentAt) && (!command.grant || command.grant.assignmentId !== job.assignmentId || command.grant.expires <= Date.now())) throw new Error("提交许可已过期，未点击创建");
        }).catch((e) => this.pause("单页通信或存储异常：" + e.message)).finally(() => {
          this.localBusy = false;
        });
      }
    }
    intentContext(batch, task, slot, r) {
      if (this.batch !== batch || !batch.tasks.includes(task) || !reportBelongs(r, task, slot.id)) return void 0;
      const persisted = get(this.key(batch), void 0), command = get("command:" + slot.id, { seq: 0 });
      const saved = persisted?.tasks.find((row) => row.id === task.id && row.assignmentId === r.assignmentId && row.workerId === slot.id);
      if (!persisted || !saved || persisted.controllerId !== this.id || batch.controllerId !== this.id || command.job?.batch.id !== batch.id || command.job.batch.controllerId !== this.id || command.job.assignmentId !== r.assignmentId || command.job.workerId !== slot.id || command.job.task.id !== task.id) return void 0;
      return { command, persisted, task: saved };
    }
    supersededIntent(slot, task, r) {
      const journal = get("journal:" + r.assignmentId, void 0);
      if (journal?.state === "done" && journal.report && reportBelongs(journal.report, task, slot.id) && ["result", "error"].includes(journal.report.type)) return true;
      const current = get("report:" + slot.id, void 0);
      return !!current && current.id !== r.id && reportBelongs(current, task, slot.id) && current.at >= r.at;
    }
    async handleIntent(batch, task, slot, r) {
      let unlock;
      const previous = this.grantTail;
      this.grantTail = new Promise((resolve) => {
        unlock = resolve;
      });
      await previous;
      try {
        const reason = () => {
          const context2 = this.intentContext(batch, task, slot, r);
          if (!context2) return "任务归属已变化";
          if (this.supersededIntent(slot, task, r)) return "执行页已报告后续结果";
          if (!Number.isFinite(r.at) || r.at > Date.now() + 1e3 || Date.now() - r.at > 1e4) return "提交意图已过期，拒绝迟到的提交许可";
          if (Date.now() - slot.since > 12e4 || !["pending", "filling"].includes(task.status) || !["pending", "filling"].includes(context2.task.status)) return "执行分配已超时或不再等待提交";
          if (batch.phase !== "running" || context2.persisted.phase !== "running") return "批次已暂停或停止，主控拒绝提交许可";
          if (task.intentAt || context2.task.intentAt || task.actual?.unitId || context2.task.actual?.unitId || context2.command.grant) return "本分配已有提交意图、许可或真实 ID，禁止重复许可";
          if (!canSubmitPrepared(context2.persisted, context2.task)) return "首条保存后核验尚未通过，当前任务没有提交许可";
          return "";
        };
        let blocked = reason();
        if (!blocked) {
          const last = Math.max(this.lastSubmit, get("lastSubmit:" + batch.identity.publisherId, 0));
          const delay = Math.max(0, 2500 - (Date.now() - last));
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          blocked = reason();
        }
        if (!blocked) {
          try {
            const current = await this.adapter.identify();
            blocked = reason();
            if (!blocked && !sameIdentity(current, batch.identity)) {
              await this.pause("主控账号或应用发生变化");
              blocked = "主控账号或应用发生变化，拒绝提交许可";
            }
          } catch (error) {
            blocked = reason() || "主控无法确认当前账号：" + error.message;
            if (this.batch === batch) {
              await this.pause(blocked);
            }
          }
        }
        const context = this.intentContext(batch, task, slot, r);
        if (!context || this.supersededIntent(slot, task, r)) {
          this.handledReports.add(r.id);
          return;
        }
        const command = context.command;
        if (command.ack === r.id) {
          this.handledReports.add(r.id);
          slot.lastReport = r.id;
          return;
        }
        blocked = blocked || reason();
        if (blocked) command.blocked = blocked;
        else {
          task.intentAt = (/* @__PURE__ */ new Date()).toISOString();
          transition(task, "submitting", "提交意图已持久化");
          this.save();
          command.blocked = void 0;
          command.grant = { assignmentId: task.assignmentId, expires: Date.now() + 1e4 };
          this.lastSubmit = Date.now();
          set("lastSubmit:" + batch.identity.publisherId, this.lastSubmit);
          slot.since = Date.now();
        }
        command.ack = r.id;
        command.seq++;
        set("command:" + slot.id, command);
        slot.lastReport = r.id;
        this.handledReports.add(r.id);
      } finally {
        unlock();
      }
    }
    provenUnsubmitted(slot, task, r, command) {
      if (!this.batch || task.intentAt || task.actual?.unitId || r.actual?.unitId || command.grant) return false;
      const context = this.intentContext(this.batch, task, slot, r);
      const journal = get("journal:" + r.assignmentId, void 0);
      return !!context && !context.task.intentAt && !context.task.actual?.unitId && journal?.state === "done" && journal.batchId === this.batch.id && journal.taskId === task.id && journal.assignmentId === r.assignmentId && journal.report?.id === r.id && journal.report.type === "error" && reportBelongs(journal.report, task, slot.id) && !journal.report.actual?.unitId;
    }
    async handle(slot, r) {
      const archived = [...this.archives.values()].find((archive) => archive.batch.tasks.some((task2) => reportBelongs(r, task2, slot.id)));
      if (archived) {
        const task2 = archived.batch.tasks.find((task3) => reportBelongs(r, task3, slot.id));
        if (["stage", "result", "error"].includes(r.type)) await this.handleArchived(archived.batch, slot, task2, r);
        return;
      }
      const task = this.batch?.tasks.find((t) => t.assignmentId === r.assignmentId);
      if (!task || !reportBelongs(r, task, slot.id) || slot.lastReport === r.id || this.handledReports.has(r.id)) return;
      const cmd = get("command:" + slot.id, { seq: 0 });
      if (cmd.ack === r.id) {
        slot.lastReport = r.id;
        this.handledReports.add(r.id);
        if (["result", "error"].includes(r.type) && slot.busy === r.assignmentId) slot.busy = void 0;
        return;
      }
      if (["success", "exists"].includes(task.status)) {
        cmd.ack = r.id;
        cmd.seq++;
        set("command:" + slot.id, cmd);
        slot.lastReport = r.id;
        this.handledReports.add(r.id);
        if (slot.busy === r.assignmentId) slot.busy = void 0;
        return;
      }
      if (r.type === "intent") {
        await this.handleIntent(this.batch, task, slot, r);
        return;
      }
      slot.since = Math.max(slot.since, Math.min(Date.now(), r.at));
      if (r.type === "stage") {
        if (r.actual?.unitId && !task.actual?.unitId) task.actual = { ...task.actual, ...r.actual };
        if (r.stage === "filling" && (task.status === "pending" || task.status === "filling" && r.reason)) transition(task, "filling", r.reason || "");
        if (r.stage === "verifying" && ["submitting", "uncertain", "created-unverified"].includes(task.status)) transition(task, "verifying");
      } else if (r.type === "result" || r.type === "error") {
        const idMismatch = !!task.actual?.unitId && !!r.actual?.unitId && task.actual.unitId !== r.actual.unitId;
        if (r.actual?.unitId && !idMismatch) task.actual = { ...task.actual, ...r.actual };
        let status = r.status || "uncertain";
        if (idMismatch) status = "created-unverified";
        if (r.type === "error" && status === "uncertain" && !task.intentAt && !task.actual?.unitId && !cmd.grant && (cmd.blocked || this.provenUnsubmitted(slot, task, r, cmd))) status = "failed";
        if (task.intentAt && status === "failed") status = task.actual?.unitId ? "created-unverified" : "uncertain";
        if (status === "success" && (task.actual?.format !== this.batch.format || !sameIdentity(task.actual, this.batch.identity) || !matchesRequestedConfiguration(task.actual, task.floor, this.batch.mode, this.batch.partnerBidding))) status = "created-unverified";
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
      this.handledReports.add(r.id);
      if (this.batch.execution === "paged" && ["result", "error"].includes(r.type) && !slot.busy) this.scheduleCleanup(slot);
    }
    async tick() {
      if (this.tickBusy || this.actionBusy || !this.batch) return;
      this.tickBusy = true;
      try {
        await Promise.all(this.drainReports());
        this.collectArchives();
        for (const slot of this.slots.values()) {
          if (slot.closing) continue;
          if (slot.busy && Date.now() - slot.since > 12e4) {
            const t = this.batch.tasks.find((t2) => t2.assignmentId === slot.busy);
            if (t && ["pending", "filling", "submitting", "verifying"].includes(t.status)) {
              transition(t, t.actual?.unitId ? "created-unverified" : "uncertain", "执行页长时间无结果，可能被后台冻结；保留归属，不重派");
              await this.pause("执行页超时，保留原执行页并先核验");
              this.save();
            }
          }
        }
        if (this.batch.stopRequestedAt && this.batch.phase !== "done") this.archiveStopped(this.batch);
        if (this.batch.phase === "done") {
          this.cleanupIdlePages();
          return;
        }
        if (this.batch.phase === "paused" && !this.batch.tasks.some((t) => ["pending", "filling", "submitting", "verifying", "uncertain", "created-unverified"].includes(t.status)) && ![...this.slots.values()].some((s) => s.busy)) {
          this.cleanupIdlePages();
          if (this.cleanupWork.size || this.cleanupError) return;
          this.batch.phase = "done";
          this.save();
          this.notice("批次执行结束，请核对并导出结果。");
        }
        if (this.batch.phase !== "running") return;
        if (this.cleanupError) return;
        if (Date.now() - this.lastIdentityCheck > 5e3 && !this.localBusy) {
          this.lastIdentityCheck = Date.now();
          if (!this.identityWork) {
            const batch = this.batch;
            this.identityWork = this.adapter.identify().then(async (identity) => {
              if (this.batch !== batch) return;
              if (!sameIdentity(identity, batch.identity)) {
                await this.pause("主控账号或应用发生变化");
                return;
              }
              this.identity = identity;
              this.panel.update({ identity, identityError: "" });
            }).catch(async (error) => {
              if (this.batch === batch) await this.pause("当前身份无法确认：" + error.message);
            }).finally(() => {
              this.identityWork = void 0;
            });
          }
        }
        const dispatchBatch = this.batch;
        while (this.batch === dispatchBatch && dispatchBatch.phase === "running" && !this.localBusy) {
          if (dispatchBatch.execution === "paged" && this.cleanupWork.size) break;
          const busy = [...this.slots.values()].filter((slot2) => !!slot2.busy).length;
          if (!canDispatch(dispatchBatch, busy)) break;
          const task = dispatchBatch.tasks.find((t) => t.status === "pending" && !t.assignmentId && !t.intentAt && !t.actual?.unitId && Date.now() - Date.parse(t.logs.at(-1)?.at || dispatchBatch.createdAt) > Math.max(0, t.attempts - 1) * 3e3);
          if (!task) break;
          let slot = [...this.slots.values()].find((s) => !s.busy && !s.closing && (this.batch.execution === "single" ? s.id === "single:" + this.id : s.probePassed && s.batchId === this.batch.id && !!s.identity && sameIdentity(s.identity, this.batch.identity) && (dispatchBatch.execution !== "paged" || s.taskId === task.id)) && !s.tab?.closed);
          if (!slot) {
            if (this.batch.execution === "single") {
              slot = { id: "single:" + this.id, since: Date.now() };
              this.addSlot(slot);
            } else {
              if (busy > 0) break;
              try {
                if (dispatchBatch.execution === "paged") {
                  await this.warmPaged();
                  slot = [...this.slots.values()].find((candidate) => candidate.taskId === task.id && candidate.probePassed && !candidate.closing && !candidate.tab?.closed);
                  if (!slot) throw new Error("未找到本行已预开的执行页");
                } else slot = await this.probe();
              } catch (error) {
                if (this.batch !== dispatchBatch || dispatchBatch.phase !== "running") return;
                throw error;
              }
            }
          }
          if (dispatchBatch.execution === "paged") await this.activatePagedSlot(slot);
          if (this.batch !== dispatchBatch || dispatchBatch.phase !== "running" || !dispatchBatch.tasks.includes(task)) {
            if (!slot.busy) await this.closeProbe(slot);
            return;
          }
          if (!this.localBusy && task.status === "pending" && !task.assignmentId) await this.dispatch(slot, task);
        }
        if (!this.batch.tasks.some((t) => ["pending", "filling", "submitting", "verifying"].includes(t.status)) && ![...this.slots.values()].some((s) => s.busy)) {
          this.cleanupIdlePages();
          if (this.cleanupWork.size || this.cleanupError) return;
          this.batch.phase = this.batch.tasks.some((t) => ["uncertain", "created-unverified"].includes(t.status)) ? "paused" : "done";
          this.save();
          this.notice(this.batch.phase === "done" ? "批次执行结束，请核对并导出结果。" : "存在待核验结果，禁止自动重建。");
        }
      } catch (error) {
        this.reportTickPending = false;
        throw error;
      } finally {
        this.tickBusy = false;
        if (this.reportTickPending) this.reportChanged();
      }
    }
    diagnostics() {
      const data = { schema: 1, at: (/* @__PURE__ */ new Date()).toISOString(), userAgent: navigator.userAgent, origin: location.origin, capabilities: { webLocks: !!navigator.locks, gmStorage: typeof GM_getValue === "function", gmNotifications: typeof GM_addValueChangeListener === "function", gmTabs: typeof GM_openInTab === "function" }, phase: this.batch?.phase, counts: this.batch?.tasks.reduce((a, t) => (a[t.status] = (a[t.status] || 0) + 1, a), {}), workers: [...this.slots.values()].map((s) => ({ busy: !!s.busy, probePassed: !!s.probePassed, closed: s.tab?.closed })), page: this.adapter.diagnostics() };
      download("AdMob-脱敏诊断-" + (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-") + ".json", JSON.stringify(data, null, 2), "application/json;charset=utf-8");
    }
  };

  // src/main.ts
  function saveTab(state) {
    try {
      if (typeof GM_saveTab === "function") GM_saveTab(state);
    } catch {
    }
  }
  async function initializeTab(href) {
    const marker = new URL(href).searchParams.get("__admob_batch_worker");
    const state = await tabState();
    if (marker && /^[\w-]{20,80}$/.test(marker)) {
      state.abcWorkerId = marker;
      saveTab(state);
    }
    if (!state.abcTabId) {
      state.abcTabId = uuid();
      saveTab(state);
    }
    return state;
  }
  async function main() {
    if (window.top !== window.self || document.getElementById("abc-panel-host") || document.getElementById("abc-batch-creator") || document.getElementById("abc-worker-status")) return;
    const state = await initializeTab(location.href);
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

// ==UserScript==
// @name         Steam 市场批量上架助手
// @namespace    https://steamcommunity.com/
// @version      0.3.1
// @description  在 Steam 库存页批量选择物品、查询最低价、修改售价并自动执行上架流程。
// @author       Codex
// @match        https://steamcommunity.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const PANEL_ID = "tm-batch-seller-panel";
  const STYLE_ID = "tm-batch-seller-style";
  const HOLDER_MARKER = "tm-batch-holder";
  const CHECKBOX_CLASS = "tm-batch-checkbox";
  const ROW_ID_PREFIX = "tm-batch-row-";
  const PANEL_LAYOUT_KEY = "tm-batch-seller-layout-v2";
  const PANEL_MIN_WIDTH = 320;
  const PANEL_MIN_HEIGHT = 420;
  const RESCAN_DELAY_MS = 400;
  const INVENTORY_SCAN_INTERVAL_MS = 1500;
  const PRICE_DELAY_MS = 850;
  const DETAILS_WAIT_MS = 3000;
  const DIALOG_WAIT_MS = 5000;
  const SUBMIT_WAIT_MS = 900;
  const PAGE_NAV_WAIT_MS = 6000;
  const PAGE_SETTLE_MS = 1200;
  const MAX_LOG_LINES = 24;
  const INVENTORY_ACTIONS = new Set([
    "scan",
    "select-all",
    "clear-selection",
    "query-prices",
    "apply-bulk-price",
    "start-queue",
    "sell-all-lowest",
    "sweep-inventory",
    "sweep-inventory-minus-one-cent",
  ]);

  const state = {
    items: new Map(),
    selectedIds: new Set(),
    logs: [],
    nextHolderId: 1,
    paused: false,
    scanTimer: null,
    autoScanTimer: null,
    mutationObserver: null,
    panel: {
      drag: null,
      resizeObserver: null,
    },
    inventorySweepRunning: false,
    counters: {
      lastScanCount: 0,
    },
    queue: {
      running: false,
      items: [],
      index: -1,
      results: {
        success: [],
        failed: [],
      },
    },
  };

  function log(message, extra) {
    const stamp = new Date().toLocaleTimeString();
    const lines = [`[${stamp}] ${message}`];
    if (extra !== undefined) {
      let extraText = "";
      if (typeof extra === "string") {
        extraText = extra;
      } else {
        try {
          extraText = JSON.stringify(extra);
        } catch {
          extraText = String(extra);
        }
      }
      if (extraText) {
        lines.push(`  ${extraText}`);
      }
    }
    state.logs.unshift(...lines.reverse());
    state.logs = state.logs.slice(0, MAX_LOG_LINES);
    console.log("[Steam 批量上架助手]", message, extra || "");
    renderLogs();
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function query(selector, root = document) {
    return root.querySelector(selector);
  }

  function queryAll(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function isVisible(node) {
    if (!node) {
      return false;
    }
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function waitForAnimationFrame() {
    return new Promise((resolve) => window.requestAnimationFrame(resolve));
  }

  function updateStatus(message, tone = "info") {
    const status = query(`#${PANEL_ID} [data-role="status"]`);
    if (!status) {
      return;
    }
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function isInventoryPage() {
    return /\/inventory(?:\/|$)/i.test(window.location.pathname);
  }

  function getCountryCode() {
    const raw =
      window.g_strCountryCode ||
      window.g_rgWalletInfo?.wallet_country ||
      window.g_AccountInventory?.m_owner?.country ||
      "US";
    return String(raw || "US").toUpperCase();
  }

  function getCurrencyCode() {
    return Number(window.g_rgWalletInfo?.wallet_currency || 1);
  }

  function parsePriceNumber(input) {
    if (!input) {
      return null;
    }
    let value = String(input).trim();
    value = value.replace(/[^\d,.\-]/g, "");
    if (!value) {
      return null;
    }

    const lastComma = value.lastIndexOf(",");
    const lastDot = value.lastIndexOf(".");
    if (lastComma !== -1 && lastDot !== -1) {
      if (lastComma > lastDot) {
        value = value.replaceAll(".", "").replace(",", ".");
      } else {
        value = value.replaceAll(",", "");
      }
    } else if (lastComma !== -1 && lastDot === -1) {
      const segments = value.split(",");
      if (segments.length === 2 && segments[1].length <= 2) {
        value = `${segments[0]}.${segments[1]}`;
      } else {
        value = value.replaceAll(",", "");
      }
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }
    return parsed;
  }

  function normalizeEditablePrice(input) {
    const numeric = parsePriceNumber(input);
    if (numeric === null) {
      return "";
    }
    return numeric.toFixed(2);
  }

  function setNativeValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    );
    descriptor?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
  }

  async function simulateTyping(input, value) {
    input.focus();
    setNativeValue(input, "");
    await sleep(60);
    for (const char of String(value)) {
      const nextValue = `${input.value}${char}`;
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: char }));
      setNativeValue(input, nextValue);
      input.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, key: char }));
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: char }));
      await sleep(45);
    }
    input.blur();
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    await sleep(120);
  }

  function clickElement(node) {
    if (!node) {
      return;
    }
    if (typeof node.click === "function") {
      node.click();
      return;
    }
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  }

  function buttonDisabled(button) {
    if (!button) {
      return true;
    }
    return (
      button.disabled ||
      button.classList.contains("btn_disabled") ||
      button.getAttribute("aria-disabled") === "true"
    );
  }

  function visibleInventoryPage() {
    const pages = queryAll(".inventory_page").filter(isVisible);
    if (pages.length > 0) {
      return pages[0];
    }
    return query(".inventory_page");
  }

  function currentItemHolders() {
    const page = visibleInventoryPage();
    if (!page) {
      return [];
    }
    return queryAll(".itemHolder", page).filter((holder) => isVisible(holder) && query("img", holder));
  }

  function ensureItemId(holder) {
    if (holder.dataset.tmBatchId) {
      return holder.dataset.tmBatchId;
    }
    const stableId = `holder-${state.nextHolderId}`;
    state.nextHolderId += 1;
    holder.dataset.tmBatchId = stableId;
    return stableId;
  }

  function guessItemLabel(holder, index) {
    const image = query("img", holder);
    const values = [
      image?.alt,
      image?.title,
      holder.getAttribute("title"),
      holder.dataset?.econItem,
      `物品 ${index + 1}`,
    ];
    return values.find(Boolean) || `物品 ${index + 1}`;
  }

  function buildItemRecord(holder, index) {
    const id = ensureItemId(holder);
    const existing = state.items.get(id);
    if (existing) {
      existing.element = holder;
      existing.label = guessItemLabel(holder, index);
      existing.checkbox = query(`.${CHECKBOX_CLASS} input`, holder) || existing.checkbox;
      return existing;
    }

    const item = {
      id,
      index,
      element: holder,
      checkbox: null,
      label: guessItemLabel(holder, index),
      name: "",
      appid: "",
      marketHashName: "",
      marketUrl: "",
      priceDisplay: "",
      priceValue: "",
      priceSource: "",
      status: "空闲",
      statusTone: "muted",
      lastError: "",
    };
    state.items.set(id, item);
    return item;
  }

  function selectedItems() {
    return Array.from(state.selectedIds)
      .map((id) => state.items.get(id))
      .filter(Boolean);
  }

  function inventoryActionsAvailable() {
    return isInventoryPage() && Boolean(visibleInventoryPage());
  }

  function findPanel() {
    return query(`#${PANEL_ID}`);
  }

  function renderLogs() {
    const container = query(`#${PANEL_ID} [data-role="logs"]`);
    if (!container) {
      return;
    }
    if (state.logs.length === 0) {
      container.innerHTML = `<div class="tm-log-empty">暂无日志。</div>`;
      return;
    }
    container.innerHTML = state.logs
      .map((line) => `<div class="tm-log-line">${escapeHtml(line)}</div>`)
      .join("");
  }

  function renderSummary() {
    const panel = findPanel();
    if (!panel) {
      return;
    }

    const detected = query('[data-role="detected-count"]', panel);
    const selected = query('[data-role="selected-count"]', panel);
    const queue = query('[data-role="queue-count"]', panel);
    const startButton = query('[data-action="start-queue"]', panel);
    const sellAllLowestButton = query('[data-action="sell-all-lowest"]', panel);
    const sweepInventoryButton = query('[data-action="sweep-inventory"]', panel);
    const sweepInventoryMinusOneCentButton = query('[data-action="sweep-inventory-minus-one-cent"]', panel);
    const pauseButton = query('[data-action="toggle-pause"]', panel);
    const scanButton = query('[data-action="scan"]', panel);
    const selectAllButton = query('[data-action="select-all"]', panel);
    const clearSelectionButton = query('[data-action="clear-selection"]', panel);
    const queryPricesButton = query('[data-action="query-prices"]', panel);
    const applyBulkPriceButton = query('[data-action="apply-bulk-price"]', panel);
    const bulkPriceInput = query('[data-role="bulk-price"]', panel);
    const mode = query('[data-role="mode"]', panel);
    const summary = query('[data-role="result-summary"]', panel);
    const inventoryReady = inventoryActionsAvailable();

    if (detected) {
      detected.textContent = String(state.counters.lastScanCount);
    }
    if (selected) {
      selected.textContent = String(state.selectedIds.size);
    }
    if (queue) {
      const total = state.queue.items.length;
      const current = state.queue.index >= 0 ? Math.min(state.queue.index + 1, total) : 0;
      queue.textContent = total > 0 ? `${current}/${total}` : "0/0";
    }
    if (startButton) {
      startButton.textContent = "确认价格并自动上架";
      startButton.disabled = !inventoryReady || state.queue.running || state.inventorySweepRunning;
    }
    if (sellAllLowestButton) {
      sellAllLowestButton.disabled = !inventoryReady || state.queue.running || state.inventorySweepRunning;
    }
    if (sweepInventoryButton) {
      sweepInventoryButton.disabled = !inventoryReady || state.queue.running || state.inventorySweepRunning;
    }
    if (sweepInventoryMinusOneCentButton) {
      sweepInventoryMinusOneCentButton.disabled = !inventoryReady || state.queue.running || state.inventorySweepRunning;
    }
    if (pauseButton) {
      pauseButton.textContent = state.paused ? "继续脚本" : "暂停脚本";
      pauseButton.disabled = !(state.queue.running || state.inventorySweepRunning);
    }
    if (scanButton) {
      scanButton.disabled = !inventoryReady || state.queue.running || state.inventorySweepRunning;
    }
    if (selectAllButton) {
      selectAllButton.disabled = !inventoryReady || state.queue.running || state.inventorySweepRunning;
    }
    if (clearSelectionButton) {
      clearSelectionButton.disabled = !inventoryReady || state.queue.running || state.inventorySweepRunning;
    }
    if (queryPricesButton) {
      queryPricesButton.disabled = !inventoryReady || state.queue.running || state.inventorySweepRunning;
    }
    if (applyBulkPriceButton) {
      applyBulkPriceButton.disabled = !inventoryReady || state.queue.running || state.inventorySweepRunning;
    }
    if (bulkPriceInput) {
      bulkPriceInput.disabled = !inventoryReady || state.queue.running || state.inventorySweepRunning;
    }
    if (mode) {
      mode.textContent = inventoryReady ? "库存页" : "非库存页";
    }
    if (summary) {
      summary.textContent = `成功 ${state.queue.results.success.length} | 失败 ${state.queue.results.failed.length}`;
    }
  }

  function rowMarkup(item) {
    const name = item.name || item.label;
    const price = item.priceValue || "";
    return `
      <div class="tm-row" id="${ROW_ID_PREFIX}${item.id}">
        <div class="tm-row-main">
          <div class="tm-row-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
          <div class="tm-row-status" data-tone="${escapeHtml(item.statusTone)}">${escapeHtml(item.status)}</div>
        </div>
        <div class="tm-row-controls">
          <input
            class="tm-price-input"
            data-role="row-price"
            data-item-id="${escapeHtml(item.id)}"
            type="text"
            inputmode="decimal"
            value="${escapeHtml(price)}"
            placeholder="0.00"
          />
          <button class="tm-mini-button" data-action="copy-lowest" data-item-id="${escapeHtml(item.id)}">使用最低价</button>
        </div>
      </div>
    `;
  }

  function renderRows() {
    const container = query(`#${PANEL_ID} [data-role="rows"]`);
    if (!container) {
      return;
    }
    const items = selectedItems();
    if (items.length === 0) {
      container.innerHTML = `<div class="tm-empty">${inventoryActionsAvailable() ? "请选择库存物品，生成待上架队列。" : "当前不是库存页，库存操作已禁用。"}</div>`;
      renderSummary();
      return;
    }
    container.innerHTML = items.map(rowMarkup).join("");
    renderSummary();
  }

  function injectStyles() {
    if (query(`#${STYLE_ID}`)) {
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: absolute;
        top: 16px;
        left: calc(100vw - 376px);
        width: 360px;
        height: min(780px, calc(100vh - 32px));
        min-width: ${PANEL_MIN_WIDTH}px;
        min-height: ${PANEL_MIN_HEIGHT}px;
        max-width: calc(100vw - 8px);
        max-height: calc(100vh - 8px);
        overflow: auto;
        resize: both;
        z-index: 999999;
        color: #e5eef8;
        background: rgba(13, 20, 29, 0.96);
        border: 1px solid rgba(115, 159, 209, 0.35);
        border-radius: 10px;
        box-shadow: 0 20px 48px rgba(0, 0, 0, 0.45);
        font: 13px/1.4 Arial, sans-serif;
      }

      #${PANEL_ID} * {
        box-sizing: border-box;
      }

      #${PANEL_ID} .tm-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        padding: 12px 14px 8px;
        border-bottom: 1px solid rgba(115, 159, 209, 0.18);
        user-select: none;
      }

      #${PANEL_ID} .tm-title-wrap {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        cursor: move;
      }

      #${PANEL_ID} .tm-title {
        font-size: 14px;
        font-weight: 700;
      }

      #${PANEL_ID} .tm-title-sub {
        font-size: 11px;
        color: #99acc2;
      }

      #${PANEL_ID} .tm-mode {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: none;
        font-size: 12px;
        color: #b7c7d9;
      }

      #${PANEL_ID} .tm-body {
        padding: 12px 14px 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        min-height: calc(100% - 56px);
      }

      #${PANEL_ID} .tm-summary {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
      }

      #${PANEL_ID} .tm-stat {
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(115, 159, 209, 0.14);
        border-radius: 8px;
        padding: 8px;
      }

      #${PANEL_ID} .tm-stat-label {
        display: block;
        font-size: 11px;
        color: #99acc2;
      }

      #${PANEL_ID} .tm-stat-value {
        display: block;
        margin-top: 3px;
        font-size: 16px;
        font-weight: 700;
      }

      #${PANEL_ID} [data-role="status"] {
        padding: 8px 10px;
        border-radius: 8px;
        background: rgba(74, 111, 165, 0.18);
        color: #dcecff;
      }

      #${PANEL_ID} [data-role="status"][data-tone="error"] {
        background: rgba(167, 60, 60, 0.24);
        color: #ffd8d8;
      }

      #${PANEL_ID} [data-role="status"][data-tone="success"] {
        background: rgba(64, 128, 92, 0.28);
        color: #d7ffe3;
      }

      #${PANEL_ID} .tm-actions,
      #${PANEL_ID} .tm-queue-actions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }

      #${PANEL_ID} button,
      #${PANEL_ID} input[type="text"] {
        min-height: 34px;
        border-radius: 7px;
      }

      #${PANEL_ID} button {
        border: 1px solid rgba(115, 159, 209, 0.25);
        background: rgba(74, 111, 165, 0.24);
        color: #eef5fb;
        cursor: pointer;
        padding: 8px 10px;
      }

      #${PANEL_ID} button:hover:enabled {
        background: rgba(91, 133, 195, 0.32);
      }

      #${PANEL_ID} button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }

      #${PANEL_ID} .tm-inline {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
      }

      #${PANEL_ID} input[type="text"] {
        width: 100%;
        border: 1px solid rgba(115, 159, 209, 0.22);
        background: rgba(8, 14, 22, 0.82);
        color: #f6fbff;
        padding: 8px 10px;
      }

      #${PANEL_ID} .tm-rows {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 320px;
        overflow: auto;
        padding-right: 2px;
      }

      #${PANEL_ID} .tm-row,
      #${PANEL_ID} .tm-empty,
      #${PANEL_ID} .tm-results,
      #${PANEL_ID} .tm-logs {
        background: rgba(255, 255, 255, 0.035);
        border: 1px solid rgba(115, 159, 209, 0.12);
        border-radius: 8px;
      }

      #${PANEL_ID} .tm-row {
        padding: 8px;
      }

      #${PANEL_ID} .tm-row-main {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        align-items: center;
      }

      #${PANEL_ID} .tm-row-name {
        min-width: 0;
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      #${PANEL_ID} .tm-row-status {
        flex: none;
        font-size: 11px;
        padding: 2px 6px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.09);
      }

      #${PANEL_ID} .tm-row-status[data-tone="error"] {
        background: rgba(167, 60, 60, 0.24);
        color: #ffd8d8;
      }

      #${PANEL_ID} .tm-row-status[data-tone="success"] {
        background: rgba(64, 128, 92, 0.28);
        color: #d7ffe3;
      }

      #${PANEL_ID} .tm-row-status[data-tone="warn"] {
        background: rgba(164, 120, 34, 0.24);
        color: #ffecb3;
      }

      #${PANEL_ID} .tm-row-controls {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        margin-top: 8px;
      }

      #${PANEL_ID} .tm-mini-button {
        min-width: 96px;
      }

      #${PANEL_ID} .tm-empty,
      #${PANEL_ID} .tm-results,
      #${PANEL_ID} .tm-logs {
        padding: 10px;
      }

      #${PANEL_ID} .tm-section-label {
        display: block;
        font-size: 11px;
        color: #99acc2;
        margin-bottom: 6px;
      }

      #${PANEL_ID} .tm-results {
        font-size: 12px;
        color: #d5e0ee;
      }

      #${PANEL_ID} .tm-logs {
        max-height: 220px;
        overflow: auto;
        font-family: Consolas, monospace;
        font-size: 11px;
      }

      #${PANEL_ID} .tm-log-line + .tm-log-line {
        margin-top: 4px;
      }

      .${HOLDER_MARKER} {
        position: relative !important;
      }

      .${CHECKBOX_CLASS} {
        position: absolute;
        top: 4px;
        left: 4px;
        z-index: 50;
        width: 22px;
        height: 22px;
        border-radius: 999px;
        background: rgba(8, 14, 22, 0.88);
        border: 1px solid rgba(115, 159, 209, 0.4);
        display: grid;
        place-items: center;
      }

      .${CHECKBOX_CLASS} input {
        width: 14px;
        height: 14px;
        margin: 0;
        cursor: pointer;
      }
    `;
    document.head.appendChild(style);
  }

  function buildPanel() {
    if (findPanel()) {
      return;
    }
    const panel = document.createElement("aside");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="tm-head">
          <div class="tm-title-wrap" data-role="drag-handle">
          <div class="tm-title">Steam 批量上架助手</div>
          <div class="tm-title-sub">全站同一面板，可拖动，可缩放</div>
        </div>
        <div class="tm-mode" data-role="mode">库存页</div>
      </div>
      <div class="tm-body">
        <div class="tm-summary">
          <div class="tm-stat">
            <span class="tm-stat-label">识别到</span>
            <span class="tm-stat-value" data-role="detected-count">0</span>
          </div>
          <div class="tm-stat">
            <span class="tm-stat-label">已选择</span>
            <span class="tm-stat-value" data-role="selected-count">0</span>
          </div>
          <div class="tm-stat">
            <span class="tm-stat-label">队列</span>
            <span class="tm-stat-value" data-role="queue-count">0/0</span>
          </div>
        </div>
        <div data-role="status">等待 Steam 库存渲染完成...</div>
        <div class="tm-actions">
          <button data-action="scan">扫描物品</button>
          <button data-action="select-all">全选当前页</button>
          <button data-action="clear-selection">清空选择</button>
          <button data-action="query-prices">查询最低价</button>
        </div>
        <div class="tm-inline">
          <input type="text" data-role="bulk-price" placeholder="统一售价（0.00）" />
          <button data-action="apply-bulk-price">应用售价</button>
        </div>
        <div class="tm-queue-actions">
          <button data-action="start-queue">确认价格并自动上架</button>
          <button data-action="sell-all-lowest">全页最低价一键上架</button>
          <button data-action="sweep-inventory">跨分页全库存清仓</button>
          <button data-action="sweep-inventory-minus-one-cent">全库存最低价-0.01上架</button>
          <button data-action="toggle-pause">暂停脚本</button>
        </div>
        <div>
          <span class="tm-section-label">已选物品</span>
          <div class="tm-rows" data-role="rows"></div>
        </div>
        <div class="tm-results">
          <span class="tm-section-label">本轮结果</span>
          <div data-role="result-summary">成功 0 | 跳过 0 | 失败 0</div>
        </div>
        <div class="tm-logs" data-role="logs"></div>
      </div>
    `;
    document.body.appendChild(panel);
    applyStoredPanelLayout(panel);
    bindPanelDragAndResize(panel);
    bindPanelEvents(panel);
    renderRows();
    renderLogs();
    renderSummary();
  }

  function bindPanelEvents(panel) {
    panel.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) {
        return;
      }
      const action = button.dataset.action;
      try {
        if (INVENTORY_ACTIONS.has(action) && !inventoryActionsAvailable()) {
          updateStatus("当前不是库存页，库存操作已禁用。", "error");
          return;
        }
        if (action === "scan") {
          scanInventory(true);
        } else if (action === "select-all") {
          setAllSelections(true);
        } else if (action === "clear-selection") {
          setAllSelections(false);
        } else if (action === "query-prices") {
          await queryLowestPrices();
        } else if (action === "apply-bulk-price") {
          applyBulkPrice();
        } else if (action === "start-queue") {
          await startQueue();
        } else if (action === "sell-all-lowest") {
          await sellAllVisibleAtLowestPrice();
        } else if (action === "sweep-inventory") {
          await sweepAllInventoryAtLowestPrice();
        } else if (action === "sweep-inventory-minus-one-cent") {
          await sweepAllInventoryAtLowestPriceMinusOneCent();
        } else if (action === "toggle-pause") {
          togglePause();
        } else if (action === "copy-lowest") {
          const item = state.items.get(button.dataset.itemId);
          if (item?.priceDisplay) {
            item.priceValue = normalizeEditablePrice(item.priceDisplay);
            item.status = "已使用最低价";
            item.statusTone = "success";
            renderRows();
            log(`已将最低价填入：${item.name || item.label}`);
          }
        }
      } catch (error) {
        log(`操作失败：${error.message}`);
        updateStatus(error.message, "error");
      }
    });

    panel.addEventListener("input", (event) => {
      const target = event.target;
      if (target.matches('[data-role="row-price"]')) {
        const item = state.items.get(target.dataset.itemId);
        if (!item) {
          return;
        }
        item.priceValue = target.value;
        item.status = target.value ? "已编辑价格" : "待填写价格";
        item.statusTone = target.value ? "muted" : "warn";
        renderSummary();
      }
    });
  }

  function ensureCheckbox(holder, item) {
    holder.classList.add(HOLDER_MARKER);
    let shell = query(`.${CHECKBOX_CLASS}`, holder);
    if (!shell) {
      shell = document.createElement("label");
      shell.className = CHECKBOX_CLASS;
      shell.title = "选择加入批量上架";
      shell.innerHTML = `<input type="checkbox" />`;
      shell.addEventListener("click", (event) => event.stopPropagation());
      shell.addEventListener("mousedown", (event) => event.stopPropagation());
      holder.appendChild(shell);
    }

    const checkbox = query("input", shell);
    checkbox.checked = state.selectedIds.has(item.id);
    checkbox.onchange = (event) => {
      event.stopPropagation();
      if (checkbox.checked) {
        state.selectedIds.add(item.id);
        item.status = item.priceDisplay ? "可上架" : "已选择";
        item.statusTone = item.priceDisplay ? "success" : "muted";
        log(`已选择物品：${item.name || item.label}`, { itemId: item.id });
      } else {
        state.selectedIds.delete(item.id);
        log(`已取消选择：${item.name || item.label}`, { itemId: item.id });
      }
      renderRows();
      updateStatus(`已选择 ${state.selectedIds.size} 件物品。`, "info");
    };
    item.checkbox = checkbox;
  }

  function pruneMissingItems(liveIds) {
    for (const id of Array.from(state.items.keys())) {
      if (liveIds.has(id)) {
        continue;
      }
      state.items.delete(id);
      state.selectedIds.delete(id);
    }
  }

  function clearInventoryState() {
    state.items.clear();
    state.selectedIds.clear();
    state.counters.lastScanCount = 0;
    renderRows();
    renderSummary();
  }

  function scanInventory(forceStatus) {
    if (!isInventoryPage()) {
      clearInventoryState();
      if (forceStatus) {
        updateStatus("当前不是库存页，库存操作已禁用。", "info");
      }
      return;
    }
    const holders = currentItemHolders();
    const liveIds = new Set();
    holders.forEach((holder, index) => {
      const item = buildItemRecord(holder, index);
      liveIds.add(item.id);
      ensureCheckbox(holder, item);
    });
    pruneMissingItems(liveIds);
    state.counters.lastScanCount = holders.length;
    renderRows();
    renderSummary();

    if (forceStatus) {
      const message =
        holders.length > 0
          ? `当前页识别到 ${holders.length} 个可见物品。`
          : "暂未识别到库存物品，请打开库存页并等待 Steam 渲染完成。";
      updateStatus(message, holders.length > 0 ? "success" : "error");
      log(message);
    }
  }

  function scheduleScan() {
    window.clearTimeout(state.scanTimer);
    state.scanTimer = window.setTimeout(() => scanInventory(false), RESCAN_DELAY_MS);
  }

  function setAllSelections(checked) {
    for (const item of state.items.values()) {
      if (item.checkbox) {
        item.checkbox.checked = checked;
      }
      if (checked) {
        state.selectedIds.add(item.id);
        item.status = item.priceDisplay ? "可上架" : "已选择";
        item.statusTone = item.priceDisplay ? "success" : "muted";
      } else {
        state.selectedIds.delete(item.id);
      }
    }
    renderRows();
    updateStatus(checked ? "已全选当前页可见物品。" : "已清空全部选择。", "info");
    log(checked ? "执行全选当前页。" : "执行清空选择。", { selectedCount: state.selectedIds.size });
  }

  function currentInfoPanel() {
    const selectors = ["#iteminfo0", "#iteminfo1", ".inventory_iteminfo"];
    for (const selector of selectors) {
      const node = query(selector);
      if (node && isVisible(node)) {
        return node;
      }
    }
    return null;
  }

  function currentPageNumber() {
    const candidates = [
      query("#pagecontrol_cur"),
      query(".pagecontrol_element.pagecontrol_cur"),
      query(".inventory_pagecontrols .pagecontrol_cur"),
    ].filter(Boolean);
    for (const node of candidates) {
      const match = visibleText(node).match(/\d+/);
      if (match) {
        return Number(match[0]);
      }
    }
    return null;
  }

  function totalPageNumber() {
    const candidates = [
      query("#pagecontrol_max"),
      query(".pagecontrol_element.pagecontrol_max"),
      query(".inventory_pagecontrols .pagecontrol_max"),
    ].filter(Boolean);
    for (const node of candidates) {
      const match = visibleText(node).match(/\d+/);
      if (match) {
        return Number(match[0]);
      }
    }
    return null;
  }

  function nextPageButton() {
    return (
      query("#pagebtn_next") ||
      query(".inventory_pagecontrols #pagebtn_next") ||
      query(".pagebtn_next")
    );
  }

  function previousPageButton() {
    return (
      query("#pagebtn_previous") ||
      query(".inventory_pagecontrols #pagebtn_previous") ||
      query(".pagebtn_previous")
    );
  }

  function pageButtonDisabled(button) {
    if (!button) {
      return true;
    }
    return (
      buttonDisabled(button) ||
      String(button.className || "").includes("disabled") ||
      button.getAttribute("aria-disabled") === "true"
    );
  }

  function currentVisiblePageSignature() {
    const holders = currentItemHolders();
    const signature = holders
      .slice(0, 5)
      .map((holder) => {
        const image = query("img", holder);
        return image?.src || holder.id || holder.dataset.tmBatchId || "";
      })
      .join("|");
    return `${currentPageNumber() || "?"}:${holders.length}:${signature}`;
  }

  function visibleText(node) {
    return (node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function togglePause() {
    if (!(state.queue.running || state.inventorySweepRunning)) {
      updateStatus("当前没有正在运行的任务。", "error");
      return;
    }
    state.paused = !state.paused;
    renderSummary();
    if (state.paused) {
      updateStatus("脚本已暂停，当前步骤结束后将停止推进。", "info");
      log("脚本已暂停。", {
        queueRunning: state.queue.running,
        inventorySweepRunning: state.inventorySweepRunning,
      });
    } else {
      updateStatus("脚本已恢复。", "success");
      log("脚本已恢复。", {
        queueRunning: state.queue.running,
        inventorySweepRunning: state.inventorySweepRunning,
      });
    }
  }

  async function waitWhilePaused(context) {
    if (!state.paused) {
      return;
    }
    updateStatus(`脚本已暂停：${context}`, "info");
    log(`暂停等待：${context}`);
    while (state.paused) {
      await sleep(250);
    }
    updateStatus(`继续执行：${context}`, "success");
    log(`恢复执行：${context}`);
  }

  function marketActionContainer() {
    const selectors = [
      "#iteminfo0_item_market_actions",
      "#iteminfo1_item_market_actions",
      ".item_market_actions",
      ".item_desc_content .item_market_actions",
    ];
    for (const selector of selectors) {
      const node = query(selector);
      if (node && isVisible(node)) {
        return node;
      }
    }
    return null;
  }

  function parseListingInfoFromPanel(panel) {
    const marketLink =
      query('a[href*="/market/listings/"]', panel) ||
      query('a[href*="/market/listings/"]', marketActionContainer() || panel);
    if (!marketLink) {
      return null;
    }

    const match = marketLink.href.match(/\/market\/listings\/(\d+)\/(.+)$/);
    if (!match) {
      return null;
    }

    const name =
      query(".item_desc_name", panel)?.textContent?.trim() ||
      query(".hover_item_name", panel)?.textContent?.trim() ||
      "";

    return {
      appid: match[1],
      marketHashName: decodeURIComponent(match[2]),
      marketUrl: marketLink.href,
      name,
    };
  }

  function clickInventoryItem(item) {
    const target =
      query("a.inventory_item_link", item.element) ||
      query("a", item.element) ||
      item.element;
    clickElement(target);
  }

  async function waitFor(condition, timeoutMs, label) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const result = condition();
      if (result) {
        return result;
      }
      await sleep(120);
    }
    throw new Error(`等待${label}超时。`);
  }

  async function inspectItemDetails(item) {
    log(`开始读取物品详情：${item.label}`, { itemId: item.id });
    clickInventoryItem(item);
    const detail = await waitFor(() => {
      const panel = currentInfoPanel();
      if (!panel) {
        return null;
      }
      const parsed = parseListingInfoFromPanel(panel);
      if (!parsed) {
        return null;
      }
      return { panel, parsed };
    }, DETAILS_WAIT_MS, "物品详情");

    item.name = detail.parsed.name || item.label;
    if (!item.name && detail.parsed.marketHashName) {
      item.name = detail.parsed.marketHashName;
    }
    item.appid = detail.parsed.appid;
    item.marketHashName = detail.parsed.marketHashName;
    item.marketUrl = detail.parsed.marketUrl;
    log(`已读取物品详情：${item.name || item.label}`, {
      itemId: item.id,
      appid: item.appid,
      marketHashName: item.marketHashName,
    });
    return item;
  }

  async function fetchLowestPrice(item) {
    if (!item.appid || !item.marketHashName) {
      await inspectItemDetails(item);
    }

    const endpoint = new URL("https://steamcommunity.com/market/priceoverview/");
    endpoint.searchParams.set("country", getCountryCode());
    endpoint.searchParams.set("currency", String(getCurrencyCode()));
    endpoint.searchParams.set("appid", item.appid);
    endpoint.searchParams.set("market_hash_name", item.marketHashName);
    log(`发起最低价请求：${item.name || item.label}`, {
      itemId: item.id,
      url: endpoint.toString(),
    });

    const response = await window.fetch(endpoint.toString(), {
      credentials: "include",
    });
    if (!response.ok) {
      throw new Error(`价格请求失败，HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (!payload?.success) {
      throw new Error("Steam priceoverview 返回失败。");
    }

    const display = payload.lowest_price;
    if (!display) {
      log(`最低价缺失：${item.name || item.label}`, {
        itemId: item.id,
        payload: {
          lowest_price: payload.lowest_price ?? null,
          median_price: payload.median_price ?? null,
          volume: payload.volume ?? null,
          success: payload.success ?? null,
        },
      });
      throw new Error("Steam 没有返回 lowest_price，已拒绝使用 median_price。");
    }

    const normalized = normalizeEditablePrice(display);
    if (!normalized) {
      log(`最低价解析失败：${item.name || item.label}`, {
        itemId: item.id,
        rawLowestPrice: display,
        payload: {
          lowest_price: payload.lowest_price ?? null,
          median_price: payload.median_price ?? null,
          volume: payload.volume ?? null,
        },
      });
      throw new Error(`lowest_price 解析失败：${display}`);
    }

    item.priceDisplay = display;
    item.priceValue = normalized;
    item.priceSource = "lowest_price";
    item.status = "最低价已加载";
    item.statusTone = "success";
    item.lastError = "";
    log(`最低价解析成功：${item.name || item.label}`, {
      itemId: item.id,
      rawLowestPrice: payload.lowest_price ?? null,
      rawMedianPrice: payload.median_price ?? null,
      volume: payload.volume ?? null,
      selectedSource: "lowest_price",
      normalizedPrice: normalized,
    });
    return payload;
  }

  async function queryLowestPrices(items = selectedItems(), source = "手动查价") {
    if (!inventoryActionsAvailable()) {
      updateStatus("当前不是库存页，无法查价。", "error");
      return;
    }
    if (items.length === 0) {
      updateStatus("请先至少选择一件物品，再执行查价。", "error");
      return;
    }

    updateStatus(`正在为 ${items.length} 件物品查询最低价...`, "info");
    log(`开始批量查最低价：${source}`, {
      count: items.length,
      itemIds: items.map((item) => item.id),
    });
    for (const item of items) {
      await waitWhilePaused(`等待继续查价：${item.name || item.label || item.id}`);
      item.status = "查询中";
      item.statusTone = "warn";
      renderRows();
      try {
        const payload = await fetchLowestPrice(item);
        log(`最低价 ${item.name || item.label}：${payload.lowest_price}`, {
          itemId: item.id,
          selectedSource: item.priceSource,
          normalizedPrice: item.priceValue,
        });
      } catch (error) {
        item.status = "查价失败";
        item.statusTone = "error";
        item.lastError = error.message;
        item.priceSource = "";
        log(`查价失败 ${item.label}：${error.message}`, {
          itemId: item.id,
          appid: item.appid,
          marketHashName: item.marketHashName,
        });
      }
      renderRows();
      await waitWhilePaused(`查价完成后暂停：${item.name || item.label || item.id}`);
      await sleep(PRICE_DELAY_MS);
    }

    updateStatus("查价完成，请检查或修改价格后再开始上架。", "success");
    log(`批量查最低价完成：${source}`, {
      count: items.length,
      successCount: items.filter((item) => item.status === "最低价已加载").length,
      failedCount: items.filter((item) => item.status === "查价失败").length,
    });
  }

  function applyBulkPrice() {
    const input = query(`#${PANEL_ID} [data-role="bulk-price"]`);
    if (!input) {
      return;
    }

    const normalized = normalizeEditablePrice(input.value);
    if (!normalized) {
      updateStatus("请输入有效的统一售价后再应用。", "error");
      return;
    }

    const items = selectedItems();
    items.forEach((item) => {
      item.priceValue = normalized;
      item.status = "已设置自定义价";
      item.statusTone = "success";
    });
    renderRows();
    updateStatus(`已将 ${normalized} 应用到 ${items.length} 件已选物品。`, "success");
  }

  function formatPriceNumber(value) {
    if (!Number.isFinite(value) || value <= 0) {
      return "";
    }
    return value.toFixed(2);
  }

  function applyPriceOffsetToItems(items, offset, source) {
    let adjustedCount = 0;
    const adjustedItems = [];
    const failedItems = [];

    items.forEach((item) => {
      const basePrice = parsePriceNumber(item.priceValue || item.priceDisplay);
      if (basePrice === null) {
        item.status = "价格调整失败";
        item.statusTone = "error";
        item.lastError = "缺少可计算的基准价格";
        failedItems.push(item);
        return;
      }

      const adjustedPrice = Math.max(0.01, Math.round((basePrice + offset) * 100) / 100);
      const normalized = formatPriceNumber(adjustedPrice);
      if (!normalized) {
        item.status = "价格调整失败";
        item.statusTone = "error";
        item.lastError = `价格调整后无效：${adjustedPrice}`;
        failedItems.push(item);
        return;
      }

      item.priceValue = normalized;
      item.status = source;
      item.statusTone = "success";
      adjustedCount += 1;
      adjustedItems.push({
        id: item.id,
        name: item.name || item.label,
        basePrice: formatPriceNumber(basePrice),
        adjustedPrice: normalized,
      });
    });

    renderRows();
    log(`价格偏移处理完成：${source}`, {
      offset,
      adjustedCount,
      failedCount: failedItems.length,
      adjustedItems,
      failedItems: failedItems.map((item) => ({
        id: item.id,
        name: item.name || item.label,
        lastError: item.lastError,
      })),
    });

    return { adjustedCount, adjustedItems, failedItems };
  }

  function validateQueueItems(items) {
    const invalidItems = [];
    items.forEach((item) => {
      const normalized = normalizeEditablePrice(item.priceValue);
      if (!normalized) {
        item.status = "价格无效";
        item.statusTone = "error";
        invalidItems.push(item);
      } else {
        item.priceValue = normalized;
      }
    });
    renderRows();
    return invalidItems;
  }

  function resetQueueState(items = []) {
    state.queue.running = items.length > 0;
    state.queue.items = items;
    state.queue.index = items.length > 0 ? 0 : -1;
    state.queue.results = {
      success: [],
      failed: [],
    };
    renderSummary();
  }

  function currentQueueItem() {
    const { index, items } = state.queue;
    if (index < 0 || index >= items.length) {
      return null;
    }
    return items[index];
  }

  function collectSellButtonDiagnostics(panel) {
    const actionRoot = marketActionContainer() || panel || currentInfoPanel();
    const buttons = actionRoot ? queryAll("button, a", actionRoot).filter(isVisible).slice(0, 8) : [];
    const greenButtons = buttons.filter((node) => {
      const accent = node.getAttribute("data-accent-color");
      const className = node.className || "";
      return accent === "green" || String(className).includes("btn_green");
    });
    return {
      actionRootFound: Boolean(actionRoot),
      buttonCount: buttons.length,
      greenButtonCount: greenButtons.length,
      buttons: buttons.map((node) => ({
        tag: node.tagName,
        text: visibleText(node),
        id: node.id || "",
        className: String(node.className || ""),
        accent: node.getAttribute("data-accent-color") || "",
        href: node.getAttribute("href") || "",
      })),
    };
  }

  function findSellButton(panel = currentInfoPanel()) {
    const roots = [panel, marketActionContainer()].filter(Boolean);
    const candidates = [];
    for (const root of roots) {
      candidates.push(
        ...queryAll('button[data-accent-color="green"], button, a', root).filter((node) => {
          if (!isVisible(node)) {
            return false;
          }
          const text = visibleText(node);
          const href = node.getAttribute("href") || "";
          const accent = node.getAttribute("data-accent-color") || "";
          const className = String(node.className || "");
          const looksGreen = accent === "green" || className.includes("btn_green");
          const looksSellText = ["Sell", "出售", "Sell Items", "Sell Item"].includes(text);
          return looksSellText || /SellCurrentSelection/i.test(href) || looksGreen;
        }),
      );
    }

    const normalized = candidates.filter((node, index) => candidates.indexOf(node) === index);
    const exactText = normalized.find((node) => ["Sell", "出售"].includes(visibleText(node)));
    if (exactText) {
      return exactText;
    }
    const sellHref = normalized.find((node) => /SellCurrentSelection/i.test(node.getAttribute("href") || ""));
    if (sellHref) {
      return sellHref;
    }
    const green = normalized.find((node) => {
      const accent = node.getAttribute("data-accent-color") || "";
      const className = String(node.className || "");
      return accent === "green" || className.includes("btn_green");
    });
    return green || null;
  }

  function visibleSellDialog() {
    const selectors = [
      "#market_sell_dialog",
      ".newmodal_content #market_sell_dialog",
      "#market_sell_dialog_ctn",
    ];
    for (const selector of selectors) {
      const node = query(selector);
      if (node && isVisible(node)) {
        return node;
      }
    }
    return null;
  }

  function visibleSellError(dialog = visibleSellDialog() || document) {
    const node =
      query("#market_sell_dialog_error", dialog) ||
      query(".newmodal_error", dialog) ||
      query(".error", dialog);
    if (!node || !isVisible(node)) {
      return "";
    }
    return node.textContent?.trim() || "";
  }

  async function openSellDialog(item) {
    log(`尝试打开出售弹窗：${item.name || item.label}`, { itemId: item.id });
    clickInventoryItem(item);
    const sellButton = await waitFor(() => {
      const panel = currentInfoPanel();
      return findSellButton(panel);
    }, DETAILS_WAIT_MS, "出售按钮");
    log(`已找到出售按钮：${item.name || item.label}`, {
      itemId: item.id,
      text: visibleText(sellButton),
      id: sellButton.id || "",
      className: String(sellButton.className || ""),
      accent: sellButton.getAttribute("data-accent-color") || "",
    });
    clickElement(sellButton);
    return waitFor(() => visibleSellDialog(), DIALOG_WAIT_MS, "出售弹窗");
  }

  function sellDialogInputs(dialog) {
    const selectors = [
      "#market_sell_buyercurrency_input",
      "#market_sell_currency_input",
      "#market_sell_price_input",
      'input[name="price"]',
    ];
    return selectors
      .map((selector) => query(selector, dialog))
      .filter((node) => node && isVisible(node));
  }

  async function fillSellDialogPrice(item) {
    const dialog = await waitFor(() => visibleSellDialog(), DIALOG_WAIT_MS, "出售弹窗");
    const inputs = sellDialogInputs(dialog);
    if (inputs.length === 0) {
      throw new Error("没有找到可见的 Steam 出售价输入框。");
    }

    const price = normalizeEditablePrice(item.priceValue);
    if (!price) {
      throw new Error(`物品 ${item.name || item.label} 缺少有效价格。`);
    }

    log(`开始填入价格：${item.name || item.label}`, {
      itemId: item.id,
      inputCount: inputs.length,
      price,
    });
    await simulateTyping(inputs[0], price);
    item.status = "已填入价格";
    item.statusTone = "warn";
    renderRows();
    log(`价格填写完成：${item.name || item.label}`, { itemId: item.id, price });
  }

  async function submitSellDialog(item) {
    const dialog = await waitFor(() => visibleSellDialog(), DIALOG_WAIT_MS, "出售弹窗");
    log(`准备提交上架：${item.name || item.label}`, { itemId: item.id });

    const ssaCheckbox =
      query("#market_sell_dialog_accept_ssa", dialog) ||
      query("#market_sell_dialog_accept_ssa", document);
    if (ssaCheckbox && !ssaCheckbox.checked) {
      log(`勾选协议：${item.name || item.label}`, { itemId: item.id });
      clickElement(ssaCheckbox);
      await sleep(180);
    }

    const acceptButton =
      query("#market_sell_dialog_accept", dialog) ||
      query("#market_sell_dialog_accept", document);
    if (!acceptButton) {
      throw new Error("没有找到“同意价格”按钮。");
    }

    await waitFor(() => !buttonDisabled(acceptButton), DIALOG_WAIT_MS, "同意价格按钮可点击");
    log(`点击同意价格：${item.name || item.label}`, { itemId: item.id });
    clickElement(acceptButton);
    await sleep(SUBMIT_WAIT_MS);

    const okButton =
      query("#market_sell_dialog_ok", dialog) ||
      query("#market_sell_dialog_ok", document);
    if (okButton && !buttonDisabled(okButton)) {
      log(`点击最终确认：${item.name || item.label}`, { itemId: item.id });
      clickElement(okButton);
      await sleep(SUBMIT_WAIT_MS);
    }

    const result = await waitFor(() => {
      const latestDialog = visibleSellDialog();
      const errorText = visibleSellError(latestDialog || document);
      if (errorText) {
        return { ok: false, error: errorText };
      }
      if (!latestDialog) {
        return { ok: true };
      }
      return null;
    }, DIALOG_WAIT_MS, "上架结果");

    if (!result.ok) {
      throw new Error(result.error);
    }

    item.status = "已提交上架";
    item.statusTone = "success";
    log(`上架提交成功：${item.name || item.label}`, { itemId: item.id, price: item.priceValue });
  }

  function dismissSellDialogIfOpen() {
    const dialog = visibleSellDialog();
    if (!dialog) {
      return;
    }
    const closeButton =
      query(".newmodal_close", document) ||
      query(".btn_grey_white_innerfade.btn_medium", dialog) ||
      query('button[aria-label="Close"]', dialog);
    clickElement(closeButton);
  }

  async function processQueueItem() {
    await waitWhilePaused("等待继续上架队列");
    const item = currentQueueItem();
    if (!item) {
      state.queue.running = false;
      state.paused = false;
      updateStatus(
        `队列完成。成功 ${state.queue.results.success.length}，失败 ${state.queue.results.failed.length}。`,
        "success",
      );
      renderSummary();
      log("队列执行完成。");
      return;
    }

    item.status = "准备中";
    item.statusTone = "warn";
    renderRows();
    updateStatus(
      `正在处理 ${item.name || item.label}（${state.queue.index + 1}/${state.queue.items.length}）...`,
      "info",
    );
    log(`开始处理队列物品`, {
      itemId: item.id,
      label: item.label,
      queueIndex: state.queue.index + 1,
      queueTotal: state.queue.items.length,
      currentPrice: item.priceValue,
    });

    try {
      await waitWhilePaused(`准备读取 ${item.name || item.label} 的详情`);
      await inspectItemDetails(item);
      await waitWhilePaused(`准备打开 ${item.name || item.label} 的出售弹窗`);
      await openSellDialog(item);
      await waitWhilePaused(`准备填写 ${item.name || item.label} 的价格`);
      await fillSellDialogPrice(item);
      updateStatus(`正在自动勾选协议并提交 ${item.name || item.label}...`, "info");
      await waitWhilePaused(`准备提交 ${item.name || item.label} 的上架`);
      await submitSellDialog(item);
      state.queue.results.success.push({
        id: item.id,
        name: item.name || item.label,
        price: item.priceValue,
      });
      state.queue.index += 1;
      renderRows();
      renderSummary();
      log(`已自动提交上架：${item.name || item.label}，价格 ${item.priceValue}`);
      await sleep(250);
      await processQueueItem();
    } catch (error) {
      item.status = "队列失败";
      item.statusTone = "error";
      item.lastError = error.message;
      const diagnostics = collectSellButtonDiagnostics(currentInfoPanel());
      state.queue.results.failed.push({
        id: item.id,
        name: item.name || item.label,
        reason: error.message,
      });
      dismissSellDialogIfOpen();
      state.queue.index += 1;
      renderRows();
      renderSummary();
      log(`队列失败 ${item.label}：${error.message}`, {
        itemId: item.id,
        name: item.name || item.label,
        appid: item.appid,
        marketHashName: item.marketHashName,
        price: item.priceValue,
        diagnostics,
      });
      updateStatus(`失败：${item.name || item.label}，原因：${error.message}`, "error");
      await sleep(250);
      await processQueueItem();
    }
  }

  async function startQueue() {
    if (!inventoryActionsAvailable()) {
      updateStatus("当前不是库存页，无法启动上架队列。", "error");
      return;
    }
    const items = selectedItems();
    if (items.length === 0) {
      updateStatus("请先选择至少一件物品，再开始队列。", "error");
      return;
    }

    const invalidItems = validateQueueItems(items);
    if (invalidItems.length > 0) {
      updateStatus("请先修正无效价格，再开始队列。", "error");
      return;
    }

    state.paused = false;
    resetQueueState(items.slice());
    updateStatus(`已开始 ${items.length} 件物品的自动上架流程。`, "info");
    log(`队列启动：共 ${items.length} 件物品。`, {
      itemIds: items.map((item) => item.id),
      prices: items.map((item) => ({ id: item.id, price: item.priceValue })),
    });
    await processQueueItem();
  }

  async function gotoNextInventoryPage() {
    await waitWhilePaused("等待继续翻到下一页库存");
    const button = nextPageButton();
    if (!button || pageButtonDisabled(button)) {
      return false;
    }

    const previousPage = currentPageNumber();
    const previousSignature = currentVisiblePageSignature();
    log("准备切换到下一页库存。", {
      previousPage,
      previousSignature,
    });
    clickElement(button);
    await waitFor(() => {
      const nextPage = currentPageNumber();
      const nextSignature = currentVisiblePageSignature();
      const pageChanged =
        previousPage !== null && nextPage !== null && nextPage !== previousPage;
      const signatureChanged = nextSignature !== previousSignature;
      return pageChanged || signatureChanged;
    }, PAGE_NAV_WAIT_MS, "库存下一页");
    await sleep(PAGE_SETTLE_MS);
    scanInventory(true);
    log("已切换到下一页库存。", {
      currentPage: currentPageNumber(),
      totalPage: totalPageNumber(),
      signature: currentVisiblePageSignature(),
    });
    return true;
  }

  async function gotoFirstInventoryPage() {
    let guard = 0;
    while (guard < 100) {
      await waitWhilePaused("等待继续返回库存第一页");
      const currentPage = currentPageNumber();
      const prevButton = previousPageButton();
      if ((currentPage !== null && currentPage <= 1) || !prevButton || pageButtonDisabled(prevButton)) {
        scanInventory(true);
        return;
      }
      const previousSignature = currentVisiblePageSignature();
      clickElement(prevButton);
      await waitFor(() => currentVisiblePageSignature() !== previousSignature, PAGE_NAV_WAIT_MS, "返回第一页");
      await sleep(PAGE_SETTLE_MS);
      guard += 1;
    }
    throw new Error("返回库存第一页超时。");
  }

  async function sellAllVisibleAtLowestPrice() {
    if (state.queue.running || state.inventorySweepRunning || !inventoryActionsAvailable()) {
      updateStatus("当前已有正在执行的队列，请稍后再试。", "error");
      return;
    }

    scanInventory(true);
    const visibleItems = Array.from(state.items.values()).filter((item) => isVisible(item.element));
    if (visibleItems.length === 0) {
      updateStatus("当前页没有可处理的可见库存物品。", "error");
      log("全页最低价一键上架终止：当前页没有可见物品。");
      return;
    }

    log("开始执行全页最低价一键上架。", {
      visibleCount: visibleItems.length,
      visibleItemIds: visibleItems.map((item) => item.id),
    });
    updateStatus(`正在准备当前页 ${visibleItems.length} 件物品的一键最低价上架...`, "info");

    setAllSelections(true);
    const items = selectedItems();
    await queryLowestPrices(items, "全页最低价一键上架");
    await waitWhilePaused("等待继续执行全页最低价上架");

    const failedItems = items.filter((item) => item.status === "查价失败");
    if (failedItems.length > 0) {
      updateStatus(`有 ${failedItems.length} 件物品查价失败，已跳过这些物品，仅上架其余项目。`, "error");
      log("全页最低价一键上架：存在查价失败项目，将仅继续处理成功项。", {
        failedItems: failedItems.map((item) => ({
          id: item.id,
          name: item.name || item.label,
          lastError: item.lastError,
        })),
      });
      failedItems.forEach((item) => {
        state.selectedIds.delete(item.id);
        if (item.checkbox) {
          item.checkbox.checked = false;
        }
      });
      renderRows();
      renderSummary();
    }

    if (selectedItems().length === 0) {
      updateStatus("查价后没有可继续上架的物品。", "error");
      log("全页最低价一键上架终止：没有查价成功且可上架的物品。");
      return;
    }

    log("全页最低价一键上架：开始进入自动上架队列。", {
      queueCount: selectedItems().length,
      queueItems: selectedItems().map((item) => ({
        id: item.id,
        name: item.name || item.label,
        price: item.priceValue,
      })),
    });
    await startQueue();
  }

  async function sweepAllInventoryAtLowestPrice() {
    if (state.queue.running || state.inventorySweepRunning || !inventoryActionsAvailable()) {
      updateStatus("当前已有正在执行的任务，请稍后再试。", "error");
      return;
    }

    state.inventorySweepRunning = true;
    renderSummary();
    try {
      updateStatus("正在回到第一页并准备跨分页全库存清仓...", "info");
      log("开始执行跨分页全库存清仓。");
      await gotoFirstInventoryPage();

      let pageCounter = 0;
      let totalAttempted = 0;
      let totalQueued = 0;
      let totalPriceFailed = 0;

      while (pageCounter < 500) {
        await waitWhilePaused("等待继续跨分页清仓");
        pageCounter += 1;
        scanInventory(true);
        const currentPage = currentPageNumber();
        const totalPages = totalPageNumber();
        const visibleItems = Array.from(state.items.values()).filter((item) => isVisible(item.element));

        log("开始处理库存分页。", {
          currentPage,
          totalPages,
          visibleCount: visibleItems.length,
          signature: currentVisiblePageSignature(),
        });

        if (visibleItems.length === 0) {
          log("当前分页没有可见物品，准备尝试下一页。", {
            currentPage,
            totalPages,
          });
        } else {
          totalAttempted += visibleItems.length;
          setAllSelections(true);
          const items = selectedItems();
          await queryLowestPrices(items, `跨分页全库存清仓-第${currentPage || pageCounter}页`);

          const failedItems = items.filter((item) => item.status === "查价失败");
          totalPriceFailed += failedItems.length;
          if (failedItems.length > 0) {
            log("当前分页存在查价失败项目，已从待上架列表中剔除。", {
              currentPage,
              failedItems: failedItems.map((item) => ({
                id: item.id,
                name: item.name || item.label,
                lastError: item.lastError,
              })),
            });
            failedItems.forEach((item) => {
              state.selectedIds.delete(item.id);
              if (item.checkbox) {
                item.checkbox.checked = false;
              }
            });
            renderRows();
            renderSummary();
          }

          const queueItems = selectedItems();
          if (queueItems.length > 0) {
            totalQueued += queueItems.length;
            updateStatus(
              `正在清仓第 ${currentPage || pageCounter}${totalPages ? `/${totalPages}` : ""} 页，共 ${queueItems.length} 件物品...`,
              "info",
            );
            log("当前分页开始进入自动上架队列。", {
              currentPage,
              queueCount: queueItems.length,
              queueItems: queueItems.map((item) => ({
                id: item.id,
                name: item.name || item.label,
                price: item.priceValue,
              })),
            });
            await startQueue();
          } else {
            log("当前分页没有可继续上架的物品。", {
              currentPage,
            });
          }
        }

        const moved = await gotoNextInventoryPage();
        if (!moved) {
          break;
        }
      }

      updateStatus(
        `跨分页全库存清仓完成。共尝试 ${totalAttempted} 件，送入队列 ${totalQueued} 件，查价失败 ${totalPriceFailed} 件。`,
        "success",
      );
      log("跨分页全库存清仓完成。", {
        totalAttempted,
        totalQueued,
        totalPriceFailed,
        endPage: currentPageNumber(),
      });
    } catch (error) {
      updateStatus(`跨分页全库存清仓失败：${error.message}`, "error");
      log(`跨分页全库存清仓失败：${error.message}`);
    } finally {
      state.inventorySweepRunning = false;
      state.paused = false;
      renderSummary();
    }
  }

  async function sweepAllInventoryAtLowestPriceMinusOneCent() {
    if (state.queue.running || state.inventorySweepRunning || !inventoryActionsAvailable()) {
      updateStatus("当前已有正在执行的任务，请稍后再试。", "error");
      return;
    }

    state.inventorySweepRunning = true;
    renderSummary();
    try {
      updateStatus("正在回到第一页并准备按最低价-0.01清仓...", "info");
      log("开始执行全库存最低价-0.01上架。");
      await gotoFirstInventoryPage();

      let pageCounter = 0;
      let totalAttempted = 0;
      let totalQueued = 0;
      let totalPriceFailed = 0;
      let totalAdjusted = 0;

      while (pageCounter < 500) {
        await waitWhilePaused("等待继续跨分页最低价-0.01清仓");
        pageCounter += 1;
        scanInventory(true);
        const currentPage = currentPageNumber();
        const totalPages = totalPageNumber();
        const visibleItems = Array.from(state.items.values()).filter((item) => isVisible(item.element));

        log("开始处理库存分页（最低价-0.01）。", {
          currentPage,
          totalPages,
          visibleCount: visibleItems.length,
          signature: currentVisiblePageSignature(),
        });

        if (visibleItems.length > 0) {
          totalAttempted += visibleItems.length;
          setAllSelections(true);
          const items = selectedItems();
          await queryLowestPrices(items, `全库存最低价-0.01上架-第${currentPage || pageCounter}页`);

          const failedItems = items.filter((item) => item.status === "查价失败");
          totalPriceFailed += failedItems.length;
          if (failedItems.length > 0) {
            failedItems.forEach((item) => {
              state.selectedIds.delete(item.id);
              if (item.checkbox) {
                item.checkbox.checked = false;
              }
            });
            renderRows();
            renderSummary();
          }

          const queueItems = selectedItems();
          if (queueItems.length > 0) {
            const adjustment = applyPriceOffsetToItems(queueItems, -0.01, "最低价-0.01");
            totalAdjusted += adjustment.adjustedCount;
            const validQueueItems = selectedItems().filter((item) => item.status !== "价格调整失败");
            if (validQueueItems.length > 0) {
              totalQueued += validQueueItems.length;
              updateStatus(
                `正在按最低价-0.01清仓第 ${currentPage || pageCounter}${totalPages ? `/${totalPages}` : ""} 页，共 ${validQueueItems.length} 件物品...`,
                "info",
              );
              log("当前分页开始进入自动上架队列（最低价-0.01）。", {
                currentPage,
                queueCount: validQueueItems.length,
                queueItems: validQueueItems.map((item) => ({
                  id: item.id,
                  name: item.name || item.label,
                  price: item.priceValue,
                })),
              });
              await startQueue();
            } else {
              log("当前分页没有价格调整后可继续上架的物品。", { currentPage });
            }
          }
        }

        const moved = await gotoNextInventoryPage();
        if (!moved) {
          break;
        }
      }

      updateStatus(
        `全库存最低价-0.01上架完成。共尝试 ${totalAttempted} 件，调价 ${totalAdjusted} 件，送入队列 ${totalQueued} 件，查价失败 ${totalPriceFailed} 件。`,
        "success",
      );
      log("全库存最低价-0.01上架完成。", {
        totalAttempted,
        totalAdjusted,
        totalQueued,
        totalPriceFailed,
        endPage: currentPageNumber(),
      });
    } catch (error) {
      updateStatus(`全库存最低价-0.01上架失败：${error.message}`, "error");
      log(`全库存最低价-0.01上架失败：${error.message}`);
    } finally {
      state.inventorySweepRunning = false;
      state.paused = false;
      renderSummary();
    }
  }

  function loadPanelLayout() {
    try {
      const raw = window.localStorage.getItem(PANEL_LAYOUT_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function savePanelLayout(panel = findPanel()) {
    if (!panel) {
      return;
    }
    const layout = {
      top: Math.max(8, Math.round(panel.offsetTop)),
      left: Math.max(8, Math.round(panel.offsetLeft)),
      width: Math.max(PANEL_MIN_WIDTH, Math.round(panel.offsetWidth)),
      height: Math.max(PANEL_MIN_HEIGHT, Math.round(panel.offsetHeight)),
    };
    window.localStorage.setItem(PANEL_LAYOUT_KEY, JSON.stringify(layout));
  }

  function applyStoredPanelLayout(panel) {
    const saved = loadPanelLayout();
    const width = Math.max(PANEL_MIN_WIDTH, Number(saved?.width) || 360);
    const height = Math.max(
      PANEL_MIN_HEIGHT,
      Number(saved?.height) || Math.min(780, window.innerHeight - 32),
    );
    const defaultTop = Math.max(8, window.scrollY + 16);
    const top = Math.max(8, Number(saved?.top) || defaultTop);
    const defaultLeft = Math.max(8, window.scrollX + window.innerWidth - width - 16);
    const left = Math.max(8, Number(saved?.left) || defaultLeft);
    panel.style.width = `${Math.min(width, window.innerWidth - 8)}px`;
    panel.style.height = `${Math.min(height, window.innerHeight - 8)}px`;
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = "auto";
  }

  function clampPanelInsideDocument(panel) {
    const maxLeft = Math.max(8, document.documentElement.scrollWidth - 80);
    const maxTop = Math.max(8, document.documentElement.scrollHeight - 80);
    const nextLeft = Math.min(Math.max(8, panel.offsetLeft), maxLeft);
    const nextTop = Math.min(Math.max(8, panel.offsetTop), maxTop);
    panel.style.left = `${nextLeft}px`;
    panel.style.top = `${nextTop}px`;
  }

  function bindPanelDragAndResize(panel) {
    const handle = query('[data-role="drag-handle"]', panel);
    if (handle) {
      handle.addEventListener("mousedown", (event) => {
        if (event.button !== 0) {
          return;
        }
        state.panel.drag = {
          startX: event.pageX,
          startY: event.pageY,
          baseLeft: panel.offsetLeft,
          baseTop: panel.offsetTop,
        };
        event.preventDefault();
      });
    }

    window.addEventListener("mousemove", (event) => {
      if (!state.panel.drag) {
        return;
      }
      const nextLeft = state.panel.drag.baseLeft + (event.pageX - state.panel.drag.startX);
      const nextTop = state.panel.drag.baseTop + (event.pageY - state.panel.drag.startY);
      panel.style.left = `${Math.max(8, nextLeft)}px`;
      panel.style.top = `${Math.max(8, nextTop)}px`;
      panel.style.right = "auto";
      clampPanelInsideDocument(panel);
    });

    window.addEventListener("mouseup", () => {
      if (state.panel.drag) {
        state.panel.drag = null;
        clampPanelInsideDocument(panel);
      }
      savePanelLayout(panel);
    });

    window.addEventListener("resize", () => {
      clampPanelInsideDocument(panel);
      savePanelLayout(panel);
    });

    if (window.ResizeObserver) {
      state.panel.resizeObserver = new window.ResizeObserver(() => {
        clampPanelInsideDocument(panel);
        savePanelLayout(panel);
      });
      state.panel.resizeObserver.observe(panel);
    }
  }

  function startInventoryObservers() {
    if (!isInventoryPage()) {
      return;
    }
    const inventoryRoot = query("#inventories") || query(".inventory_ctn") || document.body;
    state.mutationObserver = new MutationObserver(() => scheduleScan());
    state.mutationObserver.observe(inventoryRoot, {
      childList: true,
      subtree: true,
    });

    state.autoScanTimer = window.setInterval(() => scanInventory(false), INVENTORY_SCAN_INTERVAL_MS);
  }

  async function boot() {
    injectStyles();
    buildPanel();
    await waitForAnimationFrame();
    if (isInventoryPage()) {
      scanInventory(true);
    } else {
      clearInventoryState();
      updateStatus("当前不是库存页，库存操作已禁用。", "info");
    }
    startInventoryObservers();
    log("脚本已加载。");
  }

  boot();
})();

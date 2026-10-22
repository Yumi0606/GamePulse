// 周视图甘特图交互（仅 /week 加载；defer 引入）
// 服务端把条目数据嵌入 <script type="application/json" id="week-data">，本脚本负责全部渲染与交互。
//
// 核心交互：
//   普通滚轮       → 横向滚动时间轴
//   Shift+滚轮     → 缩放精度（小时/天/周/月）
//   Ctrl+滚轮      → 缩放行高（20~60px）
//   拖动任意区域   → 平移视口（5px 阈值区分点击）
//   点击条         → 弹出详情 popover
//   移动端：单指拖动平移、双指捏合缩放、单击详情
//
// 精度与定位：
//   每种精度对应"每格时间单位"与"每格像素宽度"。条的 left/width 基于格索引计算：
//     left  = (格索引(start) - viewportStart格索引) * cellWidth
//     width = (格索引(end)   - 格索引(start) + 1)       * cellWidth
//   无起点有终点的条目：left=0，width 到结束格。

(function () {
  'use strict';

  // ---------- 常量与配置 ----------
  var CST_OFFSET = 8 * 3600;          // CST = UTC+8
  var DAY = 86400;
  var PRECISIONS = [
    { key: 'hour',  unit: 3600,        cellWidth: 40,  label: '小时' },
    { key: 'day',   unit: 86400,       cellWidth: 80,  label: '天' },
    { key: 'week',  unit: 86400 * 7,   cellWidth: 120, label: '周' },
    { key: 'month', unit: 86400 * 30,  cellWidth: 200, label: '月' },
  ];
  var PRECISION_INDEX = { hour: 0, day: 1, week: 2, month: 3 };
  var ROW_HEIGHT_MIN = 20, ROW_HEIGHT_MAX = 60, ROW_HEIGHT_DEFAULT = 32;
  var LOAD_WEEKS = 4;                  // 每次加载 4 周
  var INITIAL_WEEKS = 4;               // 初始 ±4 周
  var DRAG_THRESHOLD = 5;              // 拖动判定阈值（px）
  var SHARED_PREFS_KEY = 'gp-shared-prefs';

  var TYPE_LABEL = {
    ACTIVITY: '活动', GACHA: '卡池', SHOP: '商店', COLLAB: '联动', ANNOUNCEMENT: '公告',
  };

  // ---------- DOM 引用 ----------
  var container = document.getElementById('gantt-container');
  var timeline = document.getElementById('gantt-timeline');
  var headerEl = document.getElementById('gantt-header');
  var bodyEl = document.getElementById('gantt-body');
  var todayEl = document.getElementById('gantt-today');
  var popover = document.getElementById('gantt-popover');
  var unanchoredEl = document.getElementById('week-unanchored');
  var loadEl = document.getElementById('week-load');

  var fGame = document.getElementById('w-game');
  var fType = document.getElementById('w-type');
  var fKw = document.getElementById('w-kw');
  var fSort = document.getElementById('w-sort');
  var fDir = document.getElementById('w-dir');
  var fEnded = document.getElementById('w-ended');
  var fReset = document.getElementById('w-reset');
  var btnEarlier = document.getElementById('load-earlier');
  var btnLater = document.getElementById('load-later');

  // ---------- 数据 ----------
  var entries = JSON.parse(document.getElementById('week-data').textContent || '[]');
  var fromTs = window.__WEEK_FROM__ || Math.floor(Date.now() / 1000);

  // ---------- 状态 ----------
  var state = {
    precision: 'day',
    cellWidth: 80,
    rowHeight: ROW_HEIGHT_DEFAULT,
    // 视口时间范围（Unix 秒）；范围决定渲染的格子数
    viewStart: 0,
    viewEnd: 0,
    sort: 'start',
    dir: 'asc',
    onlyActive: false,
    filterGame: '',
    filterType: '',
    filterKw: '',
  };

  // ---------- 工具函数 ----------

  /** CST 天索引（相对于 1970-01-01 CST） */
  function dayIndex(ts) { return Math.floor((ts + CST_OFFSET) / DAY); }

  /** CST 小时索引 */
  function hourIndex(ts) { return Math.floor((ts + CST_OFFSET) / 3600); }

  /** CST 周索引（周一起始；1969-12-29 周一为第 0 周） */
  function weekIndex(ts) {
    var dIdx = dayIndex(ts);
    return Math.floor((dIdx + 4) / 7); // dayIdx=0 是周四，+4 对齐到周一
  }

  /** CST 月索引（年*12+月） */
  function monthIndex(ts) {
    var d = new Date((ts + CST_OFFSET) * 1000);
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
  }

  /** 按精度把 ts 转为格索引 */
  function cellIndex(ts, precision) {
    if (precision === 'hour') return hourIndex(ts);
    if (precision === 'day') return dayIndex(ts);
    if (precision === 'week') return weekIndex(ts);
    return monthIndex(ts);
  }

  /** ts 所在周的周一 00:00（CST）的 Unix 秒 */
  function weekMonday(ts) {
    var dIdx = dayIndex(ts);
    var mondayIdx = dIdx - ((dIdx + 4) % 7);
    return mondayIdx * DAY - CST_OFFSET;
  }

  /** 格式化 Unix 秒为 CST "YYYY-MM-DD HH:mm" */
  function fmtCst(ts) {
    if (!ts) return '—';
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ts * 1000)).replace(/\//g, '-');
  }

  /** 格式化格索引对应的表头标签 */
  function headerLabel(cellIdx, precision) {
    if (precision === 'hour') {
      var ts = cellIdx * 3600 - CST_OFFSET;
      var d = new Date(ts * 1000);
      var h = String(d.getUTCHours()).padStart(2, '0');
      return (cellIdx % 24 === 0)
        ? (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + ' 00'
        : h + ':00';
    }
    if (precision === 'day') {
      var ts = cellIdx * DAY - CST_OFFSET;
      var d = new Date(ts * 1000);
      return (d.getUTCMonth() + 1) + '/' + d.getUTCDate();
    }
    if (precision === 'week') {
      // 周一的 dayIdx = cellIdx * 7 - 4
      var dIdx = cellIdx * 7 - 4;
      var ts = dIdx * DAY - CST_OFFSET;
      var d = new Date(ts * 1000);
      return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + ' 起';
    }
    // month
    var y = Math.floor(cellIdx / 12);
    var m = cellIdx % 12;
    return y + '-' + String(m + 1).padStart(2, '0');
  }

  /** 判断格索引对应天是否周末 */
  function isWeekendCell(cellIdx, precision) {
    if (precision === 'hour' || precision === 'day') {
      var dIdx = precision === 'hour' ? Math.floor(cellIdx / 24) : cellIdx;
      var dow = (dIdx + 4) % 7; // 0=周一
      return dow === 5 || dow === 6;
    }
    return false;
  }

  /** 判断格索引是否今天 */
  function isTodayCell(cellIdx, precision) {
    var now = Math.floor(Date.now() / 1000);
    return cellIndex(now, precision) === cellIdx;
  }

  /** 条目状态：future / active / ended */
  function entryState(e, now) {
    if (e.endAt !== null && e.endAt < now) return 'ended';
    if (e.startAt !== null && e.startAt > now) return 'future';
    return 'active';
  }

  // ---------- 视口范围 ----------

  function setInitialViewport() {
    var monday = weekMonday(fromTs);
    state.viewStart = monday - INITIAL_WEEKS * 7 * DAY;
    state.viewEnd = monday + INITIAL_WEEKS * 7 * DAY;
  }

  function loadEarlier() {
    var oldStartCell = cellIndex(state.viewStart, state.precision);
    var prevScrollLeft = container.scrollLeft;
    state.viewStart -= LOAD_WEEKS * 7 * DAY;
    var newStartCell = cellIndex(state.viewStart, state.precision);
    var addedWidth = (oldStartCell - newStartCell) * state.cellWidth;
    render();
    // 追加在左侧，视口右移对应宽度以保持当前可视内容不动
    container.scrollLeft = prevScrollLeft + addedWidth;
  }
  function loadLater() {
    var prevScrollLeft = container.scrollLeft;
    state.viewEnd += LOAD_WEEKS * 7 * DAY;
    render();
    container.scrollLeft = prevScrollLeft;
  }

  // ---------- 渲染 ----------

  function render() {
    renderTimelineWidth();
    renderHeader();
    renderBody();
    renderTodayLine();
    renderUnanchored();
    updateLoadButtons();
  }

  /** 设置时间轴总宽度 = 格数 * cellWidth */
  function renderTimelineWidth() {
    var startCell = cellIndex(state.viewStart, state.precision);
    var endCell = cellIndex(state.viewEnd, state.precision);
    var cells = endCell - startCell + 1;
    timeline.style.width = (cells * state.cellWidth) + 'px';
    timeline.style.setProperty('--cell-width', state.cellWidth + 'px');
    timeline.style.setProperty('--row-height', state.rowHeight + 'px');
  }

  /** 渲染日期表头 */
  function renderHeader() {
    var startCell = cellIndex(state.viewStart, state.precision);
    var endCell = cellIndex(state.viewEnd, state.precision);
    var html = '';
    for (var c = startCell; c <= endCell; c++) {
      var cls = 'gantt-header-cell';
      if (isWeekendCell(c, state.precision)) cls += ' weekend';
      if (isTodayCell(c, state.precision)) cls += ' today';
      html += '<div class="' + cls + '">' + headerLabel(c, state.precision) + '</div>';
    }
    headerEl.innerHTML = html;
  }

  /** 渲染活动行（按游戏分组 + 组内排序） */
  function renderBody() {
    var now = Math.floor(Date.now() / 1000);
    var startCell = cellIndex(state.viewStart, state.precision);
    var endCell = cellIndex(state.viewEnd, state.precision);

    // 筛选
    var filtered = entries.filter(function (e) {
      if (state.filterGame && e.gameId !== state.filterGame) return false;
      if (state.filterType && e.type !== state.filterType) return false;
      if (state.filterKw) {
        var text = [e.title, e.canonicalName, e.category, e.summary].filter(Boolean).join(' ').toLowerCase();
        if (text.indexOf(state.filterKw) === -1) return false;
      }
      if (state.onlyActive && entryState(e, now) === 'ended') return false;
      return true;
    });

    // 按游戏分组（GAMES 顺序）
    var gameOrder = ['arknights', 'endfield', 'delta-force', 'wuthering-waves', 'azur-lane'];
    var groups = {};
    filtered.forEach(function (e) {
      if (!groups[e.gameId]) groups[e.gameId] = [];
      groups[e.gameId].push(e);
    });

    // 组内排序
    var sortKey = state.sort;
    var asc = state.dir === 'asc';
    var sortVal = function (e) {
      if (sortKey === 'start') return e.startAt;
      if (sortKey === 'end') return e.endAt;
      return (e.startAt !== null && e.endAt !== null) ? e.endAt - e.startAt : null;
    };

    var html = '';
    gameOrder.forEach(function (gid) {
      var list = groups[gid];
      if (!list || list.length === 0) return;
      var gameName = GAMES_MAP[gid] || gid;

      // 排序：已结束沉底，缺值沉底
      list.sort(function (a, b) {
        var ae = entryState(a, now) === 'ended', be = entryState(b, now) === 'ended';
        if (ae !== be) return ae ? 1 : -1;
        var va = sortVal(a), vb = sortVal(b);
        if (va === null && vb === null) return 0;
        if (va === null) return 1;
        if (vb === null) return -1;
        return asc ? va - vb : vb - va;
      });

      html += '<div class="gantt-group-header">' + gameName + '<span class="count">(' + list.length + ')</span></div>';
      list.forEach(function (e) {
        html += renderRow(e, startCell, endCell, now);
      });
    });

    if (html === '') {
      html = '<div class="gantt-empty">当前筛选条件下无活动</div>';
    }
    bodyEl.innerHTML = html;
  }

  /** 渲染单行活动：条内左侧 sticky 活动名 + 条内绝对定位色条 */
  function renderRow(e, startCell, endCell, now) {
    var stateCls = 'state-' + entryState(e, now);
    var typeLabel = TYPE_LABEL[e.type] || e.type;
    var catLabel = e.category || '';
    var chipText = catLabel ? (typeLabel + '·' + catLabel) : typeLabel;

    // 色条定位（条内绝对定位）
    var fillStyle = '';
    var fillCls = 'gantt-bar-fill ' + stateCls;
    var hasStart = e.startAt !== null;
    var hasEnd = e.endAt !== null;

    if (hasStart && hasEnd) {
      var sIdx = cellIndex(e.startAt, state.precision);
      var eIdx = cellIndex(e.endAt, state.precision);
      var left = (sIdx - startCell) * state.cellWidth;
      var width = (eIdx - sIdx + 1) * state.cellWidth;
      fillStyle = 'margin-left:' + left + 'px;width:' + width + 'px;';
    } else if (!hasStart && hasEnd) {
      // 无起点：从视口最左端画到结束日
      var eIdx = cellIndex(e.endAt, state.precision);
      var width = (eIdx - startCell + 1) * state.cellWidth;
      fillStyle = 'margin-left:0;width:' + width + 'px;';
      fillCls += ' no-start';
    } else if (hasStart && !hasEnd) {
      // 无终点：从起点画到视口最右端
      var sIdx = cellIndex(e.startAt, state.precision);
      var left = (sIdx - startCell) * state.cellWidth;
      var width = (endCell - sIdx + 1) * state.cellWidth;
      fillStyle = 'margin-left:' + left + 'px;width:' + width + 'px;';
    } else {
      // 两端皆无：不画条（进待锚定列表）
      return '';
    }

    var name = e.canonicalName || e.title;
    // 活动名放在色条内部，正常流位置即色条左边缘，无需 margin-left；
    // sticky left:0 让活动名在色条可见时固定到视口左边，色条滚出后随之离开
    return '<div class="gantt-row">' +
      '<div class="' + fillCls + '" data-type="' + e.type + '" data-entry-id="' + e.id + '" style="' + fillStyle + '">' +
        '<div class="gantt-label" title="' + esc(name) + '">' +
          '<span class="gantt-name">' + esc(name) + '</span>' +
          '<span class="gantt-chip">' + esc(chipText) + '</span>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  /** 渲染今天指示线 */
  function renderTodayLine() {
    var now = Math.floor(Date.now() / 1000);
    var startCell = cellIndex(state.viewStart, state.precision);
    var todayCell = cellIndex(now, state.precision);
    if (todayCell < startCell || todayCell > cellIndex(state.viewEnd, state.precision)) {
      todayEl.hidden = true;
      return;
    }
    var left = (todayCell - startCell) * state.cellWidth + state.cellWidth / 2;
    // 今天线是只约束纵向的 sticky 元素，横向按正常流定位，故用 margin-left
    todayEl.style.marginLeft = left + 'px';
    todayEl.hidden = false;
  }

  /** 渲染待锚定列表（两端皆无的条目） */
  function renderUnanchored() {
    var list = entries.filter(function (e) { return e.startAt === null && e.endAt === null; });
    if (state.filterGame) list = list.filter(function (e) { return e.gameId === state.filterGame; });
    if (state.filterType) list = list.filter(function (e) { return e.type === state.filterType; });
    if (state.filterKw) {
      list = list.filter(function (e) {
        var text = [e.title, e.canonicalName, e.category, e.summary].filter(Boolean).join(' ').toLowerCase();
        return text.indexOf(state.filterKw) !== -1;
      });
    }
    if (list.length === 0) { unanchoredEl.innerHTML = ''; return; }
    var html = '<h2>待锚定条目 <small>（' + list.length + '，无起止时间）</small></h2><ul>';
    list.forEach(function (e) {
      var g = GAMES_MAP[e.gameId] || e.gameId;
      html += '<li><span style="color:#888;">[' + g + ']</span> ' +
        '<a href="' + esc(e.url || '#') + '" target="_blank" rel="noopener">' + esc(e.title) + '</a></li>';
    });
    html += '</ul>';
    unanchoredEl.innerHTML = html;
  }

  /** 计算数据实际时间范围，用于判断是否还有更多可加载 */
  function getDataRange() {
    var minStart = Infinity, maxEnd = -Infinity;
    entries.forEach(function (e) {
      if (e.startAt !== null && e.startAt < minStart) minStart = e.startAt;
      if (e.endAt !== null && e.endAt > maxEnd) maxEnd = e.endAt;
    });
    return { minStart: minStart === Infinity ? null : minStart, maxEnd: maxEnd === -Infinity ? null : maxEnd };
  }

  /** 更新加载按钮状态：始终显示，无更多数据时置灰禁用 */
  function updateLoadButtons() {
    var range = getDataRange();
    var noEarlier = range.minStart !== null && state.viewStart <= range.minStart - LOAD_WEEKS * 7 * DAY;
    var noLater = range.maxEnd !== null && state.viewEnd >= range.maxEnd + LOAD_WEEKS * 7 * DAY;
    btnEarlier.disabled = noEarlier;
    btnLater.disabled = noLater;
    btnEarlier.style.opacity = noEarlier ? '0.4' : '1';
    btnLater.style.opacity = noLater ? '0.4' : '1';
    btnEarlier.style.cursor = noEarlier ? 'not-allowed' : 'pointer';
    btnLater.style.cursor = noLater ? 'not-allowed' : 'pointer';
    loadEl.hidden = false;
  }

  // ---------- 交互：滚轮 ----------

  container.addEventListener('wheel', function (e) {
    if (e.shiftKey) {
      // Shift+滚轮：缩放精度
      e.preventDefault();
      var idx = PRECISION_INDEX[state.precision];
      var next = e.deltaY < 0 ? Math.min(idx + 1, PRECISIONS.length - 1) : Math.max(idx - 1, 0);
      if (next !== idx) setPrecision(PRECISIONS[next].key);
    } else if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd+滚轮：缩放行高
      e.preventDefault();
      var delta = e.deltaY < 0 ? 2 : -2;
      setRowHeight(Math.min(ROW_HEIGHT_MAX, Math.max(ROW_HEIGHT_MIN, state.rowHeight + delta)));
    } else {
      // 普通滚轮：横向滚动（把纵向滚轮转为横向滚动）
      e.preventDefault();
      container.scrollLeft += e.deltaY;
    }
  }, { passive: false });

  function setPrecision(key) {
    var p = PRECISIONS[PRECISION_INDEX[key]];
    state.precision = key;
    state.cellWidth = p.cellWidth;
    render();
  }

  function setRowHeight(h) {
    state.rowHeight = h;
    timeline.style.setProperty('--row-height', h + 'px');
  }

  // ---------- 交互：拖动平移 ----------

  var dragging = false, dragStartX = 0, dragStartY = 0, dragStartScrollLeft = 0, dragStartScrollTop = 0, moved = false;

  container.addEventListener('mousedown', function (e) {
    // 条上点击不立即进入拖动，等移动超过阈值
    dragging = true;
    moved = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartScrollLeft = container.scrollLeft;
    dragStartScrollTop = container.scrollTop;
    container.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    var dx = e.clientX - dragStartX;
    var dy = e.clientY - dragStartY;
    if (!moved && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
      moved = true;
    }
    if (moved) {
      container.scrollLeft = dragStartScrollLeft - dx;
      container.scrollTop = dragStartScrollTop - dy;
    }
  });

  document.addEventListener('mouseup', function (e) {
    if (!dragging) return;
    dragging = false;
    container.style.cursor = '';
    // 未移动 → 视为点击
    if (!moved) handleClick(e);
  });

  // ---------- 交互：点击条弹出 popover ----------

  function handleClick(e) {
    var bar = e.target.closest('[data-entry-id]');
    if (!bar) { hidePopover(); return; }
    var id = bar.dataset.entryId;
    var entry = entries.find(function (en) { return en.id === id; });
    if (!entry) return;
    showPopover(entry, e.clientX, e.clientY);
  }

  function showPopover(entry, x, y) {
    var g = GAMES_MAP[entry.gameId] || entry.gameId;
    var typeLabel = TYPE_LABEL[entry.type] || entry.type;
    var name = entry.canonicalName || entry.title;
    var html = '<div class="pv-title">' + esc(name) + '</div>' +
      '<div class="pv-meta">' + esc(g) + ' · ' + esc(typeLabel) + (entry.category ? '·' + esc(entry.category) : '') + '</div>' +
      '<div class="pv-meta">' + fmtCst(entry.startAt) + ' → ' + fmtCst(entry.endAt) + '</div>';
    if (entry.summary) html += '<div style="margin-top:6px;">' + esc(entry.summary) + '</div>';
    if (entry.postTitle) {
      html += '<div style="margin-top:6px;font-size:12px;">来源：<a href="' + esc(entry.postUrl || '#') + '" target="_blank" rel="noopener">' + esc(entry.postTitle) + '</a></div>';
    }
    popover.innerHTML = html;
    popover.hidden = false;
    // 定位：避免溢出视口
    var rect = popover.getBoundingClientRect();
    var px = x + 12, py = y + 12;
    if (px + rect.width > window.innerWidth) px = x - rect.width - 12;
    if (py + rect.height > window.innerHeight) py = y - rect.height - 12;
    popover.style.left = px + 'px';
    popover.style.top = py + 'px';
  }

  function hidePopover() { popover.hidden = true; }
  document.addEventListener('click', function (e) {
    if (!e.target.closest('[data-entry-id]') && !e.target.closest('.gantt-popover')) hidePopover();
  });

  // ---------- 交互：筛选与排序 ----------

  function applyFilters() {
    state.filterGame = fGame.value;
    state.filterType = fType.value;
    state.filterKw = fKw.value.trim().toLowerCase();
    state.sort = fSort.value;
    state.dir = fDir.dataset.dir;
    state.onlyActive = fEnded.checked;
    savePrefs();
    render();
  }

  [fGame, fType, fKw, fSort, fEnded].forEach(function (el) {
    el.addEventListener('input', applyFilters);
    el.addEventListener('change', applyFilters);
  });

  /** 根据当前方向刷新排序按钮的箭头与 title（与列表视图提示文案一致） */
  function updateDirButton() {
    var asc = fDir.dataset.dir === 'asc';
    fDir.textContent = asc ? '↑' : '↓';
    fDir.title = asc
      ? '当前升序（早→晚 / 短→长），点击切换为降序'
      : '当前降序（晚→早 / 长→短），点击切换为升序';
  }

  fDir.addEventListener('click', function () {
    fDir.dataset.dir = fDir.dataset.dir === 'asc' ? 'desc' : 'asc';
    updateDirButton();
    applyFilters();
  });

  fReset.addEventListener('click', function () {
    fGame.value = ''; fType.value = ''; fKw.value = '';
    fSort.value = 'start'; fDir.dataset.dir = 'asc';
    updateDirButton();
    fEnded.checked = false;
    applyFilters();
  });

  btnEarlier.addEventListener('click', loadEarlier);
  btnLater.addEventListener('click', loadLater);

  // ---------- localStorage 状态（与列表/日历视图共享） ----------

  function loadPrefs() {
    try {
      var p = JSON.parse(localStorage.getItem(SHARED_PREFS_KEY) || '{}');
      if (p.game) fGame.value = p.game;
      if (p.type) fType.value = p.type;
      if (p.kw) fKw.value = p.kw;
      if (p.sort) fSort.value = p.sort;
      if (p.dir === 'desc') { fDir.dataset.dir = 'desc'; }
      updateDirButton();
      if (p.ended) fEnded.checked = true;
      state.filterGame = fGame.value;
      state.filterType = fType.value;
      state.filterKw = fKw.value.trim().toLowerCase();
      state.sort = fSort.value;
      state.dir = fDir.dataset.dir;
      state.onlyActive = fEnded.checked;
    } catch (e) { /* 忽略 */ }
  }

  function savePrefs() {
    try {
      localStorage.setItem(SHARED_PREFS_KEY, JSON.stringify({
        game: state.filterGame, type: state.filterType, kw: state.filterKw,
        sort: state.sort, dir: state.dir, ended: state.onlyActive,
      }));
    } catch (e) { /* 忽略 */ }
  }

  // ---------- 移动端触摸 ----------

  var touchState = null;
  container.addEventListener('touchstart', function (e) {
    if (e.touches.length === 1) {
      var t = e.touches[0];
      touchState = { mode: 'pan', startX: t.clientX, startY: t.clientY, sl: container.scrollLeft, st: container.scrollTop, moved: false };
    } else if (e.touches.length === 2) {
      var dx = e.touches[0].clientX - e.touches[1].clientX;
      var dy = e.touches[0].clientY - e.touches[1].clientY;
      touchState = { mode: 'pinch', dist: Math.sqrt(dx * dx + dy * dy), precision: state.precision, rowHeight: state.rowHeight };
    }
  }, { passive: true });

  container.addEventListener('touchmove', function (e) {
    if (!touchState) return;
    if (touchState.mode === 'pan' && e.touches.length === 1) {
      var t = e.touches[0];
      var dx = t.clientX - touchState.startX, dy = t.clientY - touchState.startY;
      if (!touchState.moved && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) touchState.moved = true;
      if (touchState.moved) {
        container.scrollLeft = touchState.sl - dx;
        container.scrollTop = touchState.st - dy;
        e.preventDefault();
      }
    } else if (touchState.mode === 'pinch' && e.touches.length === 2) {
      var dx = e.touches[0].clientX - e.touches[1].clientX;
      var dy = e.touches[0].clientY - e.touches[1].clientY;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var scale = dist / touchState.dist;
      // 缩放精度：放大→更高精度（更小单位），缩小→更低精度
      var idx = PRECISION_INDEX[touchState.precision];
      if (scale > 1.3 && idx < PRECISIONS.length - 1) {
        setPrecision(PRECISIONS[idx + 1].key);
        touchState.dist = dist; touchState.precision = state.precision;
      } else if (scale < 0.75 && idx > 0) {
        setPrecision(PRECISIONS[idx - 1].key);
        touchState.dist = dist; touchState.precision = state.precision;
      }
      // 行高跟随缩放
      var newH = Math.min(ROW_HEIGHT_MAX, Math.max(ROW_HEIGHT_MIN, Math.round(touchState.rowHeight * scale)));
      setRowHeight(newH);
      e.preventDefault();
    }
  }, { passive: false });

  container.addEventListener('touchend', function (e) {
    if (touchState && touchState.mode === 'pan' && !touchState.moved && e.changedTouches.length === 1) {
      // 单击：模拟点击
      var t = e.changedTouches[0];
      var el = document.elementFromPoint(t.clientX, t.clientY);
      var bar = el && el.closest('[data-entry-id]');
      if (bar) {
        var id = bar.dataset.entryId;
        var entry = entries.find(function (en) { return en.id === id; });
        if (entry) showPopover(entry, t.clientX, t.clientY);
      }
    }
    touchState = null;
  });

  // ---------- 工具 ----------

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // 游戏 ID → 名称映射（服务端 GAMES 顺序）
  var GAMES_MAP = {
    'arknights': '明日方舟',
    'endfield': '明日方舟：终末地',
    'delta-force': '三角洲行动',
    'wuthering-waves': '鸣潮',
    'azur-lane': '碧蓝航线',
  };

  // ---------- 启动 ----------
  fDir.dataset.dir = 'asc'; // 默认升序，loadPrefs 可能覆盖
  loadPrefs();
  setInitialViewport();
  // 容器高度：视口高度的 70%，下限 400px；同时写入 --gantt-h 供今天线 sticky 高度使用
  function applyContainerHeight() {
    var h = Math.max(400, Math.floor(window.innerHeight * 0.7));
    container.style.height = h + 'px';
    timeline.style.setProperty('--gantt-h', h + 'px');
  }
  applyContainerHeight();
  window.addEventListener('resize', applyContainerHeight);
  render();
})();

// 日历视图交互（仅 /calendar 加载；defer 引入）
// ① 月份选择器跳转；② 游戏/分类筛选（就地显隐落点事件与持续条）；③ 单元格展开/收起（+N 按钮或点击格内空白）。
// 折叠上限 MAX 必须与 page.ts 中的 MAX_PER_CELL 保持一致。
(function () {
  var MAX = 3;
  var game = document.getElementById('c-game');
  var type = document.getElementById('c-type');
  var reset = document.getElementById('c-reset');
  var month = document.getElementById('c-month');

  if (month) {
    month.addEventListener('change', function () {
      if (/^\d{4}-\d{2}$/.test(month.value)) location.href = '/calendar?month=' + month.value;
    });
  }

  // 元素是否命中当前筛选（游戏 + 分类）
  function match(el) {
    return (!game.value || el.dataset.game === game.value) &&
           (!type.value || el.dataset.type === type.value);
  }

  // 当前筛选下命中的落点事件
  function hits(td) {
    return Array.prototype.slice.call(td.querySelectorAll('a.ev')).filter(match);
  }

  // 设置单元格展开状态：false 只显前 MAX 条，true 全显；同步 +N 按钮文案与 aria 状态
  function setExpanded(td, expanded) {
    hits(td).forEach(function (a, i) { a.hidden = !expanded && i >= MAX; });
    td.classList.toggle('expanded', expanded);
    var more = td.querySelector('.more');
    if (more) {
      var rest = hits(td).length - MAX;
      more.hidden = rest <= 0;
      more.textContent = expanded ? '收起' : '+' + rest;
      more.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      more.setAttribute('aria-label', expanded ? '收起额外事件' : '展开其余 ' + rest + ' 项');
    }
  }

  // 按筛选重排：持续条整行显隐（一行仅一条）；落点事件全部重置为折叠态
  function apply() {
    document.querySelectorAll('tr.span-row').forEach(function (tr) { tr.hidden = !match(tr); });
    document.querySelectorAll('td.dcell').forEach(function (td) {
      td.querySelectorAll('a.ev').forEach(function (a) { a.hidden = true; });
      setExpanded(td, false);
    });
  }

  if (game) game.addEventListener('change', apply);
  if (type) type.addEventListener('change', apply);
  if (reset) reset.addEventListener('click', function () { game.value = ''; type.value = ''; apply(); });

  // 展开/收起：点 +N 按钮，或点击格内空白处（放行事件与持续条链接，保证跳转正常）
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('a')) return;
    var target = e.target.closest ? e.target.closest('.more, td.dcell') : null;
    var td = target && target.tagName === 'TD' ? target : (target ? target.closest('td') : null);
    if (!td) return;
    setExpanded(td, !td.classList.contains('expanded'));
  });

  apply();
})();

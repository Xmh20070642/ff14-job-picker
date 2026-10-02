// 前端逻辑 v2
const api = (url, opts = {}) => {
  const init = {};
  if (opts.method) init.method = opts.method;
  if (opts.body) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }
  return fetch(url, init).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `请求失败 (${r.status})`);
    return data;
  });
};

let state = { roles: [], groups: [], jobs: [], dungeons: [], players: [], exclusions: [] };
let selectedDungeon = null;
const $ = (id) => document.getElementById(id);

const ROLE_COLORS = { '防护': 'tank', '治疗': 'healer', '进攻': 'dps' };
const PLAYER_COLORS = ['p1', 'p2', 'p3', 'p4'];

// ---------- 初始化 ----------
async function init() {
  try {
    await refreshState();
    await refreshHistory();
  } catch (e) {
    console.error('初始化失败:', e);
    const el = $('dungeon-buttons');
    if (el) {
      const base = location.origin;
      el.innerHTML =
        '<div style="color:#ef4444;padding:14px;line-height:2;">' +
        '⚠️ 无法连接服务器 API<br>' +
        '错误：' + esc(e.message) + '<br>' +
        '尝试地址：' + esc(base) + '/api/state<br>' +
        '请操作：<br>' +
        '1. 确认两台电脑在同一 WiFi<br>' +
        '2. 在另一台电脑浏览器直接打开 <a href="' + esc(base) + '/api/state" style="color:#6ea8fe;">' + esc(base) + '/api/state</a> 测试<br>' +
        '3. 若打不开，是 Mac 防火墙挡了 → 系统设置→网络→防火墙→关闭，或允许 node<br>' +
        '4. 若换过网络，IP 可能变了，在本机终端运行 ifconfig 查看 192.168 开头地址' +
        '</div>';
    }
  }
}

async function refreshState() {
  state = await api('/api/state');
  renderDungeonSelector();
  renderPlayers();
  renderExclusions();
  renderLinkageRules();
  renderJobs();
  renderGroups();
  renderDungeons();
  refreshSelects();
  refreshLinkageSelects();
}

// ---------- 副本选择 ----------
function renderDungeonSelector() {
  const el = $('dungeon-buttons');
  // 选中的副本若已被删除，重置为第一个，避免残留高亮和失效请求
  if (selectedDungeon && !state.dungeons.some((d) => d.id === selectedDungeon.id)) {
    selectedDungeon = null;
  }
  // 先设置默认副本（避免递归调用）
  if (!selectedDungeon && state.dungeons.length > 0) {
    selectedDungeon = state.dungeons[0];
  }
  el.innerHTML = state.dungeons
    .map((d) => {
      const active = selectedDungeon?.id === d.id ? 'active' : '';
      const total = d.tank_count + d.healer_count + d.dps_count;
      return `
        <button class="dungeon-btn ${active}" data-id="${d.id}">
          ${esc(d.name)}
          <small>防护${d.tank_count} + 治疗${d.healer_count} + 进攻${d.dps_count} = ${total}人</small>
        </button>`;
    })
    .join('');
  updateSlotSummary();
}

function updateSlotSummary() {
  const el = $('slot-summary');
  if (!selectedDungeon) { el.innerHTML = ''; return; }
  const d = selectedDungeon;
  el.innerHTML = `
    <span class="role-tag tank">防护 ×${d.tank_count}</span>
    <span class="role-tag healer">治疗 ×${d.healer_count}</span>
    <span class="role-tag dps">进攻 ×${d.dps_count}</span>
    <span style="margin-left: 10px;">总槽位 ${d.tank_count + d.healer_count + d.dps_count}</span>
  `;
}

// ---------- 随机 ----------
async function doRandom() {
  if (!selectedDungeon) return msg('请先选择副本类型', 'error');
  const btn = $('random-btn');
  btn.disabled = true;
  btn.textContent = '随机中…';
  $('message').textContent = '';
  $('message').className = 'message';

  try {
    const r = await api('/api/random', { method: 'POST', body: { dungeonId: selectedDungeon.id } });
    renderResults(r.results);
    await refreshHistory(true);
    msg('✅ 已生成并保存', 'success');
  } catch (e) {
    msg('❌ ' + e.message, 'error');
    $('results-container').innerHTML = '';
  } finally {
    btn.disabled = false;
    btn.textContent = '🎲 随机生成';
  }
}

function renderResults(results) {
  const el = $('results-container');
  el.innerHTML = results
    .map((r, i) => {
      const roleClass = ROLE_COLORS[r.role_name] || '';
      const playerClass = PLAYER_COLORS[i % PLAYER_COLORS.length];
      return `
        <div class="result-card ${playerClass} pop">
          <div class="player-name">${esc(r.player_name)}</div>
          <div class="role-badge ${roleClass}">${esc(r.role_name)}</div>
          <div class="job-name">${esc(r.job_name)}</div>
        </div>`;
    })
    .join('');
}

// ---------- 历史 ----------
async function refreshHistory(animate = false) {
  const list = await api('/api/history');
  const ul = $('history-list');
  if (!list.length) {
    ul.innerHTML = '<li class="empty-tip">暂无记录</li>';
    return;
  }
  ul.innerHTML = list
    .map((h, i) => {
      const t = new Date(h.created_at).toLocaleString('zh-CN', { hour12: false });
      const results = JSON.parse(h.snapshot);
      const resultsText = results.map((r) => `${r.player_name}(${r.role_name}): ${r.job_name}`).join(', ');
      const enterClass = (animate && i === 0) ? ' history-enter' : '';
      return `
        <li class="${enterClass}">
          <span class="time">${t}</span>
          <span class="dungeon-tag">${esc(h.dungeon)}</span>
          <span class="results">${esc(resultsText)}</span>
          <button class="del" onclick="deleteHistory(${h.id})">删除</button>
        </li>`;
    })
    .join('');
}

async function deleteHistory(id) {
  await api(`/api/history/${id}`, { method: 'DELETE' });
  await refreshHistory();
}
window.deleteHistory = deleteHistory;

$('clear-history').addEventListener('click', async () => {
  if (!confirm('确定清空所有历史吗？')) return;
  await api('/api/history', { method: 'DELETE' });
  await refreshHistory();
});

// ---------- 玩家管理 ----------
function renderPlayers() {
  const el = $('players-manage');
  el.innerHTML = state.players
    .map((p) => `
      <div class="player-row">
        <input value="${esc(p.name)}" data-player="${p.id}" />
        <button class="save" onclick="savePlayer(${p.id})">保存</button>
        <button class="del" onclick="deletePlayer(${p.id})">删除</button>
      </div>`)
    .join('');
}

async function savePlayer(id) {
  const name = document.querySelector(`input[data-player="${id}"]`).value.trim();
  if (!name) return msg('玩家名不能为空', 'error');
  await api(`/api/players/${id}`, { method: 'PUT', body: { name } });
  await refreshState();
  msg('已保存', 'success');
}
window.savePlayer = savePlayer;

async function deletePlayer(id) {
  if (!confirm('删除该玩家？')) return;
  await api(`/api/players/${id}`, { method: 'DELETE' });
  await refreshState();
}
window.deletePlayer = deletePlayer;

$('add-player').addEventListener('click', async () => {
  const name = $('new-player-name').value.trim();
  if (!name) return msg('请输入玩家名', 'error');
  await api('/api/players', { method: 'POST', body: { name } });
  $('new-player-name').value = '';
  await refreshState();
  msg('已添加', 'success');
});

// ---------- 排除规则 ----------
function renderExclusions() {
  const el = $('exclusions-area');
  el.innerHTML = state.players
    .map((p) => {
      const checkedJob = (jid) =>
        state.exclusions.some((e) => e.player_id === p.id && e.exclude_type === 'job' && e.target_id === jid)
          ? 'checked' : '';

      // 职能复选框集中放顶部
      const groupCbs = state.groups
        .map((g) => {
          const jobsInGroup = state.jobs.filter((j) => j.group_id === g.id);
          if (!jobsInGroup.length) return '';
          const allChecked = jobsInGroup.every((j) => checkedJob(j.id) === 'checked');
          const groupChecked = state.exclusions.some(
            (e) => e.player_id === p.id && e.exclude_type === 'group' && e.target_id === g.id
          );
          const groupCbChecked = groupChecked || allChecked ? 'checked' : '';
          return `
            <label class="excl-group-label">
              <input type="checkbox" data-player="${p.id}" data-type="group" data-group-id="${g.id}" ${groupCbChecked} />
              排除${esc(g.name)}
            </label>`;
        })
        .join('');

      // 职业复选框按组别分区放在下面
      const jobBlocks = state.groups
        .map((g) => {
          const jobsInGroup = state.jobs.filter((j) => j.group_id === g.id);
          if (!jobsInGroup.length) return '';
          const jobBoxes = jobsInGroup
            .map((j) => `
              <label>
                <input type="checkbox" data-player="${p.id}" data-type="job" data-group-id="${g.id}" data-id="${j.id}" ${checkedJob(j.id)} />
                排除${esc(j.name)}
              </label>`)
            .join('');
          return `<div class="excl-job-group"><div class="excl-job-group-title">${esc(g.name.replace('职能', ''))}</div>${jobBoxes}</div>`;
        })
        .join('');

      return `
        <div class="player-excl">
          <h4>${esc(p.name)}</h4>
          <div class="excl-grid excl-groups-top">${groupCbs}</div>
          <div class="excl-jobs-area">${jobBlocks}</div>
        </div>`;
    })
    .join('');

  // 职能↔职业双向联动
  el.querySelectorAll('input[data-type="group"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const playerId = cb.dataset.player;
      const groupId = cb.dataset.groupId;
      const checked = cb.checked;
      el.querySelectorAll(`input[data-type="job"][data-player="${playerId}"][data-group-id="${groupId}"]`).forEach(
        (jcb) => { jcb.checked = checked; }
      );
      onExclusionChange();
    });
  });

  el.querySelectorAll('input[data-type="job"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const playerId = cb.dataset.player;
      const groupId = cb.dataset.groupId;
      const allJobs = el.querySelectorAll(`input[data-type="job"][data-player="${playerId}"][data-group-id="${groupId}"]`);
      const allChecked = [...allJobs].every((jcb) => jcb.checked);
      const groupCb = el.querySelector(`input[data-type="group"][data-player="${playerId}"][data-group-id="${groupId}"]`);
      if (groupCb) groupCb.checked = allChecked;
      onExclusionChange();
    });
  });
}

async function onExclusionChange() {
  const el = $('exclusions-area');
  // 收集每个玩家当前勾选的排除项
  for (const p of state.players) {
    const all = el.querySelectorAll(`input[data-player="${p.id}"]`);
    const groups = [], jobs = [];
    all.forEach((cb) => {
      if (!cb.checked) return;
      if (cb.dataset.type === 'group') groups.push(Number(cb.dataset.groupId));
      else jobs.push(Number(cb.dataset.id));
    });
    try {
      await api(`/api/players/${p.id}/exclusions`, { method: 'PUT', body: { groups, jobs } });
    } catch (err) {
      msg('保存失败：' + err.message, 'error');
      await refreshState();
      return;
    }
  }
  // 刷新状态（同步职能复选框的准确状态）
  await refreshState();
  msg('排除规则已保存', 'success');
}

// ---------- 职业管理 ----------
function renderJobs() {
  const el = $('jobs-manage');
  el.innerHTML = state.groups
    .map((g) => {
      const jobsInGroup = state.jobs.filter((j) => j.group_id === g.id);
      if (!jobsInGroup.length) return '';
      const rows = jobsInGroup
        .map((j) => `
          <div class="job-row ${j.enabled ? '' : 'disabled'}">
            <button class="toggle ${j.enabled ? 'on' : ''}" onclick="toggleJob(${j.id})"></button>
            <input value="${esc(j.name)}" data-job="${j.id}" />
            <select data-job-select="${j.id}">
              ${state.groups.map((gg) => `<option value="${gg.id}" ${gg.id === j.group_id ? 'selected' : ''}>${esc(gg.name)}</option>`).join('')}
            </select>
            <button class="save" onclick="saveJob(${j.id})">保存</button>
            <button class="del" onclick="deleteJob(${j.id})">删除</button>
          </div>`)
        .join('');
      return `<div class="job-group"><h4>${esc(g.name)}</h4>${rows}</div>`;
    })
    .join('');
}

function refreshSelects() {
  $('new-job-group').innerHTML = state.groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  $('new-group-role').innerHTML = state.roles.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
}

async function toggleJob(id) {
  await api(`/api/jobs/${id}/toggle`, { method: 'PUT' });
  await refreshState();
}
window.toggleJob = toggleJob;

async function saveJob(id) {
  const name = document.querySelector(`input[data-job="${id}"]`).value.trim();
  const groupId = Number(document.querySelector(`select[data-job-select="${id}"]`).value);
  if (!name) return msg('职业名不能为空', 'error');
  await api(`/api/jobs/${id}`, { method: 'PUT', body: { name, group_id: groupId } });
  await refreshState();
  msg('已保存', 'success');
}
window.saveJob = saveJob;

async function deleteJob(id) {
  if (!confirm('删除该职业？')) return;
  await api(`/api/jobs/${id}`, { method: 'DELETE' });
  await refreshState();
}
window.deleteJob = deleteJob;

$('add-job').addEventListener('click', async () => {
  const name = $('new-job-name').value.trim();
  const groupId = Number($('new-job-group').value);
  if (!name) return msg('请输入职业名', 'error');
  await api('/api/jobs', { method: 'POST', body: { name, group_id: groupId } });
  $('new-job-name').value = '';
  await refreshState();
  msg('已添加', 'success');
});

// ---------- 组别管理 ----------
function renderGroups() {
  const el = $('groups-manage');
  el.innerHTML = state.groups
    .map((g) => {
      const role = state.roles.find((r) => r.id === g.role_id);
      return `
        <div class="player-row">
          <input value="${esc(g.name)}" data-group="${g.id}" />
          <select data-group-role="${g.id}">
            ${state.roles.map((r) => `<option value="${r.id}" ${r.id === g.role_id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
          </select>
          <button class="save" onclick="saveGroup(${g.id})">保存</button>
          <button class="del" onclick="deleteGroup(${g.id})">删除</button>
        </div>`;
    })
    .join('');
}

async function saveGroup(id) {
  const name = document.querySelector(`input[data-group="${id}"]`).value.trim();
  const roleId = Number(document.querySelector(`select[data-group-role="${id}"]`).value);
  if (!name) return msg('组别名不能为空', 'error');
  await api(`/api/groups/${id}`, { method: 'PUT', body: { name, role_id: roleId } });
  await refreshState();
  msg('已保存', 'success');
}
window.saveGroup = saveGroup;

async function deleteGroup(id) {
  if (!confirm('删除该组别？组内不能有职业。')) return;
  try {
    await api(`/api/groups/${id}`, { method: 'DELETE' });
    await refreshState();
    msg('已删除', 'success');
  } catch (e) {
    msg(e.message, 'error');
  }
}
window.deleteGroup = deleteGroup;

$('add-group').addEventListener('click', async () => {
  const name = $('new-group-name').value.trim();
  const roleId = Number($('new-group-role').value);
  if (!name) return msg('请输入组别名', 'error');
  await api('/api/groups', { method: 'POST', body: { name, role_id: roleId } });
  $('new-group-name').value = '';
  await refreshState();
  msg('已添加', 'success');
});

// ---------- 副本管理 ----------
function renderDungeons() {
  const el = $('dungeons-manage');
  el.innerHTML = state.dungeons
    .map((d) => `
      <div class="dungeon-row">
        <input class="name" value="${esc(d.name)}" data-dungeon-name="${d.id}" />
        <label>防护</label>
        <input type="number" value="${d.tank_count}" min="0" data-dungeon-tank="${d.id}" />
        <label>治疗</label>
        <input type="number" value="${d.healer_count}" min="0" data-dungeon-healer="${d.id}" />
        <label>进攻</label>
        <input type="number" value="${d.dps_count}" min="0" data-dungeon-dps="${d.id}" />
        <button class="save" onclick="saveDungeon(${d.id})">保存</button>
        <button class="del" onclick="deleteDungeon(${d.id})">删除</button>
      </div>`)
    .join('');
}

async function saveDungeon(id) {
  const name = document.querySelector(`input[data-dungeon-name="${id}"]`).value.trim();
  const tank = Number(document.querySelector(`input[data-dungeon-tank="${id}"]`).value);
  const healer = Number(document.querySelector(`input[data-dungeon-healer="${id}"]`).value);
  const dps = Number(document.querySelector(`input[data-dungeon-dps="${id}"]`).value);
  if (!name) return msg('副本名不能为空', 'error');
  await api(`/api/dungeons/${id}`, { method: 'PUT', body: { name, tank_count: tank, healer_count: healer, dps_count: dps } });
  await refreshState();
  msg('已保存', 'success');
}
window.saveDungeon = saveDungeon;

async function deleteDungeon(id) {
  if (!confirm('删除该副本？')) return;
  await api(`/api/dungeons/${id}`, { method: 'DELETE' });
  await refreshState();
  msg('已删除', 'success');
}
window.deleteDungeon = deleteDungeon;

$('add-dungeon').addEventListener('click', async () => {
  const name = $('new-dungeon-name').value.trim();
  const tank = Number($('new-dungeon-tank').value) || 0;
  const healer = Number($('new-dungeon-healer').value) || 0;
  const dps = Number($('new-dungeon-dps').value) || 0;
  if (!name) return msg('请输入副本名', 'error');
  await api('/api/dungeons', { method: 'POST', body: { name, tank_count: tank, healer_count: healer, dps_count: dps } });
  $('new-dungeon-name').value = '';
  $('new-dungeon-tank').value = '';
  $('new-dungeon-healer').value = '';
  $('new-dungeon-dps').value = '';
  await refreshState();
  msg('已添加', 'success');
});

// ---------- 联动规则 ----------
function renderLinkageRules() {
  const el = $('linkage-area');
  if (!state.linkageRules || state.linkageRules.length === 0) {
    el.innerHTML = '<div class="hint" style="margin:0;">暂无联动规则</div>';
    return;
  }
  const pName = (id) => (state.players.find((p) => p.id === id) || {}).name || '?';
  const roleName = (id) => (state.roles.find((r) => r.id === id) || {}).name || '?';
  const dName = (id) => id ? (state.dungeons.find((d) => d.id === id) || {}).name || '?' : '全局';
  el.innerHTML = state.linkageRules
    .map((r) => `
      <div class="linkage-row ${r.enabled ? '' : 'disabled'}">
        <button class="toggle ${r.enabled ? 'on' : ''}" onclick="toggleLinkage(${r.id})"></button>
        <span class="desc">
          <b>${esc(pName(r.source_player))}</b> 抽到 <b>${esc(roleName(r.trigger_group))}</b>
          <span class="arrow">→</span>
          <b>${esc(pName(r.target_player))}</b> 排除 <b>${esc(roleName(r.target_group))}</b>
          <small style="opacity:0.6;">（${esc(dName(r.dungeon_id))}）</small>
        </span>
        <button class="del-link" onclick="deleteLinkage(${r.id})">删除</button>
      </div>`)
    .join('');
}

function refreshLinkageSelects() {
  const opts = (items, labelFn) =>
    '<option value="">' + (labelFn || '选择') + '</option>' +
    items.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
  $('link-source-player').innerHTML = opts(state.players, '触发玩家');
  $('link-target-player').innerHTML = opts(state.players, '目标玩家');
  $('link-trigger-role').innerHTML = opts(state.roles, '触发职能');
  $('link-target-role').innerHTML = opts(state.roles, '目标职能');
  // 空值 = 全局规则（dungeon_id 为 NULL，对所有副本生效）
  $('link-dungeon').innerHTML =
    '<option value="">全局（所有副本）</option>' +
    state.dungeons.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
}

async function toggleLinkage(id) {
  await api(`/api/linkage-rules/${id}/toggle`, { method: 'PUT' });
  await refreshState();
}
window.toggleLinkage = toggleLinkage;

async function deleteLinkage(id) {
  if (!confirm('删除这条联动规则吗？')) return;
  await api(`/api/linkage-rules/${id}`, { method: 'DELETE' });
  await refreshState();
}
window.deleteLinkage = deleteLinkage;

async function addLinkage() {
  const sp = Number($('link-source-player').value);
  const tg = Number($('link-trigger-role').value);
  const tp = Number($('link-target-player').value);
  const tgr = Number($('link-target-role').value);
  const dung = $('link-dungeon').value ? Number($('link-dungeon').value) : null;
  if (!sp || !tg || !tp || !tgr) return msg('请完整选择四项', 'error');
  try {
    await api('/api/linkage-rules', { method: 'POST', body: { source_player: sp, trigger_group: tg, target_player: tp, target_group: tgr, dungeon_id: dung } });
    refreshLinkageSelects();
    await refreshState();
    msg('已添加联动规则', 'success');
  } catch (e) { msg(e.message, 'error'); }
}

// ---------- 辅助 ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let msgTimer = null;
function msg(text, type) {
  const m = $('message');
  // 清除之前的定时器
  if (msgTimer) { clearTimeout(msgTimer); msgTimer = null; }
  // Apple: enter animation
  m.textContent = text;
  m.className = 'message msg-enter ' + (type || '');
  // 2.5秒后退出动画
  msgTimer = setTimeout(() => {
    m.classList.remove('msg-enter');
    m.classList.add('msg-exit');
    setTimeout(() => {
      if (m.classList.contains('msg-exit')) {
        m.textContent = '';
        m.className = 'message';
      }
    }, 150);
  }, 2500);
}

// ---------- 事件 ----------
$('random-btn').addEventListener('click', doRandom);

// 副本选择按钮 - 使用事件委托，只绑定一次，无论按钮如何重新渲染都能工作
$('dungeon-buttons').addEventListener('click', (e) => {
  const btn = e.target.closest('.dungeon-btn');
  if (!btn) return;
  const dungeonId = Number(btn.dataset.id);
  selectedDungeon = state.dungeons.find((d) => d.id === dungeonId);
  renderDungeonSelector();
});

$('toggle-settings').addEventListener('click', () => {
  const body = $('settings-body');
  const btn = $('toggle-settings');
  const opening = !body.classList.contains('open');
  btn.setAttribute('aria-expanded', String(opening));

  if (opening) {
    // 展开：目标高度 = 实际内容高度（从当前呈现值平滑过渡），结束后解除限制
    body.style.maxHeight = body.scrollHeight + 'px';
    body.classList.add('open');
    body.addEventListener('transitionend', function handler(e) {
      if (e.propertyName !== 'max-height') return;
      body.removeEventListener('transitionend', handler);
      // 若在动画期间又被收起，则不解除限制
      if (body.classList.contains('open')) body.style.maxHeight = 'none';
    });
  } else {
    // 收起：从当前呈现值开始（兼容动画中途打断），强制回流后归零
    const cur = parseFloat(getComputedStyle(body).maxHeight);
    body.style.maxHeight = (isNaN(cur) ? body.scrollHeight : cur) + 'px';
    void body.offsetHeight;
    body.classList.remove('open');
    body.style.maxHeight = '0px';
  }
});

$('add-linkage').addEventListener('click', addLinkage);

init();

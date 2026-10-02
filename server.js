const express = require('express');
const path = require('path');
const os = require('os');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
// 默认监听所有网卡供局域网访问；仅本机使用时可 HOST=127.0.0.1 启动
const HOST = process.env.HOST || '0.0.0.0';
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 状态 ----------
function buildState() {
  const roles = db.prepare('SELECT id, name, sort_order FROM roles ORDER BY sort_order').all();
  const groups = db.prepare('SELECT id, name, role_id, sort_order FROM groups ORDER BY sort_order, id').all();
  const jobs = db.prepare(
    `SELECT j.id, j.name, j.group_id, j.enabled, j.sort_order, g.name AS group_name, g.role_id
     FROM jobs j JOIN groups g ON j.group_id = g.id
     ORDER BY g.sort_order, j.sort_order, j.id`
  ).all();
  const dungeons = db.prepare('SELECT * FROM dungeons ORDER BY sort_order, id').all();
  const players = db.prepare('SELECT id, name FROM players ORDER BY id').all();
  const exclusions = db.prepare('SELECT id, player_id, exclude_type, target_id FROM player_exclusions ORDER BY id').all();
  const linkageRules = db.prepare('SELECT id, source_player, trigger_group, target_player, target_group, dungeon_id, enabled FROM linkage_rules ORDER BY id').all();
  return { roles, groups, jobs, dungeons, players, exclusions, linkageRules };
}

// ---------- 候选职业池（按角色过滤 + 排除规则） ----------
function candidateJobsForSlot(playerId, roleId) {
  // 该角色下所有启用的职业
  const jobs = db.prepare(
    `SELECT j.id, j.name, j.group_id
     FROM jobs j JOIN groups g ON j.group_id = g.id
     WHERE g.role_id = ? AND j.enabled = 1`
  ).all(roleId);

  const exclGroups = db.prepare("SELECT target_id FROM player_exclusions WHERE player_id = ? AND exclude_type = 'group'")
    .all(playerId).map(r => r.target_id);
  const exclJobs = db.prepare("SELECT target_id FROM player_exclusions WHERE player_id = ? AND exclude_type = 'job'")
    .all(playerId).map(r => r.target_id);

  return jobs.filter(j => !exclGroups.includes(j.group_id) && !exclJobs.includes(j.id));
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- 防护/治疗职业：最近 N 次回避 + recency 加权 ----------
// 进攻职业不使用此逻辑（例如玩家2 的进攻池只有机工士，保持原行为）。
const SOFT_AVOID_WINDOW = 3;

// 按「玩家:职能」回放全部历史，得到每个玩家在各职能下的职业抽取序列（旧→新）。
function buildRoleHistories() {
  const map = new Map();
  const rows = db.prepare('SELECT snapshot FROM history ORDER BY id ASC').all();
  for (const row of rows) {
    let snap;
    try { snap = JSON.parse(row.snapshot); } catch (e) { continue; }
    if (!Array.isArray(snap)) continue;
    for (const r of snap) {
      if (!r || r.player_id == null || r.role_id == null || r.job_id == null) continue;
      const key = `${r.player_id}:${r.role_id}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r.job_id);
    }
  }
  return map;
}

function pickWeighted(items, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i];
    if (roll < 0) return items[i];
  }
  return items[items.length - 1];
}

// 硬约束：回避该玩家同职能下最近 SOFT_AVOID_WINDOW 次抽到的职业，池空则逐级放宽窗口。
// 软偏好：越久没抽到的职业权重越高（weight = 1 + gap）。
function pickSoftRoleJob(pool, seq) {
  for (let window = SOFT_AVOID_WINDOW; window >= 0; window--) {
    const banned = new Set(window === 0 ? [] : seq.slice(-window));
    const filtered = pool.filter((j) => !banned.has(j.id));
    if (filtered.length === 0) continue;

    const n = seq.length;
    const weights = filtered.map((j) => {
      const lastIdx = seq.lastIndexOf(j.id);
      const gap = lastIdx === -1 ? n + 1 : n - 1 - lastIdx;
      return 1 + gap;
    });
    return pickWeighted(filtered, weights);
  }
  return null;
}

// ---------- API: 状态 ----------
app.get('/api/state', (req, res) => res.json(buildState()));

// ---------- API: 随机生成（核心） ----------
app.post('/api/random', (req, res) => {
  const { dungeonId } = req.body;
  if (!dungeonId) return res.status(400).json({ error: '请选择副本类型' });

  const dungeon = db.prepare('SELECT * FROM dungeons WHERE id = ?').get(dungeonId);
  if (!dungeon) return res.status(404).json({ error: '副本不存在' });

  const players = db.prepare('SELECT id, name FROM players ORDER BY id').all();
  const roles = db.prepare('SELECT id, name FROM roles ORDER BY sort_order').all();
  const tankRole = roles.find(r => r.name === '防护');
  const healerRole = roles.find(r => r.name === '治疗');
  const dpsRole = roles.find(r => r.name === '进攻');

  if (!tankRole || !healerRole || !dpsRole) {
    return res.status(500).json({ error: '角色表数据异常' });
  }
  const softRoleIds = new Set([tankRole.id, healerRole.id]);
  const roleHistories = buildRoleHistories();

  // 生成槽位序列：如 [防护, 治疗, 进攻, 进攻]
  const slots = [
    ...Array(dungeon.tank_count).fill(tankRole),
    ...Array(dungeon.healer_count).fill(healerRole),
    ...Array(dungeon.dps_count).fill(dpsRole),
  ];

  if (players.length > slots.length) {
    return res.status(400).json({ error: `玩家数(${players.length})超出副本槽位数(${slots.length})，请增玩家或换副本` });
  }

  // 查询联动规则：当前副本生效的 + 全局规则（dungeon_id IS NULL）
  const linkageRules = db.prepare(
    `SELECT source_player, trigger_group, target_player, target_group FROM linkage_rules
     WHERE enabled = 1 AND (dungeon_id = ? OR dungeon_id IS NULL)`
  ).all(dungeonId);

  // 查询每个玩家上一次抽到的职业和职能（避免连续重复）
  const lastJobs = {};
  const lastRoles = {};
  const lastHistory = db.prepare('SELECT snapshot FROM history ORDER BY id DESC LIMIT 1').get();
  if (lastHistory) {
    try {
      const snap = JSON.parse(lastHistory.snapshot);
      snap.forEach((r) => { lastJobs[r.player_id] = r.job_id; lastRoles[r.player_id] = r.role_id; });
    } catch (e) { /* ignore */ }
  }

  // ---------- 随机分配：回溯搜索（约束满足） ----------
  // 先枚举所有合法的「玩家→职能」分配，再随机选一组。
  // 与旧的「打乱 + 贪心 + 重试 20 次」相比：只要存在合法分配就一定能找到，
  // 不会因为前面的玩家抢走关键职能而误报“无法分配”。
  const roleCap = new Map();
  for (const s of slots) roleCap.set(s.id, (roleCap.get(s.id) || 0) + 1);

  // 联动规则（保持原语义）：source 抽到 trigger 职能时，target 不能抽 target 职能。
  // 原实现只按分配顺序单向检查，这里改为双向检查，结果与顺序无关。
  function linkageConflict(partial, playerId, roleId) {
    for (const rule of linkageRules) {
      if (rule.target_player === playerId && rule.target_group === roleId) {
        const srcRole = partial.get(rule.source_player);
        if (srcRole !== undefined && srcRole === rule.trigger_group) return true;
      }
      if (rule.source_player === playerId && rule.trigger_group === roleId) {
        const tgtRole = partial.get(rule.target_player);
        if (tgtRole !== undefined && tgtRole === rule.target_group) return true;
      }
    }
    return false;
  }

  // 回溯枚举合法分配（封顶 MAX_SOLUTIONS，防止极端配置下组合爆炸）
  const MAX_SOLUTIONS = 500;
  const solutions = [];
  const assign = new Map();
  const playerOrder = shuffle(players);

  (function backtrack(depth) {
    if (solutions.length >= MAX_SOLUTIONS) return;
    if (depth === playerOrder.length) {
      solutions.push(new Map(assign));
      return;
    }
    const player = playerOrder[depth];
    for (const [roleId, remaining] of roleCap) {
      if (remaining <= 0) continue;
      if (candidateJobsForSlot(player.id, roleId).length === 0) continue;
      if (linkageConflict(assign, player.id, roleId)) continue;
      assign.set(player.id, roleId);
      roleCap.set(roleId, remaining - 1);
      backtrack(depth + 1);
      roleCap.set(roleId, remaining);
      assign.delete(player.id);
    }
  })(0);

  if (solutions.length === 0) {
    return res.status(400).json({
      error: '无法为所有玩家分配合适职能，请调整排除规则或换副本',
    });
  }

  // 在合法分配中随机选一组，再按职能抽取职业
  const chosenAssign = pickRandom(solutions);
  const results = [];
  for (const player of players) {
    const role = roles.find((r) => r.id === chosenAssign.get(player.id));
    const pool = candidateJobsForSlot(player.id, role.id);

    let choice;
    if (softRoleIds.has(role.id)) {
      // 防护/治疗：最近 3 次回避（自动放宽）+ 越久没抽到权重越高
      const seq = roleHistories.get(`${player.id}:${role.id}`) || [];
      choice = pickSoftRoleJob(pool, seq);
    } else {
      // 进攻：沿用原有逻辑——排除上次抽到的职业（候选池太小时不排除），均匀随机
      const playerLastJob = lastJobs[player.id];
      const attackPool = (playerLastJob && pool.length > 1)
        ? pool.filter((j) => j.id !== playerLastJob)
        : pool;
      choice = pickRandom(attackPool);
    }
    if (!choice) {
      return res.status(400).json({ error: '无法为玩家分配职业，请调整排除规则' });
    }
    results.push({
      player_id: player.id,
      player_name: player.name,
      role_id: role.id,
      role_name: role.name,
      job_id: choice.id,
      job_name: choice.name,
    });
  }

  // 按玩家ID排序，确保显示顺序固定（玩家1在前）
  results.sort((a, b) => a.player_id - b.player_id);

  // 保存历史
  const now = new Date().toISOString();
  const snapshot = JSON.stringify(results);
  const info = db.prepare('INSERT INTO history (created_at, dungeon, snapshot) VALUES (?, ?, ?)').run(now, dungeon.name, snapshot);

  res.json({
    id: info.lastInsertRowid,
    created_at: now,
    dungeon: dungeon.name,
    results,
  });
});

// ---------- API: 历史 ----------
app.get('/api/history', (req, res) => {
  res.json(
    db.prepare('SELECT id, created_at, dungeon, snapshot FROM history ORDER BY id DESC LIMIT 200').all()
  );
});

app.delete('/api/history/:id', (req, res) => {
  db.prepare('DELETE FROM history WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.delete('/api/history', (req, res) => {
  db.prepare('DELETE FROM history').run();
  res.json({ ok: true });
});

// ---------- API: 副本 ----------
// 槽位数统一收敛为 >=0 的整数，防止 NaN/负数导致随机接口崩溃
function sanitizeCount(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

app.post('/api/dungeons', (req, res) => {
  const { name, tank_count, healer_count, dps_count } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '副本名不能为空' });
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM dungeons').get().m;
  try {
    const info = db.prepare('INSERT INTO dungeons (name, tank_count, healer_count, dps_count, sort_order) VALUES (?, ?, ?, ?, ?)')
      .run(name.trim(), sanitizeCount(tank_count), sanitizeCount(healer_count), sanitizeCount(dps_count), max + 1);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: '同名副本已存在' });
    return res.status(400).json({ error: e.message });
  }
});

app.put('/api/dungeons/:id', (req, res) => {
  const { name, tank_count, healer_count, dps_count } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '副本名不能为空' });
  db.prepare('UPDATE dungeons SET name=?, tank_count=?, healer_count=?, dps_count=? WHERE id=?')
    .run(name.trim(), sanitizeCount(tank_count), sanitizeCount(healer_count), sanitizeCount(dps_count), Number(req.params.id));
  res.json({ ok: true });
});

app.delete('/api/dungeons/:id', (req, res) => {
  const id = Number(req.params.id);
  db.transaction(() => {
    // 顺带清理绑定在该副本上的联动规则，避免留下永不生效的死规则
    db.prepare('DELETE FROM linkage_rules WHERE dungeon_id = ?').run(id);
    db.prepare('DELETE FROM dungeons WHERE id = ?').run(id);
  })();
  res.json({ ok: true });
});

// ---------- API: 玩家 ----------
app.post('/api/players', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '玩家名不能为空' });
  const info = db.prepare('INSERT INTO players (name) VALUES (?)').run(name.trim());
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/players/:id', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '玩家名不能为空' });
  db.prepare('UPDATE players SET name = ? WHERE id = ?').run(name.trim(), Number(req.params.id));
  res.json({ ok: true });
});

app.delete('/api/players/:id', (req, res) => {
  const id = Number(req.params.id);
  db.transaction(() => {
    db.prepare('DELETE FROM player_exclusions WHERE player_id = ?').run(id);
    // 清理该玩家相关的联动规则，避免孤儿规则
    db.prepare('DELETE FROM linkage_rules WHERE source_player = ? OR target_player = ?').run(id, id);
    db.prepare('DELETE FROM players WHERE id = ?').run(id);
  })();
  res.json({ ok: true });
});

// ---------- API: 组别 / 职业 ----------
app.post('/api/groups', (req, res) => {
  const { name, role_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '组别名不能为空' });
  if (!role_id) return res.status(400).json({ error: '必须选择职能' });
  try {
    const info = db.prepare('INSERT INTO groups (name, role_id, sort_order) VALUES (?, ?, ?)')
      .run(name.trim(), Number(role_id), Date.now());
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: '同名组别已存在' });
    return res.status(400).json({ error: e.message });
  }
});

app.put('/api/groups/:id', (req, res) => {
  const { name, role_id } = req.body;
  db.prepare('UPDATE groups SET name = ?, role_id = ? WHERE id = ?').run(name.trim(), Number(role_id), Number(req.params.id));
  res.json({ ok: true });
});

app.delete('/api/groups/:id', (req, res) => {
  const c = db.prepare('SELECT COUNT(*) AS c FROM jobs WHERE group_id = ?').get(Number(req.params.id)).c;
  if (c > 0) return res.status(400).json({ error: `组内还有 ${c} 个职业，请先移除` });
  db.prepare('DELETE FROM groups WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/jobs', (req, res) => {
  const { name, group_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '职业名不能为空' });
  if (!group_id) return res.status(400).json({ error: '必须选择组别' });
  try {
    const info = db.prepare('INSERT INTO jobs (name, group_id, enabled, sort_order) VALUES (?, ?, 1, ?)')
      .run(name.trim(), Number(group_id), Date.now());
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: '该组别下已有同名职业' });
    return res.status(400).json({ error: e.message });
  }
});

app.put('/api/jobs/:id', (req, res) => {
  const { name, group_id } = req.body;
  db.prepare('UPDATE jobs SET name = ?, group_id = ? WHERE id = ?').run(name.trim(), Number(group_id), Number(req.params.id));
  res.json({ ok: true });
});

app.put('/api/jobs/:id/toggle', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT enabled FROM jobs WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: '职业不存在' });
  db.prepare('UPDATE jobs SET enabled = ? WHERE id = ?').run(cur.enabled ? 0 : 1, id);
  res.json({ ok: true, enabled: cur.enabled ? 0 : 1 });
});

app.delete('/api/jobs/:id', (req, res) => {
  const id = Number(req.params.id);
  db.transaction(() => {
    db.prepare("DELETE FROM player_exclusions WHERE exclude_type = 'job' AND target_id = ?").run(id);
    db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  })();
  res.json({ ok: true });
});

// ---------- API: 排除规则 ----------
app.put('/api/players/:id/exclusions', (req, res) => {
  const playerId = Number(req.params.id);
  const { groups = [], jobs = [] } = req.body;
  const insert = db.prepare('INSERT OR IGNORE INTO player_exclusions (player_id, exclude_type, target_id) VALUES (?, ?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM player_exclusions WHERE player_id = ?').run(playerId);
    groups.forEach(g => insert.run(playerId, 'group', Number(g)));
    jobs.forEach(j => insert.run(playerId, 'job', Number(j)));
  })();
  res.json({ ok: true });
});

// ---------- API: 联动规则 ----------
app.post('/api/linkage-rules', (req, res) => {
  const { source_player, trigger_group, target_player, target_group, dungeon_id } = req.body;
  const sp = Number(source_player), tp = Number(target_player), tg = Number(trigger_group), tgr = Number(target_group);
  if (!sp || !tp || !tg || !tgr) return res.status(400).json({ error: '联动规则字段不完整' });
  try {
    const info = db.prepare(
      'INSERT INTO linkage_rules (source_player, trigger_group, target_player, target_group, dungeon_id, enabled) VALUES (?, ?, ?, ?, ?, 1)'
    ).run(sp, tg, tp, tgr, dungeon_id ? Number(dungeon_id) : null);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: '该联动规则已存在' });
    return res.status(400).json({ error: e.message });
  }
});

app.put('/api/linkage-rules/:id/toggle', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT enabled FROM linkage_rules WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: '规则不存在' });
  db.prepare('UPDATE linkage_rules SET enabled = ? WHERE id = ?').run(cur.enabled ? 0 : 1, id);
  res.json({ ok: true, enabled: cur.enabled ? 0 : 1 });
});

app.delete('/api/linkage-rules/:id', (req, res) => {
  db.prepare('DELETE FROM linkage_rules WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- 启动 ----------
app.listen(PORT, HOST, () => {
  const lanIp = getLanIp();
  console.log('========================================');
  console.log('  游戏职业随机选择器 v2 已启动');
  console.log('========================================');
  console.log(`本机访问:   http://localhost:${PORT}`);
  if (lanIp) console.log(`跨设备访问: http://${lanIp}:${PORT}`);
  console.log('----------------------------------------');
  console.log('按 Ctrl+C 停止服务');
});

function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

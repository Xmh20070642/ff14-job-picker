// 数据库初始化 + 种子数据 (v2)
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'jobs.db'));
db.pragma('journal_mode = WAL');
// 开启外键约束，让 schema 里声明的 ON DELETE CASCADE 真正生效
db.pragma('foreign_keys = ON');

// ---------- 建表 ----------
db.exec(`
  -- 职能（防护/治疗/进攻）
  CREATE TABLE IF NOT EXISTS roles (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  -- 组别（归属于某职能）
  CREATE TABLE IF NOT EXISTS groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    role_id    INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT
  );

  -- 职业
  CREATE TABLE IF NOT EXISTS jobs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    group_id   INTEGER NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE RESTRICT,
    UNIQUE (name, group_id)
  );

  -- 副本配置
  CREATE TABLE IF NOT EXISTS dungeons (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    tank_count  INTEGER NOT NULL DEFAULT 1,
    healer_count INTEGER NOT NULL DEFAULT 1,
    dps_count   INTEGER NOT NULL DEFAULT 2,
    sort_order  INTEGER NOT NULL DEFAULT 0
  );

  -- 玩家
  CREATE TABLE IF NOT EXISTS players (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL
  );

  -- 排除规则
  CREATE TABLE IF NOT EXISTS player_exclusions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id    INTEGER NOT NULL,
    exclude_type TEXT NOT NULL CHECK (exclude_type IN ('group', 'job')),
    target_id    INTEGER NOT NULL,
    UNIQUE (player_id, exclude_type, target_id),
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
  );

  -- 联动规则：当 source_player 抽到 trigger_group 时，
  -- target_player 排除 target_group（仅在指定副本中生效）
  CREATE TABLE IF NOT EXISTS linkage_rules (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    source_player  INTEGER NOT NULL,
    trigger_group  INTEGER NOT NULL,
    target_player  INTEGER NOT NULL,
    target_group   INTEGER NOT NULL,
    dungeon_id     INTEGER,                  -- NULL=所有副本生效，指定ID=仅该副本生效
    enabled        INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (source_player) REFERENCES players(id) ON DELETE CASCADE,
    FOREIGN KEY (target_player) REFERENCES players(id) ON DELETE CASCADE,
    UNIQUE (source_player, trigger_group, target_player, target_group, dungeon_id)
  );

  -- 历史
  CREATE TABLE IF NOT EXISTS history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    dungeon    TEXT NOT NULL,
    snapshot   TEXT NOT NULL   -- JSON: [{player, role, job}, ...]
  );
`);

// ---------- 种子数据 ----------
if (db.prepare('SELECT COUNT(*) AS c FROM roles').get().c === 0) {
  const ins = db.prepare('INSERT INTO roles (name, sort_order) VALUES (?, ?)');
  db.transaction(() => {
    ins.run('防护', 1);
    ins.run('治疗', 2);
    ins.run('进攻', 3);
  })();
}

if (db.prepare('SELECT COUNT(*) AS c FROM groups').get().c === 0) {
  const getRole = (n) => db.prepare('SELECT id FROM roles WHERE name = ?').get(n).id;
  const ins = db.prepare('INSERT INTO groups (name, role_id, sort_order) VALUES (?, ?, ?)');
  db.transaction(() => {
    const tank = getRole('防护'), heal = getRole('治疗'), dps = getRole('进攻');
    ins.run('防护职能', tank, 1);
    ins.run('治疗职能', heal, 2);
    ins.run('近战职能', dps, 3);
    ins.run('远程物理职能', dps, 4);
    ins.run('远程魔法职能', dps, 5);
  })();
}

if (db.prepare('SELECT COUNT(*) AS c FROM jobs').get().c === 0) {
  const getG = (n) => db.prepare('SELECT id FROM groups WHERE name = ?').get(n).id;
  const ins = db.prepare('INSERT INTO jobs (name, group_id, enabled, sort_order) VALUES (?, ?, 1, ?)');
  const seed = [
    ['防护职能', '战士'],
    ['防护职能', '骑士'],
    ['防护职能', '绝枪战士'],
    ['防护职能', '暗黑骑士'],
    ['治疗职能', '白魔法师'],
    ['治疗职能', '贤者'],
    ['治疗职能', '学者'],
    ['治疗职能', '占星术士'],
    ['近战职能', '武僧'],
    ['近战职能', '龙骑士'],
    ['近战职能', '忍者'],
    ['近战职能', '武士'],
    ['近战职能', '钐镰客'],
    ['近战职能', '蝰蛇剑士'],
    ['远程物理职能', '吟游诗人'],
    ['远程物理职能', '机工士'],
    ['远程物理职能', '舞者'],
    ['远程魔法职能', '黑魔法师'],
    ['远程魔法职能', '召唤师'],
    ['远程魔法职能', '赤魔法师'],
    ['远程魔法职能', '绘灵法师'],
  ];
  db.transaction(() => {
    seed.forEach(([g, j], i) => ins.run(j, getG(g), i + 1));
  })();
}

if (db.prepare('SELECT COUNT(*) AS c FROM dungeons').get().c === 0) {
  const ins = db.prepare('INSERT INTO dungeons (name, tank_count, healer_count, dps_count, sort_order) VALUES (?, ?, ?, ?, ?)');
  db.transaction(() => {
    ins.run('四人本', 1, 1, 2, 1);
    ins.run('八人本', 2, 2, 4, 2);
    ins.run('二十四人本', 1, 2, 5, 3);
  })();
}

if (db.prepare('SELECT COUNT(*) AS c FROM players').get().c === 0) {
  const ins = db.prepare('INSERT INTO players (name) VALUES (?)');
  db.transaction(() => {
    ins.run('玩家1');
    ins.run('玩家2');
  })();
}

// 玩家排除规则种子
if (db.prepare('SELECT COUNT(*) AS c FROM player_exclusions').get().c === 0) {
  const getP = (n) => db.prepare('SELECT id FROM players WHERE name = ?').get(n).id;
  const getG = (n) => db.prepare('SELECT id FROM groups WHERE name = ?').get(n).id;
  const getJ = (n) => db.prepare('SELECT id FROM jobs WHERE name = ?').get(n).id;
  const ins = db.prepare('INSERT INTO player_exclusions (player_id, exclude_type, target_id) VALUES (?, ?, ?)');
  db.transaction(() => {
    const p1 = getP('玩家1'), p2 = getP('玩家2');
    ins.run(p1, 'group', getG('治疗职能'));
    ins.run(p2, 'group', getG('近战职能'));
    ins.run(p2, 'group', getG('远程魔法职能'));
    ins.run(p2, 'job', getJ('吟游诗人'));
    ins.run(p2, 'job', getJ('舞者'));
  })();
}

// 联动规则种子（仅四人本生效）
if (db.prepare('SELECT COUNT(*) AS c FROM linkage_rules').get().c === 0) {
  const getP = (n) => db.prepare('SELECT id FROM players WHERE name = ?').get(n).id;
  const getG = (n) => db.prepare('SELECT id FROM groups WHERE name = ?').get(n).id;
  const getD = (n) => db.prepare('SELECT id FROM dungeons WHERE name = ?').get(n).id;
  const ins = db.prepare(
    'INSERT INTO linkage_rules (source_player, trigger_group, target_player, target_group, dungeon_id, enabled) VALUES (?, ?, ?, ?, ?, 1)'
  );
  const p1 = getP('玩家1'), p2 = getP('玩家2');
  const tankG = getG('防护职能'), healG = getG('治疗职能');
  const dung4 = getD('四人本');
  db.transaction(() => {
    // 玩家1抽到防护 → 玩家2排除防护（仅四人本）
    ins.run(p1, tankG, p2, tankG, dung4);
    // 玩家1抽到治疗 → 玩家2排除治疗（仅四人本）
    ins.run(p1, healG, p2, healG, dung4);
  })();
}

// ---------- 迁移：组名 xx职业 → xx职能 ----------
const RENAME_MAP = [
  ['防护职业', '防护职能'],
  ['治疗职业', '治疗职能'],
  ['近战职业', '近战职能'],
  ['远程物理职业', '远程物理职能'],
  ['远程魔法职业', '远程魔法职能'],
];
db.transaction(() => {
  for (const [oldName, newName] of RENAME_MAP) {
    db.prepare('UPDATE groups SET name = ? WHERE name = ?').run(newName, oldName);
  }
  // 副本名：阿拉伯数字 → 中文数字
  db.prepare("UPDATE dungeons SET name = '二十四人本' WHERE name = '24人本'").run();
})();

module.exports = db;

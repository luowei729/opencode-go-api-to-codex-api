/**
 * Docker 版数据库操作封装（better-sqlite3）
 * 
 * 功能：封装所有 SQLite 操作，供 server.js 和 proxy.js 调用
 * 原因：统一数据访问层，避免业务代码里散落裸 SQL，方便后续切换存储或添加缓存
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs'); // 用于确保 data 目录存在
const crypto = require('crypto');

/**
 * 获取数据库文件路径（持久化到项目根目录的 data/ 目录）
 * 原因：确保容器重启后数据不丢失
 * 修复：启动前自动创建 data/ 目录，避免非 Docker 环境下因目录不存在导致 SQLITE_CANTOPEN 崩溃
 */
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const DB_PATH = path.join(DATA_DIR, 'proxy.db');

/**
 * 初始化数据库连接并建表
 * 原因：启动时确保所有表存在，字段变更时可通过 ALTER TABLE 兼容
 */
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // WAL 模式提高并发读写性能

db.exec(`
  CREATE TABLE IF NOT EXISTS upstream_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL,
    name TEXT NOT NULL,
    weight INTEGER NOT NULL DEFAULT 1,
    upstream_url TEXT DEFAULT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    fail_count INTEGER NOT NULL DEFAULT 0,
    max_failures INTEGER NOT NULL DEFAULT 3,
    disabled_at TEXT DEFAULT NULL,
    priority INTEGER NOT NULL DEFAULT 5,
    usage_count INTEGER NOT NULL DEFAULT 0,
    check_interval_minutes INTEGER NOT NULL DEFAULT 5,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hour')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hour'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS local_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    total_requests INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    total_input_tokens INTEGER NOT NULL DEFAULT 0,
    total_output_tokens INTEGER NOT NULL DEFAULT 0,
    first_used_at TEXT DEFAULT NULL,
    last_used_at TEXT DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hour')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hour'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT NOT NULL DEFAULT (datetime('now', '+8 hour')),
    level TEXT DEFAULT 'info',
    type TEXT DEFAULT 'request',
    message TEXT DEFAULT '',
    method TEXT,
    path TEXT,
    model TEXT,
    resolved_model TEXT,
    api TEXT,
    stream INTEGER,
    status INTEGER,
    local_token_id INTEGER DEFAULT NULL,
    upstream_token_id INTEGER DEFAULT NULL,
    duration_ms INTEGER DEFAULT NULL,
    extra TEXT DEFAULT NULL
  )
`);

/**
 * 预编译语句（提高重复 SQL 执行性能）
 * 原因：更好的 SQLite 性能，防止 SQL 注入，代码更清晰
 */

// ---- upstream_tokens ----
const stmtInsertUpstream = db.prepare(
  `INSERT INTO upstream_tokens (token, name, weight, upstream_url, enabled, max_failures, priority, check_interval_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtGetAllUpstream = db.prepare(`SELECT * FROM upstream_tokens ORDER BY id`);
const stmtGetEnabledUpstream = db.prepare(`SELECT * FROM upstream_tokens WHERE enabled = 1 ORDER BY id`);
const stmtGetUpstreamById = db.prepare(`SELECT * FROM upstream_tokens WHERE id = ?`);
const stmtUpdateUpstream = db.prepare(
  `UPDATE upstream_tokens SET token = ?, name = ?, weight = ?, upstream_url = ?, max_failures = ?, priority = ?, check_interval_minutes = ?, enabled = ?, updated_at = datetime('now', '+8 hour') WHERE id = ?`
);
const stmtDisableUpstream = db.prepare(
  `UPDATE upstream_tokens SET enabled = 0, disabled_at = datetime('now', '+8 hour'), updated_at = datetime('now', '+8 hour') WHERE id = ?`
);
const stmtEnableUpstream = db.prepare(
  `UPDATE upstream_tokens SET enabled = 1, disabled_at = NULL, fail_count = 0, updated_at = datetime('now', '+8 hour') WHERE id = ?`
);
const stmtIncrementFail = db.prepare(
  `UPDATE upstream_tokens SET fail_count = fail_count + 1, updated_at = datetime('now', '+8 hour') WHERE id = ?`
);
const stmtResetFail = db.prepare(
  `UPDATE upstream_tokens SET fail_count = 0, updated_at = datetime('now', '+8 hour') WHERE id = ?`
);
const stmtIncrementUsage = db.prepare(
  `UPDATE upstream_tokens SET usage_count = usage_count + 1, updated_at = datetime('now', '+8 hour') WHERE id = ?`
);
const stmtDeleteUpstream = db.prepare(`DELETE FROM upstream_tokens WHERE id = ?`);
const stmtGetDisabledExpired = db.prepare(
  `SELECT * FROM upstream_tokens WHERE enabled = 0 AND disabled_at IS NOT NULL AND datetime(disabled_at, '+' || check_interval_minutes || ' minutes') <= datetime('now', '+8 hour') ORDER BY priority ASC, disabled_at ASC LIMIT 3`
);

// ---- local_tokens ----
const stmtInsertLocal = db.prepare(
  `INSERT INTO local_tokens (token, name) VALUES (?, ?)`
);
const stmtGetAllLocal = db.prepare(`SELECT * FROM local_tokens ORDER BY id`);
const stmtGetEnabledLocal = db.prepare(`SELECT * FROM local_tokens WHERE enabled = 1 ORDER BY id`);
const stmtGetLocalByToken = db.prepare(`SELECT * FROM local_tokens WHERE token = ?`);
const stmtGetLocalById = db.prepare(`SELECT * FROM local_tokens WHERE id = ?`);
const stmtUpdateLocal = db.prepare(
  `UPDATE local_tokens SET name = ?, enabled = ?, updated_at = datetime('now', '+8 hour') WHERE id = ?`
);
const stmtDisableLocal = db.prepare(
  `UPDATE local_tokens SET enabled = 0, updated_at = datetime('now', '+8 hour') WHERE id = ?`
);
const stmtEnableLocal = db.prepare(
  `UPDATE local_tokens SET enabled = 1, updated_at = datetime('now', '+8 hour') WHERE id = ?`
);
const stmtDeleteLocal = db.prepare(`DELETE FROM local_tokens WHERE id = ?`);
const stmtIncrementLocalRequest = db.prepare(
  `UPDATE local_tokens SET total_requests = total_requests + 1, updated_at = datetime('now', '+8 hour') WHERE id = ?`
);
// 注意：以下 stmtIncrementLocalSuccess 已废弃，不再使用
// 原因：其 WHERE 条件 first_used_at IS NULL 与 stmtSetFirstUsed 存在竞态冲突
// 统一使用 stmtIncrementLocalSuccessWithFirst（无条件版本）避免首次请求不递增的 bug
const stmtIncrementLocalSuccessWithFirst = db.prepare(
  `UPDATE local_tokens SET success_count = success_count + 1, total_requests = total_requests + 1,
   last_used_at = datetime('now', '+8 hour'), updated_at = datetime('now', '+8 hour') WHERE id = ?`
);
const stmtSetFirstUsed = db.prepare(
  `UPDATE local_tokens SET first_used_at = datetime('now', '+8 hour') WHERE id = ? AND first_used_at IS NULL`
);
const stmtIncrementLocalFail = db.prepare(
  `UPDATE local_tokens SET fail_count = fail_count + 1, total_requests = total_requests + 1,
   last_used_at = datetime('now', '+8 hour'), updated_at = datetime('now', '+8 hour') WHERE id = ?`
);
const stmtUpdateLocalUsage = db.prepare(
  `UPDATE local_tokens SET total_input_tokens = total_input_tokens + ?, total_output_tokens = total_output_tokens + ?, updated_at = datetime('now', '+8 hour') WHERE id = ?`
);

// ---- logs ----
const stmtInsertLog = db.prepare(
  `INSERT INTO logs (level, type, message, method, path, model, resolved_model, api, stream, status, local_token_id, upstream_token_id, duration_ms, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtGetLogsRecent = db.prepare(`SELECT * FROM logs ORDER BY id DESC LIMIT ?`);
const stmtGetLogsSince = db.prepare(`SELECT * FROM logs WHERE id > ? ORDER BY id ASC LIMIT 100`);
const stmtGetLogCount = db.prepare(`SELECT COUNT(*) as cnt FROM logs`);
const stmtDeleteOldLogs = db.prepare(`DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 200)`);
const stmtClearLogs = db.prepare(`DELETE FROM logs`);

// ---- 工具函数：生成随机 Token ----
/**
 * 生成随机访问 Token（格式：lt_ + 32位十六进制）
 * 原因：和上游 Token 区分，且足够随机避免碰撞
 */
function generateLocalToken() {
  return 'lt_' + crypto.randomBytes(16).toString('hex');
}

/**
 * 生成随机上游 Token（格式：ut_ + 32位十六进制）
 * 原因：每次新建上游 Token 时自动生成一个占位值，实际使用时由管理员替换为真实上游 Token
 */
function generateUpstreamToken() {
  return 'ut_' + crypto.randomBytes(16).toString('hex');
}

// ============================
// upstream_tokens CRUD
// ============================

/**
 * 创建上游 Token
 * @param {Object} params - { token, name, weight, upstream_url, max_failures, priority, check_interval_minutes, enabled }
 * @returns {Object} 新创建的记录（含 id）
 */
function createUpstreamToken(params) {
  const {
    token, name, weight = 1, upstream_url = null,
    max_failures = 3, priority = 5, check_interval_minutes = 5, enabled = 1
  } = params;
  const result = stmtInsertUpstream.run(token, name, weight, upstream_url, enabled, max_failures, priority, check_interval_minutes);
  return getUpstreamTokenById(result.lastInsertRowid);
}

/**
 * 获取所有上游 Token
 */
function getAllUpstreamTokens() {
  return stmtGetAllUpstream.all();
}

/**
 * 获取所有启用的上游 Token（用于负载均衡选择）
 */
function getEnabledUpstreamTokens() {
  return stmtGetEnabledUpstream.all();
}

/**
 * 按 ID 获取上游 Token
 */
function getUpstreamTokenById(id) {
  return stmtGetUpstreamById.get(id);
}

/**
 * 更新上游 Token（需要传入 id）
 */
function updateUpstreamToken(id, params) {
  const {
    token, name, weight, upstream_url,
    max_failures, priority, check_interval_minutes, enabled
  } = params;
  stmtUpdateUpstream.run(token, name, weight, upstream_url || null, max_failures, priority, check_interval_minutes, enabled, id);
  return getUpstreamTokenById(id);
}

/**
 * 禁用上游 Token（记录禁用时间）
 */
function disableUpstreamToken(id) {
  stmtDisableUpstream.run(id);
  return getUpstreamTokenById(id);
}

/**
 * 启用上游 Token（重置失败计数）
 */
function enableUpstreamToken(id) {
  stmtEnableUpstream.run(id);
  return getUpstreamTokenById(id);
}

/**
 * 增加失败计数，判断是否需要自动禁用
 * 返回：更新后的记录，以及 isNowDisabled 标记
 */
function incrementUpstreamFail(id) {
  const before = getUpstreamTokenById(id);
  if (!before) return null;
  stmtIncrementFail.run(id);
  const after = getUpstreamTokenById(id);
  if (after && after.fail_count >= after.max_failures && before.enabled) {
    disableUpstreamToken(id);
    return { ...after, autoDisabled: true };
  }
  return { ...after, autoDisabled: false };
}

/**
 * 重置失败计数（请求成功时调用）
 */
function resetUpstreamFail(id) {
  stmtResetFail.run(id);
  return getUpstreamTokenById(id);
}

/**
 * 增加使用计数（负载均衡 weighting 算法的分子）
 */
function incrementUpstreamUsage(id) {
  stmtIncrementUsage.run(id);
  return getUpstreamTokenById(id);
}

/**
 * 删除上游 Token
 */
function deleteUpstreamToken(id) {
  stmtDeleteUpstream.run(id);
  return true;
}

/**
 * 获取需要检查的禁用 Token 列表（最多 3 个）
 */
function getExpiredDisabledTokens() {
  return stmtGetDisabledExpired.all();
}

// ============================
// local_tokens CRUD
// ============================

/**
 * 创建本地 Token（自动生成随机 token 值）
 * @param {Object} params - { name, token?(可选) }
 * @returns {Object} 新创建的记录
 */
function createLocalToken(params) {
  const { name, token = null } = params;
  const finalToken = token || generateLocalToken();
  try {
    const result = stmtInsertLocal.run(finalToken, name);
    return getLocalTokenById(result.lastInsertRowid);
  } catch (err) {
    // 如果 token 冲突（UNIQUE 约束），自动重新生成一个
    if (err.message && err.message.includes('UNIQUE')) {
      if (token) throw new Error('Token 值冲突，请使用其他值');
      return createLocalToken({ name }); // 递归重试
    }
    throw err;
  }
}

/**
 * 获取所有本地 Token
 */
function getAllLocalTokens() {
  return stmtGetAllLocal.all();
}

/**
 * 获取启用的本地 Token
 */
function getEnabledLocalTokens() {
  return stmtGetEnabledLocal.all();
}

/**
 * 按 Token 值查找（用于认证时查找）
 */
function getLocalTokenByValue(tokenValue) {
  return stmtGetLocalByToken.get(tokenValue);
}

/**
 * 按 ID 获取本地 Token
 */
function getLocalTokenById(id) {
  return stmtGetLocalById.get(id);
}

/**
 * 更新本地 Token 信息（名称、启用状态）
 */
function updateLocalToken(id, params) {
  const { name, enabled } = params;
  stmtUpdateLocal.run(name, enabled, id);
  return getLocalTokenById(id);
}

/**
 * 禁用本地 Token
 */
function disableLocalToken(id) {
  stmtDisableLocal.run(id);
  return getLocalTokenById(id);
}

/**
 * 启用本地 Token
 */
function enableLocalToken(id) {
  stmtEnableLocal.run(id);
  return getLocalTokenById(id);
}

/**
 * 删除本地 Token
 */
function deleteLocalToken(id) {
  stmtDeleteLocal.run(id);
  return true;
}

// ============================
// 使用统计
// ============================

/**
 * 记录本地 Token 的请求成功（含首次使用时间处理）
 * 原因：首次使用时需要设置 first_used_at，后续请求直接更新 last_used_at
 * 修复：先设置 first_used_at，然后统一使用无条件更新语句，避免过期变量导致分支错误
 */
function recordLocalSuccess(id) {
  const token = getLocalTokenById(id);
  if (!token) return null;
  // 首次使用时设置 first_used_at（SQL WHERE 条件保证幂等）
  if (!token.first_used_at) {
    stmtSetFirstUsed.run(id);
  }
  // 统一使用无条件更新语句（stmtIncrementLocalSuccessWithFirst 无 first_used_at WHERE 条件）
  // 原因：stmtIncrementLocalSuccess 有 WHERE first_used_at IS NULL 条件，但上面已设置了 first_used_at，会导致不匹配
  stmtIncrementLocalSuccessWithFirst.run(id);
  return getLocalTokenById(id);
}

/**
 * 记录本地 Token 的请求失败
 */
function recordLocalFail(id) {
  const token = getLocalTokenById(id);
  if (!token) return null;
  stmtIncrementLocalFail.run(id);
  return getLocalTokenById(id);
}

/**
 * 更新本地 Token 的 Token 用量统计（来自上游响应的 usage 字段）
 * @param {number} id - 本地 Token ID
 * @param {number} inputTokens - 输入 token 数
 * @param {number} outputTokens - 输出 token 数
 */
function updateLocalTokenUsage(id, inputTokens, outputTokens) {
  stmtUpdateLocalUsage.run(inputTokens, outputTokens, id);
  return getLocalTokenById(id);
}

// ============================
// 日志
// ============================

/**
 * 写入请求日志
 * 支持新格式（level/type/message/extra）和旧格式（仅 method/path 等）
 */
function addLog(params) {
  const { level, type, message, method, path, model, resolvedModel, api, stream, status, localTokenId, upstreamTokenId, durationMs, extra } = params;
  const finalLevel = level || (status >= 400 ? 'error' : 'info');
  const finalType = type || 'request';
  const finalExtra = extra ? JSON.stringify(extra) : null;
  stmtInsertLog.run(finalLevel, finalType, message || '', method, path, model, resolvedModel, api, stream ? 1 : 0, status, localTokenId || null, upstreamTokenId || null, durationMs || null, finalExtra);
  stmtDeleteOldLogs.run();
}

/**
 * 获取近期日志（降序，最新在前）
 */
function getRecentLogs(limit = 50) {
  return stmtGetLogsRecent.all(limit);
}

/**
 * 获取自某 ID 以来的日志（用于增量拉取）
 */
function getLogsSince(id) {
  return stmtGetLogsSince.all(id);
}

/**
 * 获取日志总数
 */
function getTotalLogCount() {
  const row = stmtGetLogCount.get();
  return row ? row.cnt : 0;
}

/**
 * 清空所有日志
 */
function clearAllLogs() {
  stmtClearLogs.run();
  return true;
}

// ============================
// 导出
// ============================
module.exports = {
  db,
  generateLocalToken,
  generateUpstreamToken,
  // upstream
  createUpstreamToken,
  getAllUpstreamTokens,
  getEnabledUpstreamTokens,
  getUpstreamTokenById,
  updateUpstreamToken,
  disableUpstreamToken,
  enableUpstreamToken,
  incrementUpstreamFail,
  resetUpstreamFail,
  incrementUpstreamUsage,
  deleteUpstreamToken,
  getExpiredDisabledTokens,
  // local
  createLocalToken,
  getAllLocalTokens,
  getEnabledLocalTokens,
  getLocalTokenByValue,
  getLocalTokenById,
  updateLocalToken,
  disableLocalToken,
  enableLocalToken,
  deleteLocalToken,
  recordLocalSuccess,
  recordLocalFail,
  updateLocalTokenUsage,
  // logs
  addLog,
  getRecentLogs,
  getLogsSince,
  getTotalLogCount,
  clearAllLogs,
};

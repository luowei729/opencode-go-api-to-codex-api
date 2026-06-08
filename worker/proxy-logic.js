// Workers 版代理核心逻辑（ESM，使用 D1 数据库）
// 功能：上游 Token 池负载均衡 + 本地 Token 认证统计 + 健康检查

// ============================
// 模型协议分类
// ============================
// Anthropic 兼容模型走 /v1/messages，其他走 /v1/chat/completions
const ANTHROPIC_MODELS = new Set([
  'minimax-m3', 'minimax-m2.7', 'minimax-m2.5',
  'qwen3.7-max', 'qwen3.7-plus',
]);

// 内置模型映射表（Codex/OpenAI 模型名 → OpenCode Go 模型名）
const DEFAULT_MODEL_MAP = {
  'gpt-5.5': 'qwen3.7-max',
  'gpt-5': 'qwen3.7-max',
  'gpt-5.4': 'qwen3.7-plus',
  'gpt-5.4-mini': 'qwen3.7-plus',
  'gpt-4': 'kimi-k2.6',
  'gpt-4o': 'kimi-k2.6',
  'gpt-4o-mini': 'deepseek-v4-flash',
  'o3': 'qwen3.7-max',
  'o4-mini': 'deepseek-v4-flash',
  'o3-mini': 'deepseek-v4-flash',
};

export { DEFAULT_MODEL_MAP, ANTHROPIC_MODELS };

// ============================
// D1 数据库操作封装
// ============================

/**
 * 确保 D1 表结构存在（幂等操作）
 * 原因：Workers 每次请求可能在不同 isolate 执行，需要确保表已创建
 */
export async function ensureDbTables(db) {
  if (!db) return;
  try {
    await db.exec(`
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await db.exec(`
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time TEXT NOT NULL DEFAULT (datetime('now')),
        method TEXT,
        path TEXT,
        model TEXT,
        resolved_model TEXT,
        api TEXT,
        stream INTEGER,
        status INTEGER,
        local_token_id INTEGER DEFAULT NULL,
        upstream_token_id INTEGER DEFAULT NULL,
        duration_ms INTEGER DEFAULT NULL
      )
    `);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS model_map (
        from_model TEXT PRIMARY KEY,
        to_model TEXT NOT NULL
      )
    `);
  } catch (e) {
    console.error('DB init error:', e.message);
  }
}

// ---- 上游 Token D1 操作 ----

export async function getAllUpstreamTokens(db) {
  if (!db) return [];
  const result = await db.prepare('SELECT * FROM upstream_tokens ORDER BY id').all();
  return result.results || [];
}

export async function getEnabledUpstreamTokens(db) {
  if (!db) return [];
  const result = await db.prepare('SELECT * FROM upstream_tokens WHERE enabled = 1 ORDER BY id').all();
  return result.results || [];
}

export async function getUpstreamTokenById(db, id) {
  if (!db) return null;
  return await db.prepare('SELECT * FROM upstream_tokens WHERE id = ?').bind(id).first();
}

export async function createUpstreamToken(db, params) {
  if (!db) return null;
  const { token, name, weight = 1, upstream_url = null, max_failures = 3, priority = 5, check_interval_minutes = 5, enabled = 1 } = params;
  const result = await db.prepare(
    'INSERT INTO upstream_tokens (token, name, weight, upstream_url, max_failures, priority, check_interval_minutes, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(token, name, weight, upstream_url, max_failures, priority, check_interval_minutes, enabled).run();
  return await getUpstreamTokenById(db, result.meta.last_row_id);
}

export async function updateUpstreamToken(db, id, params) {
  if (!db) return null;
  const { token, name, weight, upstream_url, max_failures, priority, check_interval_minutes, enabled } = params;
  await db.prepare(
    `UPDATE upstream_tokens SET token=?, name=?, weight=?, upstream_url=?, max_failures=?, priority=?, check_interval_minutes=?, enabled=?, updated_at=datetime('now') WHERE id=?`
  ).bind(token, name, weight, upstream_url, max_failures, priority, check_interval_minutes, enabled, id).run();
  return await getUpstreamTokenById(db, id);
}

export async function deleteUpstreamToken(db, id) {
  if (!db) return;
  await db.prepare('DELETE FROM upstream_tokens WHERE id = ?').bind(id).run();
}

export async function disableUpstreamToken(db, id) {
  if (!db) return;
  await db.prepare(`UPDATE upstream_tokens SET enabled=0, disabled_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).bind(id).run();
}

export async function enableUpstreamToken(db, id) {
  if (!db) return;
  await db.prepare(`UPDATE upstream_tokens SET enabled=1, disabled_at=NULL, fail_count=0, updated_at=datetime('now') WHERE id=?`).bind(id).run();
}

export async function incrementUpstreamFail(db, id) {
  if (!db) return null;
  await db.prepare(`UPDATE upstream_tokens SET fail_count=fail_count+1, updated_at=datetime('now') WHERE id=?`).bind(id).run();
  const after = await getUpstreamTokenById(db, id);
  if (after && after.fail_count >= after.max_failures && after.enabled) {
    await disableUpstreamToken(db, id);
    return { ...after, autoDisabled: true };
  }
  return { ...after, autoDisabled: false };
}

export async function resetUpstreamFail(db, id) {
  if (!db) return;
  await db.prepare(`UPDATE upstream_tokens SET fail_count=0, updated_at=datetime('now') WHERE id=?`).bind(id).run();
}

export async function incrementUpstreamUsage(db, id) {
  if (!db) return;
  await db.prepare(`UPDATE upstream_tokens SET usage_count=usage_count+1, updated_at=datetime('now') WHERE id=?`).bind(id).run();
}

export async function getExpiredDisabledTokens(db) {
  if (!db) return [];
  const result = await db.prepare(
    `SELECT * FROM upstream_tokens WHERE enabled=0 AND disabled_at IS NOT NULL AND datetime(disabled_at, '+' || check_interval_minutes || ' minutes') <= datetime('now') ORDER BY priority ASC, disabled_at ASC LIMIT 3`
  ).all();
  return result.results || [];
}

// ---- 本地 Token D1 操作 ----

export async function getAllLocalTokens(db) {
  if (!db) return [];
  const result = await db.prepare('SELECT * FROM local_tokens ORDER BY id').all();
  return result.results || [];
}

export async function getLocalTokenByValue(db, tokenValue) {
  if (!db) return null;
  return await db.prepare('SELECT * FROM local_tokens WHERE token = ?').bind(tokenValue).first();
}

export async function getLocalTokenById(db, id) {
  if (!db) return null;
  return await db.prepare('SELECT * FROM local_tokens WHERE id = ?').bind(id).first();
}

export async function createLocalToken(db, params) {
  if (!db) return null;
  const { name, token } = params;
  const finalToken = token || generateLocalToken();
  try {
    const result = await db.prepare('INSERT INTO local_tokens (token, name) VALUES (?, ?)').bind(finalToken, name).run();
    return await getLocalTokenById(db, result.meta.last_row_id);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      if (token) throw new Error('Token 值冲突');
      return await createLocalToken(db, { name }); // 重试
    }
    throw err;
  }
}

export async function updateLocalToken(db, id, params) {
  if (!db) return null;
  const { name, enabled } = params;
  await db.prepare(`UPDATE local_tokens SET name=?, enabled=?, updated_at=datetime('now') WHERE id=?`).bind(name, enabled, id).run();
  return await getLocalTokenById(db, id);
}

export async function deleteLocalToken(db, id) {
  if (!db) return;
  await db.prepare('DELETE FROM local_tokens WHERE id = ?').bind(id).run();
}

export async function recordLocalSuccess(db, id) {
  if (!db) return;
  const token = await getLocalTokenById(db, id);
  if (!token) return;
  if (!token.first_used_at) {
    await db.prepare(`UPDATE local_tokens SET first_used_at=datetime('now') WHERE id=?`).bind(id).run();
  }
  await db.prepare(`UPDATE local_tokens SET success_count=success_count+1, total_requests=total_requests+1, last_used_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).bind(id).run();
}

export async function recordLocalFail(db, id) {
  if (!db) return;
  await db.prepare(`UPDATE local_tokens SET fail_count=fail_count+1, total_requests=total_requests+1, last_used_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).bind(id).run();
}

export async function updateLocalTokenUsage(db, id, inputTokens, outputTokens) {
  if (!db) return;
  await db.prepare(`UPDATE local_tokens SET total_input_tokens=total_input_tokens+?, total_output_tokens=total_output_tokens+?, updated_at=datetime('now') WHERE id=?`).bind(inputTokens, outputTokens, id).run();
}

// ---- 日志 D1 操作 ----

/**
 * 通用日志记录函数
 * 原因：统一日志格式，方便后期排查问题
 * @param {Object} db - D1 数据库实例
 * @param {Object} ctx - Workers 执行上下文
 * @param {Object} entry - 日志条目
 * @param {string} entry.level - 日志级别: info, warn, error, debug
 * @param {string} entry.type - 日志类型: request, auth, db, system, error
 * @param {string} entry.message - 日志消息
 * @param {string} [entry.method] - HTTP 方法（仅 request 类型）
 * @param {string} [entry.path] - 请求路径（仅 request 类型）
 * @param {string} [entry.model] - 模型名称（仅 request 类型）
 * @param {string} [entry.resolvedModel] - 解析后的模型（仅 request 类型）
 * @param {string} [entry.api] - API 类型（仅 request 类型）
 * @param {boolean} [entry.stream] - 是否流式（仅 request 类型）
 * @param {number} [entry.status] - HTTP 状态码（仅 request 类型）
 * @param {number} [entry.localTokenId] - 本地 Token ID
 * @param {number} [entry.upstreamTokenId] - 上游 Token ID
 * @param {number} [entry.durationMs] - 耗时毫秒
 * @param {Object} [entry.extra] - 额外数据（JSON 对象）
 */
export async function addLog(db, ctx, entry) {
  if (!db) return;
  ctx.waitUntil((async () => {
    try {
      // 如果是旧格式（没有 level/type），自动补充
      const level = entry.level || (entry.status >= 400 ? 'error' : 'info');
      const type = entry.type || 'request';
      const extra = entry.extra ? JSON.stringify(entry.extra) : null;
      
      await db.prepare(
        'INSERT INTO logs (level, type, message, method, path, model, resolved_model, api, stream, status, local_token_id, upstream_token_id, duration_ms, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        level, type, entry.message || '',
        entry.method, entry.path, entry.model, entry.resolvedModel,
        entry.api, entry.stream ? 1 : 0, entry.status,
        entry.localTokenId || null, entry.upstreamTokenId || null, entry.durationMs || null,
        extra
      ).run();
      // 保留最近 500 条日志
      await db.exec('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 500)');
    } catch (e) {
      console.error('DB write error:', e.message);
    }
  })());
}

/**
 * 快捷日志记录函数
 */
export async function logInfo(db, ctx, type, message, extra = null) {
  return addLog(db, ctx, { level: 'info', type, message, extra });
}

export async function logWarn(db, ctx, type, message, extra = null) {
  return addLog(db, ctx, { level: 'warn', type, message, extra });
}

export async function logError(db, ctx, type, message, extra = null) {
  return addLog(db, ctx, { level: 'error', type, message, extra });
}

export async function logDebug(db, ctx, type, message, extra = null) {
  return addLog(db, ctx, { level: 'debug', type, message, extra });
}

export async function getRecentLogs(db, limit = 50) {
  if (!db) return [];
  const result = await db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').bind(limit).all();
  return result.results || [];
}

export async function getLogsSince(db, id) {
  if (!db) return [];
  const result = await db.prepare('SELECT * FROM logs WHERE id > ? ORDER BY id ASC LIMIT 100').bind(id).all();
  return result.results || [];
}

export async function getTotalLogCount(db) {
  if (!db) return 0;
  const row = await db.prepare('SELECT COUNT(*) as cnt FROM logs').first();
  return row ? row.cnt : 0;
}

export async function clearAllLogs(db) {
  if (!db) return;
  await db.exec('DELETE FROM logs');
}

// ============================
// 上游 Token 池选择逻辑
// ============================

/**
 * 检查并恢复过期的禁用 Token（每次最多 3 个）
 * 原因：被禁用的 Token 超过 check_interval_minutes 后自动探测恢复
 */
export async function checkAndRecoverDisabledTokens(db, upstreamBaseUrl) {
  if (!db) return;
  try {
    const expired = await getExpiredDisabledTokens(db);
    if (!expired || expired.length === 0) return;

    for (const tokenRecord of expired) {
      try {
        const testUrl = buildUpstreamUrl(tokenRecord.upstream_url || upstreamBaseUrl, '/v1/models');
        const response = await fetch(testUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${tokenRecord.token}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(10000), // 10秒超时，防止探测请求无限挂起
        });

        if (response.ok) {
          await enableUpstreamToken(db, tokenRecord.id);
          console.log(`[HealthCheck] Token #${tokenRecord.id}(${tokenRecord.name}) 自动恢复成功`);
        } else {
          await disableUpstreamToken(db, tokenRecord.id);
          console.log(`[HealthCheck] Token #${tokenRecord.id}(${tokenRecord.name}) 仍然不可用`);
        }
      } catch (err) {
        await disableUpstreamToken(db, tokenRecord.id);
        console.log(`[HealthCheck] Token #${tokenRecord.id}(${tokenRecord.name}) 探测失败: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('[HealthCheck] 检查禁用 Token 时出错:', err.message);
  }
}

/**
 * 从上游 Token 池选择最优 Token
 * 算法：usage_count / weight 比值最低者优先
 */
export async function selectUpstreamToken(db, upstreamBaseUrl) {
  const enabledTokens = await getEnabledUpstreamTokens(db);
  if (!enabledTokens || enabledTokens.length === 0) return null;

  const sorted = enabledTokens
    .map(t => ({
      ...t,
      ratio: t.usage_count / (t.weight || 1),
    }))
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.ratio - b.ratio;
    });

  return sorted[0];
}

/**
 * 解析认证信息（本地 Token 优先，否则 passthrough）
 * 修复：passthrough 模式下增加 env.OPENCODE_TOKEN 回退
 * 原因：Docker 版有 process.env.OPENCODE_TOKEN 回退，Workers 版需要通过 env 参数传入
 */
export async function resolveAuth(db, clientToken, upstreamBaseUrl, env) {
  // 异步触发健康检查（不阻塞请求）
  checkAndRecoverDisabledTokens(db, upstreamBaseUrl).catch(() => {});

  if (clientToken && db) {
    const localToken = await getLocalTokenByValue(db, clientToken);
    if (localToken && localToken.enabled) {
      const upstreamToken = await selectUpstreamToken(db, upstreamBaseUrl);
      return {
        mode: 'local',
        localTokenId: localToken.id,
        upstreamToken,
        upstreamBaseUrl,
        actualToken: upstreamToken ? upstreamToken.token : clientToken,
        actualUpstreamUrl: upstreamToken ? (upstreamToken.upstream_url || upstreamBaseUrl) : upstreamBaseUrl,
      };
    }
  }

  // passthrough 模式：无上游 Token 池时，回退到环境变量 OPENCODE_TOKEN
  return {
    mode: 'passthrough',
    localTokenId: null,
    upstreamToken: null,
    upstreamBaseUrl,
    actualToken: clientToken || env?.OPENCODE_TOKEN || '',
    actualUpstreamUrl: upstreamBaseUrl,
  };
}

/**
 * 记录请求统计
 * @param {string} requestPath - 原始请求路径（如 /v1/responses 或 /v1/chat/completions）
 */
export async function recordRequestStats(db, ctx, localTokenId, upstreamTokenId, model, resolvedModel, api, stream, status, durationMs, requestPath) {
  try {
    if (localTokenId && db) {
      if (status >= 200 && status < 300) {
        await recordLocalSuccess(db, localTokenId);
      } else {
        await recordLocalFail(db, localTokenId);
      }
    }
    if (upstreamTokenId && status >= 200 && status < 300 && db) {
      await incrementUpstreamUsage(db, upstreamTokenId);
    }
    // 构建描述性消息
    const statusText = status >= 200 && status < 300 ? '成功' : '失败';
    const message = `${requestPath || '/v1/chat/completions'} ${statusText} (${status}) ${model}→${resolvedModel} ${stream ? 'stream' : ''} ${durationMs}ms`;
    addLog(db, ctx, {
      level: status >= 400 ? 'error' : 'info',
      type: 'request',
      message,
      method: 'POST',
      path: requestPath || '/v1/chat/completions',
      model, resolvedModel, api, stream: !!stream, status,
      localTokenId, upstreamTokenId, durationMs,
    });
  } catch (err) {
    console.error('[Stats] 记录统计失败:', err.message);
  }
}

// ============================
// 工具函数
// ============================

export function isAnthropicModel(modelName) {
  const clean = modelName.replace(/^opencode-go\//, '');
  return ANTHROPIC_MODELS.has(clean);
}

/**
 * 解析模型名称
 * 修复：增加 runtimeDefault 和 runtimeModelMap 参数覆盖
 * 原因：通过 UI 设置的强制模型和自定义映射必须优先于环境变量和内置映射
 */
export function resolveModel(modelName, env, runtimeDefault, runtimeModelMap) {
  // 1. 运行时强制模型（Web UI 设置，优先级最高）
  if (runtimeDefault) return runtimeDefault.replace(/^opencode-go\//, '');

  // 2. 环境变量 DEFAULT_MODEL
  const defaultModel = env.DEFAULT_MODEL;
  if (defaultModel) return defaultModel.replace(/^opencode-go\//, '');

  // 3. 运行时模型映射（从 D1 model_map 表加载，优先于环境变量映射）
  if (runtimeModelMap && runtimeModelMap[modelName]) {
    return runtimeModelMap[modelName].replace(/^opencode-go\//, '');
  }

  // 4. 环境变量 MODEL_MAP
  const modelMapEnv = env.MODEL_MAP || '';
  if (modelMapEnv) {
    const pairs = modelMapEnv.split(',');
    for (const pair of pairs) {
      const [from, to] = pair.split(':');
      if (from?.trim() && to?.trim() && modelName === from.trim()) {
        return to.trim().replace(/^opencode-go\//, '');
      }
    }
  }

  // 5. 内置映射表
  if (DEFAULT_MODEL_MAP[modelName]) return DEFAULT_MODEL_MAP[modelName];

  // 6. 透传（去除前缀）
  return modelName.replace(/^opencode-go\//, '');
}

export function buildUpstreamUrl(base, path) {
  const baseStr = (base || 'https://opencode.ai/zen/go').replace(/\/+$/, '');
  const pathStr = path.startsWith('/') ? path : '/' + path;
  return baseStr + pathStr;
}

export function normalizeRole(role) {
  if (role === 'developer') return 'system';
  return role;
}

function generateHexId(length) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function generateLocalToken() {
  return 'lt_' + generateHexId(16);
}

function extractContent(content) {
  if (typeof content === 'string') return content;
  if (!content) return '';
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') return part.text || '';
      if (part.type === 'input_image' || part.type === 'input_file') return `[${part.type}]`;
      if (part.type === 'function_call' || part.type === 'function_call_output') return '';
      return part.text || JSON.stringify(part);
    }).filter(Boolean).join('\n');
  }
  if (typeof content === 'object') return content.text || JSON.stringify(content);
  return String(content);
}

export function convertInputToMessages(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [{ role: 'user', content: JSON.stringify(input) }];

  const messages = [];
  for (const item of input) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item });
      continue;
    }
    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant', content: '',
        tool_calls: [{ id: item.call_id || item.id, type: 'function', function: { name: item.name, arguments: item.arguments || '{}' } }],
      });
      continue;
    }
    if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id || item.id, content: item.output || '' });
      continue;
    }
    if (item.type === 'message' || item.role) {
      const role = normalizeRole(item.role || 'user');
      const content = item.content;
      if (Array.isArray(content)) {
        const textParts = [];
        const toolMessages = [];
        for (const part of content) {
          if (typeof part === 'string') textParts.push(part);
          else if (part.type === 'function_call') toolMessages.push({ role: 'assistant', content: '', tool_calls: [{ id: part.call_id || part.id, type: 'function', function: { name: part.name, arguments: part.arguments || '{}' } }] });
          else if (part.type === 'function_call_output') toolMessages.push({ role: 'tool', tool_call_id: part.call_id || part.id, content: part.output || '' });
          else if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') textParts.push(part.text || '');
          else if (part.type === 'tool_use') toolMessages.push({ role: 'assistant', content: '', tool_calls: [{ id: part.call_id || part.id, type: 'function', function: { name: part.name, arguments: part.arguments || '{}' } }] });
          else if (part.type === 'tool_result') toolMessages.push({ role: 'tool', tool_call_id: part.tool_use_id || part.call_id || part.id, content: part.content || '' });
        }
        const textContent = textParts.filter(Boolean).join('\n');
        if (textContent) messages.push({ role, content: textContent });
        messages.push(...toolMessages);
      } else {
        const extracted = extractContent(content);
        if (extracted) messages.push({ role, content: extracted });
      }
      continue;
    }
    if (item.content) messages.push({ role: normalizeRole(item.role || 'user'), content: extractContent(item.content) });
  }
  return messages;
}

export function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const filtered = tools.filter(tool => tool.type === 'function' || tool.name).map(tool => {
    if (tool.type === 'function' && tool.function) return tool;
    return { type: 'function', function: { name: tool.name || tool.function?.name, description: tool.description || tool.function?.description || '', parameters: tool.parameters || tool.function?.parameters || { type: 'object', properties: {} } } };
  });
  return filtered.length > 0 ? filtered : undefined;
}

export function convertToolsToAnthropic(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map(tool => {
    // 修复：OpenAI 格式下 tool.name 为 undefined，name 在 tool.function.name
    if (tool.type === 'function') return { name: tool.name || tool.function?.name, description: tool.description || tool.function?.description || '', input_schema: tool.parameters || tool.function?.parameters || { type: 'object', properties: {} } };
    if (tool.name) return { name: tool.name, description: tool.description || '', input_schema: tool.parameters || tool.input_schema || { type: 'object', properties: {} } };
    return tool;
  });
}

export function convertToAnthropicMessages(messages) {
  let system = '';
  const anthropicMessages = [];
  for (const msg of messages) {
    if (msg.role === 'system') { system += (system ? '\n' : '') + (typeof msg.content === 'string' ? msg.content : extractContent(msg.content)); continue; }
    if (msg.role === 'tool') { anthropicMessages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id || msg.id, content: msg.content || '' }] }); continue; }
    let role = msg.role;
    let content = msg.content;
    if (role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
      const parts = [];
      if (content) parts.push({ type: 'text', text: typeof content === 'string' ? content : extractContent(content) });
      for (const tc of msg.tool_calls) parts.push({ type: 'tool_use', id: tc.id, name: tc.function?.name || '', input: (() => { try { return JSON.parse(tc.function?.arguments || '{}'); } catch { return {}; } })() });
      anthropicMessages.push({ role: 'assistant', content: parts });
      continue;
    }
    const extracted = typeof content === 'string' ? content : extractContent(content);
    if (extracted) anthropicMessages.push({ role, content: [{ type: 'text', text: extracted }] });
  }
  return { system, messages: anthropicMessages };
}

export function convertRequestToChatCompletions(body, resolvedModel) {
  const result = { model: resolvedModel, stream: body.stream || false };
  if (body.input) result.messages = convertInputToMessages(body.input);
  else if (body.messages) result.messages = body.messages;
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.max_tokens !== undefined) result.max_tokens = body.max_tokens;
  if (body.max_output_tokens !== undefined) result.max_tokens = body.max_output_tokens;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.frequency_penalty !== undefined) result.frequency_penalty = body.frequency_penalty;
  if (body.presence_penalty !== undefined) result.presence_penalty = body.presence_penalty;
  if (body.stop !== undefined) result.stop = body.stop;
  if (body.tools !== undefined) result.tools = convertTools(body.tools);
  if (body.tool_choice !== undefined) {
    if (body.tool_choice === 'auto' || body.tool_choice === 'none' || body.tool_choice === 'required') result.tool_choice = body.tool_choice;
    else if (typeof body.tool_choice === 'object' && body.tool_choice.function) result.tool_choice = body.tool_choice;
    else if (typeof body.tool_choice === 'object' && body.tool_choice.name) result.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
  }
  return result;
}

export function convertRequestToAnthropic(body, resolvedModel) {
  let messages = [];
  if (body.input) messages = convertInputToMessages(body.input);
  else if (body.messages) messages = body.messages;
  const { system, messages: anthropicMessages } = convertToAnthropicMessages(messages);
  const result = { model: resolvedModel, stream: body.stream || false, max_tokens: body.max_output_tokens || body.max_tokens || 64000, messages: anthropicMessages };
  if (system) result.system = system;
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stop !== undefined) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  const convertedTools = body.tools !== undefined ? convertToolsToAnthropic(body.tools) : undefined;
  if (convertedTools && convertedTools.length > 0) {
    result.tools = convertedTools;
    if (body.tool_choice !== undefined) {
      if (body.tool_choice === 'auto') result.tool_choice = { type: 'auto' };
      else if (body.tool_choice === 'none') result.tool_choice = { type: 'none' };
      else if (body.tool_choice === 'required') result.tool_choice = { type: 'any' };
      else if (typeof body.tool_choice === 'object' && body.tool_choice.name) result.tool_choice = { type: 'tool', name: body.tool_choice.name };
    }
  }
  return result;
}

export function convertChatCompletionToResponse(chatResp, originalModel) {
  const respId = `resp_${generateHexId(12)}`;
  const msgId = `msg_${generateHexId(12)}`;
  const choice = chatResp.choices?.[0];
  const message = choice?.message || {};
  const outputText = message.content || '';
  const output = [];
  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) output.push({ type: 'function_call', id: tc.id || `call_${generateHexId(8)}`, call_id: tc.id, name: tc.function?.name || '', arguments: tc.function?.arguments || '{}' });
  }
  output.push({ type: 'message', id: msgId, role: 'assistant', content: [{ type: 'output_text', text: outputText, annotations: [] }] });
  const usage = chatResp.usage || {};
  return { id: respId, object: 'response', created_at: chatResp.created || Math.floor(Date.now() / 1000), model: originalModel, status: 'completed', output, usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0, total_tokens: usage.total_tokens || 0 } };
}

export function convertAnthropicResponseToResponse(anthResp, originalModel) {
  const respId = `resp_${generateHexId(12)}`;
  const msgId = `msg_${generateHexId(12)}`;
  const output = [];
  let textContent = '';
  if (Array.isArray(anthResp.content)) {
    for (const block of anthResp.content) {
      if (block.type === 'text') textContent += block.text || '';
      else if (block.type === 'tool_use') output.push({ type: 'function_call', id: block.id || `call_${generateHexId(8)}`, call_id: block.id, name: block.name || '', arguments: JSON.stringify(block.input || {}) });
    }
  }
  output.push({ type: 'message', id: msgId, role: 'assistant', content: [{ type: 'output_text', text: textContent, annotations: [] }] });
  const usage = anthResp.usage || {};
  return { id: respId, object: 'response', created_at: Math.floor(Date.now() / 1000), model: originalModel, status: 'completed', output, usage: { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0, total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0) } };
}

export function convertAnthropicToChatCompletion(anthResp, model) {
  const message = { role: 'assistant', content: '' };
  const toolCalls = [];
  if (Array.isArray(anthResp.content)) {
    for (const block of anthResp.content) {
      if (block.type === 'text') message.content += block.text || '';
      else if (block.type === 'tool_use') toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input || {}) } });
    }
  }
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const usage = anthResp.usage || {};
  return { id: `chatcmpl-${generateHexId(12)}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message, finish_reason: anthResp.stop_reason === 'end_turn' ? 'stop' : (anthResp.stop_reason === 'tool_use' ? 'tool_calls' : anthResp.stop_reason || 'stop') }], usage: { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0, total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0) } };
}

// ---- 流式转换器 ----

export function createChatStreamConverter(originalModel) {
  const respId = `resp_${generateHexId(12)}`;
  const msgId = `msg_${generateHexId(12)}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let fullText = '', inputTokens = 0, outputTokens = 0, headersSent = false, toolCalls = [], buffer = '';

  function buildBaseResponse(status) {
    const resp = { id: respId, object: 'response', created_at: createdAt, model: originalModel, output: [], usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens } };
    if (status) resp.status = status;
    return resp;
  }
  function sse(event, data) { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }

  function processEvents(events, parts) {
    for (const part of parts) {
      let dataStr = '';
      for (const line of part.split('\n')) { if (line.startsWith('data:')) dataStr += line.slice(5).trim(); }
      if (!dataStr) continue;
      if (dataStr === '[DONE]') {
        events.push(sse('response.output_text.done', { type: 'response.output_text.done', output_index: 0, content_index: 0, text: fullText }));
        events.push(sse('response.content_part.done', { type: 'response.content_part.done', output_index: 0, content_index: 0, part: { type: 'output_text', text: fullText, annotations: [] } }));
        for (let i = 0; i < toolCalls.length; i++) { const tc = toolCalls[i]; events.push(sse('response.output_item.added', { type: 'response.output_item.added', output_index: i + 1, item: { type: 'function_call', id: tc.id, call_id: tc.id, name: tc.name, arguments: '' } })); events.push(sse('response.output_item.done', { type: 'response.output_item.done', output_index: i + 1, item: { type: 'function_call', id: tc.id, call_id: tc.id, name: tc.name, arguments: tc.arguments } })); }
        events.push(sse('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: msgId, role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] } }));
        const finalResp = buildBaseResponse('completed');
        for (const tc of toolCalls) finalResp.output.push({ type: 'function_call', id: tc.id, call_id: tc.id, name: tc.name, arguments: tc.arguments });
        finalResp.output.push({ type: 'message', id: msgId, role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] });
        events.push(sse('response.completed', { type: 'response.completed', response: finalResp }));
        continue;
      }
      try {
        const parsed = JSON.parse(dataStr);
        if (parsed.usage) { inputTokens = parsed.usage.prompt_tokens || inputTokens; outputTokens = parsed.usage.completion_tokens || outputTokens; }
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.role && !headersSent) { headersSent = true; events.push(sse('response.created', { type: 'response.created', response: buildBaseResponse('in_progress') })); events.push(sse('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: msgId, role: 'assistant', status: 'in_progress', content: [] } })); events.push(sse('response.content_part.added', { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })); }
        if (delta.tool_calls) { for (const tc of delta.tool_calls) { const idx = tc.index || 0; if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || '', name: tc.function?.name || '', arguments: '' }; if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments; } continue; }
        if (delta.content) { fullText += delta.content; events.push(sse('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: delta.content })); }
      } catch (e) {}
    }
  }

  return {
    process(chunk) { const events = []; buffer += chunk; const parts = buffer.split('\n\n'); buffer = parts.pop() || ''; processEvents(events, parts); return events.join(''); },
    flush() { if (!buffer.trim()) return ''; const events = []; processEvents(events, [buffer]); buffer = ''; return events.join(''); },
  };
}

export function createAnthropicStreamConverter(originalModel) {
  const respId = `resp_${generateHexId(12)}`;
  const msgId = `msg_${generateHexId(12)}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let fullText = '', inputTokens = 0, outputTokens = 0, headersSent = false, toolCalls = [], currentToolIndex = -1, buffer = '';

  function buildBaseResponse(status) {
    const resp = { id: respId, object: 'response', created_at: createdAt, model: originalModel, output: [], usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens } };
    if (status) resp.status = status;
    return resp;
  }
  function sse(event, data) { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }

  function processAnthropicEvents(events, parts) {
    for (const part of parts) {
      let dataStr = '';
      for (const line of part.split('\n')) { if (line.startsWith('data:')) dataStr += line.slice(5).trim(); }
      if (!dataStr || dataStr === '[DONE]') continue;
      try {
        const parsed = JSON.parse(dataStr);
        const eventType = parsed.type;
        if (eventType === 'message_start') { const msg = parsed.message || {}; inputTokens = msg.usage?.input_tokens || 0; if (!headersSent) { headersSent = true; events.push(sse('response.created', { type: 'response.created', response: buildBaseResponse('in_progress') })); events.push(sse('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: msgId, role: 'assistant', status: 'in_progress', content: [] } })); events.push(sse('response.content_part.added', { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })); } }
        else if (eventType === 'content_block_start') { const block = parsed.content_block || {}; if (block.type === 'tool_use') { currentToolIndex = toolCalls.length; toolCalls.push({ id: block.id || '', name: block.name || '', arguments: '' }); events.push(sse('response.output_item.added', { type: 'response.output_item.added', output_index: currentToolIndex + 1, item: { type: 'function_call', id: block.id || '', call_id: block.id || '', name: block.name || '', arguments: '' } })); } }
        else if (eventType === 'content_block_delta') { const delta = parsed.delta || {}; if (delta.type === 'text_delta' && delta.text) { fullText += delta.text; events.push(sse('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: delta.text })); } else if (delta.type === 'input_json_delta' && delta.partial_json) { if (currentToolIndex >= 0 && toolCalls[currentToolIndex]) toolCalls[currentToolIndex].arguments += delta.partial_json; } }
        else if (eventType === 'message_delta') { outputTokens = parsed.usage?.output_tokens || 0; }
        else if (eventType === 'message_stop') { events.push(sse('response.output_text.done', { type: 'response.output_text.done', output_index: 0, content_index: 0, text: fullText })); events.push(sse('response.content_part.done', { type: 'response.content_part.done', output_index: 0, content_index: 0, part: { type: 'output_text', text: fullText, annotations: [] } })); for (let i = 0; i < toolCalls.length; i++) { const tc = toolCalls[i]; events.push(sse('response.output_item.added', { type: 'response.output_item.added', output_index: i + 1, item: { type: 'function_call', id: tc.id, call_id: tc.id, name: tc.name, arguments: '' } })); events.push(sse('response.output_item.done', { type: 'response.output_item.done', output_index: i + 1, item: { type: 'function_call', id: tc.id, call_id: tc.id, name: tc.name, arguments: tc.arguments } })); } events.push(sse('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: msgId, role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] } })); const finalResp = buildBaseResponse('completed'); for (const tc of toolCalls) finalResp.output.push({ type: 'function_call', id: tc.id, call_id: tc.id, name: tc.name, arguments: tc.arguments }); finalResp.output.push({ type: 'message', id: msgId, role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] }); events.push(sse('response.completed', { type: 'response.completed', response: finalResp })); }
      } catch (e) {}
    }
  }

  return {
    process(chunk) { const events = []; buffer += chunk; const parts = buffer.split('\n\n'); buffer = parts.pop() || ''; processAnthropicEvents(events, parts); return events.join(''); },
    flush() { if (!buffer.trim()) return ''; const events = []; processAnthropicEvents(events, [buffer]); buffer = ''; return events.join(''); },
  };
}

export function createAnthropicToChatStreamConverter(model) {
  const respId = `chatcmpl-${generateHexId(8)}`;
  let toolCallIndex = -1, buffer = '';
  function sse(data) { return `data: ${JSON.stringify(data)}\n\n`; }

  function processEvents(events, parts) {
    for (const part of parts) {
      let dataStr = '';
      for (const line of part.split('\n')) { if (line.startsWith('data:')) dataStr += line.slice(5).trim(); }
      if (!dataStr) continue;
      try {
        const parsed = JSON.parse(dataStr);
        const eventType = parsed.type;
        if (eventType === 'message_start') events.push(sse({ id: respId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }));
        else if (eventType === 'content_block_start') { const block = parsed.content_block || {}; if (block.type === 'tool_use') { toolCallIndex++; events.push(sse({ id: respId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: toolCallIndex, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }] }, finish_reason: null }] })); } }
        else if (eventType === 'content_block_delta') { const delta = parsed.delta || {}; if (delta.type === 'text_delta' && delta.text) events.push(sse({ id: respId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }] })); else if (delta.type === 'input_json_delta' && delta.partial_json) events.push(sse({ id: respId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: toolCallIndex, function: { arguments: delta.partial_json } }] }, finish_reason: null }] })); }
        else if (eventType === 'message_delta') { const stopReason = parsed.delta?.stop_reason; if (stopReason) { const finishReason = stopReason === 'end_turn' ? 'stop' : (stopReason === 'tool_use' ? 'tool_calls' : stopReason); events.push(sse({ id: respId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })); } }
      } catch (e) {}
    }
  }

  return {
    process(chunk) { const events = []; buffer += chunk; const parts = buffer.split('\n\n'); buffer = parts.pop() || ''; processEvents(events, parts); return events.join(''); },
    flush() { if (!buffer.trim()) return ''; const events = []; processEvents(events, [buffer]); buffer = ''; return events.join(''); },
  };
}

// ---- 上游请求 ----

export async function makeUpstreamRequest(url, body, token, useAnthropic) {
  const headers = { 'Content-Type': 'application/json' };
  if (useAnthropic) { headers['x-api-key'] = token; headers['anthropic-version'] = '2023-06-01'; }
  else headers['Authorization'] = `Bearer ${token}`;
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

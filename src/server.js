require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto'); // 时序安全密码比较用
const db = require('./database'); // Docker 版数据库操作封装
const {
  createResponsesProxyHandler, createChatCompletionsProxyHandler,
  getRuntimeDefaultModel, setRuntimeDefaultModel, isAnthropicModel,
  checkAndRecoverDisabledTokens, selectUpstreamToken,
} = require('./proxy');

const app = express();
const PORT = process.env.PORT || 30001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================
// 公共路由（无需认证）
// ============================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================
// 上游 Token 池 API
// ============================

/**
 * 获取所有上游 Token 列表
 * 原因：管理页面展示完整 Token 池信息（含禁用状态、权重等）
 * 安全：需要管理密码认证，且不返回完整 Token 值
 */
app.get('/api/upstream-tokens', requireAdminAuth, (req, res) => {
  try {
    const tokens = db.getAllUpstreamTokens();
    // 脱敏：返回时隐藏完整 token，只显示前 8 位
    const masked = tokens.map(t => ({
      ...t,
      token: t.token.slice(0, 8) + '****',
    }));
    res.json({ tokens: masked });
  } catch (err) {
    console.error('Get upstream tokens error:', err.message);
    res.status(500).json({ error: { message: '获取上游 Token 列表失败' } });
  }
});

/**
 * 创建上游 Token
 */
app.post('/api/upstream-tokens', requireAdminAuth, (req, res) => {
  try {
    const { token, name, weight, upstream_url, max_failures, priority, check_interval_minutes, enabled } = req.body;
    if (!token || !name) {
      return res.status(400).json({ error: { message: 'token 和 name 为必填项' } });
    }
    const tokenRecord = db.createUpstreamToken({
      token,
      name,
      // 使用 parseInt(x, 10) 明确指定十进制，防止字符串前导零被误解析为八进制
      weight: parseInt(weight, 10) || 1,
      upstream_url: upstream_url || null,
      max_failures: parseInt(max_failures, 10) || 3,
      priority: parseInt(priority, 10) || 5,
      check_interval_minutes: parseInt(check_interval_minutes, 10) || 5,
      // 布尔转整数：显式判断真值，避免字符串 "0" 被当作 truthy
      enabled: enabled !== undefined ? ((enabled === true || enabled === 1 || enabled === '1') ? 1 : 0) : 1,
    });
    res.json({ success: true, token: maskToken(tokenRecord) });
  } catch (err) {
    console.error('Create upstream token error:', err.message);
    res.status(500).json({ error: { message: '创建上游 Token 失败: ' + err.message } });
  }
});

/**
 * 更新上游 Token
 */
app.put('/api/upstream-tokens/:id', requireAdminAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: { message: '无效的 Token ID' } });
    const existing = db.getUpstreamTokenById(id);
    if (!existing) {
      return res.status(404).json({ error: { message: 'Token 不存在' } });
    }
    const { token, name, weight, upstream_url, max_failures, priority, check_interval_minutes, enabled } = req.body;
    const updated = db.updateUpstreamToken(id, {
      token: token || existing.token,
      name: name || existing.name,
      weight: weight !== undefined ? parseInt(weight, 10) : existing.weight,
      upstream_url: upstream_url !== undefined ? upstream_url : existing.upstream_url,
      max_failures: max_failures !== undefined ? parseInt(max_failures, 10) : existing.max_failures,
      priority: priority !== undefined ? parseInt(priority, 10) : existing.priority,
      check_interval_minutes: check_interval_minutes !== undefined ? parseInt(check_interval_minutes, 10) : existing.check_interval_minutes,
      enabled: enabled !== undefined ? ((enabled === true || enabled === 1 || enabled === '1') ? 1 : 0) : existing.enabled,
    });
    res.json({ success: true, token: maskToken(updated) });
  } catch (err) {
    console.error('Update upstream token error:', err.message);
    res.status(500).json({ error: { message: '更新上游 Token 失败' } });
  }
});

/**
 * 删除上游 Token
 */
app.delete('/api/upstream-tokens/:id', requireAdminAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: { message: '无效的 Token ID' } });
    db.deleteUpstreamToken(id);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete upstream token error:', err.message);
    res.status(500).json({ error: { message: '删除上游 Token 失败' } });
  }
});

/**
 * 手动触发健康检查（对所有禁用 Token 立即检查）
 */
app.post('/api/upstream-tokens/health-check', requireAdminAuth, async (req, res) => {
  try {
    await checkAndRecoverDisabledTokens(process.env.UPSTREAM_BASE_URL || 'https://opencode.ai/zen/go');
    res.json({ success: true, message: '健康检查已完成' });
  } catch (err) {
    res.status(500).json({ error: { message: '健康检查失败: ' + err.message } });
  }
});

// ============================
// 本地访问 Token API
// ============================

/**
 * 获取所有本地 Token 及使用统计
 * 原因：管理页面展示 Token 列表、状态、请求量、Token 用量等关键统计
 * 安全：脱敏处理，只显示 token 前 10 位
 */
app.get('/api/local-tokens', requireAdminAuth, (req, res) => {
  try {
    const tokens = db.getAllLocalTokens();
    // 脱敏：只返回 token 前 10 位，避免完整 Token 泄露
    const masked = tokens.map(t => ({
      ...t,
      token: t.token.slice(0, 10) + '****',
    }));
    res.json({ tokens: masked });
  } catch (err) {
    console.error('Get local tokens error:', err.message);
    res.status(500).json({ error: { message: '获取本地 Token 列表失败' } });
  }
});

/**
 * 创建本地 Token（自动生成随机凭证值）
 */
app.post('/api/local-tokens', requireAdminAuth, (req, res) => {
  try {
    const { name, token: customToken } = req.body;
    if (!name) {
      return res.status(400).json({ error: { message: 'name 为必填项' } });
    }
    const tokenRecord = db.createLocalToken({
      name,
      token: customToken || null, // 未提供则自动生成
    });
    // 返回完整 token（仅创建时可见一次）
    res.json({
      success: true,
      token: {
        ...tokenRecord,
        _full_token: tokenRecord.token, // 前端只展示这一次，之后脱敏
      },
    });
  } catch (err) {
    console.error('Create local token error:', err.message);
    res.status(500).json({ error: { message: '创建本地 Token 失败: ' + err.message } });
  }
});

/**
 * 更新本地 Token
 */
app.put('/api/local-tokens/:id', requireAdminAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: { message: '无效的 Token ID' } });
    const existing = db.getLocalTokenById(id);
    if (!existing) {
      return res.status(404).json({ error: { message: 'Token 不存在' } });
    }
    const { name, enabled } = req.body;
    const updated = db.updateLocalToken(id, {
      name: name || existing.name,
      enabled: enabled !== undefined ? ((enabled === true || enabled === 1 || enabled === '1') ? 1 : 0) : existing.enabled,
    });
    res.json({ success: true, token: updated });
  } catch (err) {
    console.error('Update local token error:', err.message);
    res.status(500).json({ error: { message: '更新本地 Token 失败' } });
  }
});

/**
 * 删除本地 Token
 */
app.delete('/api/local-tokens/:id', requireAdminAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: { message: '无效的 Token ID' } });
    db.deleteLocalToken(id);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete local token error:', err.message);
    res.status(500).json({ error: { message: '删除本地 Token 失败' } });
  }
});

/**
 * 获取本地 Token 的使用统计概览
 */
app.get('/api/stats/overview', requireAdminAuth, (req, res) => {
  try {
    const tokens = db.getAllLocalTokens();
    const totalLocal = tokens.length;
    const enabledLocal = tokens.filter(t => t.enabled).length;
    const totalRequests = tokens.reduce((sum, t) => sum + t.total_requests, 0);
    const totalSuccess = tokens.reduce((sum, t) => sum + t.success_count, 0);
    const totalFail = tokens.reduce((sum, t) => sum + t.fail_count, 0);
    const totalInputTokens = tokens.reduce((sum, t) => sum + t.total_input_tokens, 0);
    const totalOutputTokens = tokens.reduce((sum, t) => sum + t.total_output_tokens, 0);

    const upstreamTokens = db.getAllUpstreamTokens();
    const enabledUpstream = upstreamTokens.filter(t => t.enabled).length;
    const disabledUpstream = upstreamTokens.filter(t => !t.enabled).length;

    res.json({
      local: { total: totalLocal, enabled: enabledLocal, disabled: totalLocal - enabledLocal },
      requests: { total: totalRequests, success: totalSuccess, fail: totalFail },
      tokens: { input: totalInputTokens, output: totalOutputTokens },
      upstream: { total: upstreamTokens.length, enabled: enabledUpstream, disabled: disabledUpstream },
    });
  } catch (err) {
    console.error('Stats overview error:', err.message);
    res.status(500).json({ error: { message: '获取统计概览失败' } });
  }
});

// ============================
// 日志 API
// ============================

/**
 * 获取请求日志（支持增量拉取）
 * 原因：UI 的"使用统计"标签页需要展示请求日志，支持 since 参数获取增量数据
 */
app.get('/api/logs', requireAdminAuth, (req, res) => {
  try {
    const since = parseInt(req.query.since, 10) || 0;
    const total = db.getTotalLogCount();
    const logs = since ? db.getLogsSince(since) : db.getRecentLogs(50);
    // 将数据库字段名转换为前端期望的驼峰格式
    const mapped = logs.map(r => ({
      id: r.id,
      time: r.time,
      method: r.method,
      path: r.path,
      model: r.model,
      resolvedModel: r.resolved_model,
      api: r.api,
      stream: !!r.stream,
      status: r.status,
    }));
    // 非增量模式（初始加载）倒序显示，最新的在前
    if (!since) mapped.reverse();
    res.json({ logs: mapped, total });
  } catch (err) {
    console.error('Get logs error:', err.message);
    res.status(500).json({ error: { message: '获取日志失败' } });
  }
});

/**
 * 清空所有请求日志
 */
app.delete('/api/logs', requireAdminAuth, (req, res) => {
  try {
    db.clearAllLogs();
    res.json({ success: true, message: '日志已清空' });
  } catch (err) {
    console.error('Clear logs error:', err.message);
    res.status(500).json({ error: { message: '清空日志失败' } });
  }
});

// ============================
// 原有 API（兼容保留）
// ============================

// List models endpoint
app.get('/v1/models', async (req, res) => {
  try {
    const upstream = process.env.UPSTREAM_BASE_URL || 'https://opencode.ai/zen/go';
    const token = process.env.OPENCODE_TOKEN || req.headers.authorization?.replace('Bearer ', '');

    const response = await fetch(`${upstream}/v1/models`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Error fetching models:', err.message);
    res.status(502).json({ error: { message: 'Failed to fetch models from upstream' } });
  }
});

// API: Get current runtime default model
app.get('/api/default-model', (req, res) => {
  res.json({
    runtimeDefault: getRuntimeDefaultModel(),
    envDefault: process.env.DEFAULT_MODEL || null,
  });
});

// API: Set runtime default model（需认证）
app.post('/api/default-model', requireAdminAuth, (req, res) => {
  const { model } = req.body;
  if (model === null || model === '' || model === undefined) {
    setRuntimeDefaultModel(null);
    return res.json({ success: true, model: null, message: '已取消强制模型，使用客户端传入的模型' });
  }
  setRuntimeDefaultModel(model);
  return res.json({ success: true, model, message: `已强制使用模型: ${model}` });
});

// Web UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Proxy API routes
app.post('/v1/responses', createResponsesProxyHandler());
app.post('/v1/chat/completions', createChatCompletionsProxyHandler());

// Proxy other /v1/* requests
app.all('/v1/*', (req, res) => {
  res.status(404).json({ error: { message: `Route ${req.method} ${req.path} not found` } });
});

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: { message: `Route ${req.method} ${req.path} not found` } });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`OpenCode Go -> Codex API proxy running on port ${PORT}`);
  console.log(`Upstream: ${process.env.UPSTREAM_BASE_URL || 'https://opencode.ai/zen/go'}`);
  console.log(`Default model: ${process.env.DEFAULT_MODEL || '(use client model)'}`);
  console.log(`Auth mode: local token pool + passthrough (local prefers)`);
  console.log(`Web UI: http://127.0.0.1:${PORT}/`);
});

// ============================
// Docker 版密码认证中间件
// ============================

/**
 * 管理接口认证中间件（Docker 版新增）
 * 原因：保护敏感操作（上游 Token、本地 Token 的管理），防止未授权访问
 * 密码优先从环境变量 WEB_PASSWORD 读取，未设置则返回 500 提示必须配置
 * 安全：使用 crypto.timingSafeEqual 防止时序攻击
 */
function requireAdminAuth(req, res, next) {
  const webPassword = process.env.WEB_PASSWORD;

  if (!webPassword) {
    return res.status(500).json({ error: { message: '服务端未配置 WEB_PASSWORD，请在 .env 中设置管理密码' } });
  }

  const password = req.headers['x-admin-password'] || req.headers['X-Admin-Password'] || '';
  // 时序安全比较：防止通过响应时间差异逐字符猜测密码
  if (password.length === webPassword.length && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(webPassword))) {
    return next();
  }

  return res.status(401).json({ error: { message: '未授权，需要有效的管理密码' } });
}

/**
 * 辅助函数：给 token 脱敏
 */
function maskToken(tokenRecord) {
  if (!tokenRecord || !tokenRecord.token) return tokenRecord;
  return {
    ...tokenRecord,
    token: tokenRecord.token.slice(0, 8) + '****',
  };
}

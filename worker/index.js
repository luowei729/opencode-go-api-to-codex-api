import {
  isAnthropicModel,
  resolveModel,
  buildUpstreamUrl,
  normalizeRole,
  convertInputToMessages,
  convertTools,
  convertRequestToChatCompletions,
  convertRequestToAnthropic,
  convertChatCompletionToResponse,
  convertAnthropicResponseToResponse,
  convertAnthropicToChatCompletion,
  createChatStreamConverter,
  createAnthropicStreamConverter,
  createAnthropicToChatStreamConverter,
  makeUpstreamRequest,
  DEFAULT_MODEL_MAP,
  ANTHROPIC_MODELS,
  // 新增：D1 数据库操作
  ensureDbTables,
  getAllUpstreamTokens,
  getEnabledUpstreamTokens,
  getUpstreamTokenById,
  createUpstreamToken,
  updateUpstreamToken,
  deleteUpstreamToken,
  disableUpstreamToken,
  enableUpstreamToken,
  incrementUpstreamFail,
  resetUpstreamFail,
  incrementUpstreamUsage,
  getExpiredDisabledTokens,
  checkAndRecoverDisabledTokens,
  selectUpstreamToken,
  getAllLocalTokens,
  getLocalTokenByValue,
  getLocalTokenById,
  createLocalToken,
  updateLocalToken,
  deleteLocalToken,
  recordLocalSuccess,
  recordLocalFail,
  updateLocalTokenUsage,
  addLog,
  getRecentLogs,
  getLogsSince,
  getTotalLogCount,
  clearAllLogs,
  resolveAuth,
  recordRequestStats,
  generateLocalToken,
} from './proxy-logic.js';

import indexHtml from '../pages/index.html';

// Runtime 状态（跨请求共享，但 Workers isolate 可能重置）
let runtimeDefaultModel = null;
let defaultModelLoaded = false;
const runtimeModelMap = {};
let modelMapLoaded = false;
let runtimeUpstreamUrl = null;
let settingsLoaded = false;
const DEFAULT_UPSTREAM = 'https://opencode.ai/zen/go';
// 默认密码：仅当 D1 中未设置密码时使用
// 安全提示：应在首次部署后立即通过 Web UI 更改密码，避免使用默认密码
const DEFAULT_PASSWORD = 'abcd.1234';
let runtimeMaxContextTokens = null;
let runtimeMaxOutputTokens = null;
let tokenLimitsLoaded = false;
let dbInitialized = false;

// ============================
// D1 初始化
// ============================

async function ensureDb(env) {
  if (dbInitialized || !env.DB) return;
  await ensureDbTables(env.DB);
  dbInitialized = true;
}

async function loadModelMapFromDb(env) {
  if (!env.DB) return;
  try {
    await ensureDb(env);
    const result = await env.DB.prepare('SELECT * FROM model_map').all();
    if ((result.results || []).length === 0) {
      for (const [from, to] of Object.entries(DEFAULT_MODEL_MAP)) {
        await env.DB.prepare('INSERT OR REPLACE INTO model_map (from_model, to_model) VALUES (?, ?)').bind(from, to).run();
        runtimeModelMap[from] = to;
      }
    } else {
      for (const row of (result.results || [])) runtimeModelMap[row.from_model] = row.to_model;
    }
    modelMapLoaded = true;
  } catch (e) { console.error('Load model map error:', e.message); }
}

async function loadSettingsFromDb(env) {
  if (!env.DB || settingsLoaded) return;
  try {
    await ensureDb(env);
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('upstream_url').first();
    if (row && row.value) runtimeUpstreamUrl = row.value;
    settingsLoaded = true;
  } catch (e) { console.error('Load settings error:', e.message); }
}

async function loadDefaultModelFromDb(env) {
  if (!env.DB || defaultModelLoaded) return;
  try {
    await ensureDb(env);
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('default_model').first();
    runtimeDefaultModel = (row && row.value) ? row.value : null;
    defaultModelLoaded = true;
  } catch (e) { console.error('Load default model error:', e.message); }
}

async function loadTokenLimitsFromDb(env) {
  if (!env.DB || tokenLimitsLoaded) return;
  try {
    await ensureDb(env);
    const ctxRow = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('max_context_tokens').first();
    const outRow = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('max_output_tokens').first();
    runtimeMaxContextTokens = (ctxRow && ctxRow.value) ? parseInt(ctxRow.value, 10) : null;
    runtimeMaxOutputTokens = (outRow && outRow.value) ? parseInt(outRow.value, 10) : null;
    tokenLimitsLoaded = true;
  } catch (e) { console.error('Load token limits error:', e.message); }
}

// 每次请求都从 D1 读取密码，确保修改后立即生效
async function getPasswordFromDb(env) {
  if (!env.DB) return DEFAULT_PASSWORD;
  try {
    await ensureDb(env);
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('web_password').first();
    return (row && row.value) ? row.value : DEFAULT_PASSWORD;
  } catch (e) {
    console.error('Load password error:', e.message);
    return DEFAULT_PASSWORD;
  }
}

// 异步检查密码（每次请求调用）
async function checkAuth(request, env) {
  const password = await getPasswordFromDb(env);
  return request.headers.get('x-admin-password') === password;
}

function getUpstreamUrl(env) { return runtimeUpstreamUrl || env.UPSTREAM_BASE_URL || DEFAULT_UPSTREAM; }

// ============================
// CORS & JSON helpers
// ============================

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Password',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
}

// ============================
// 原有路由处理器
// ============================

async function handleHealth() {
  return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
}

async function handleModels(authHeader, env) {
  try {
    // 使用动态上游地址而非硬编码，优先从 D1 设置读取
    const upstream = getUpstreamUrl(env);
    // 认证 Token：优先使用请求头的 Bearer Token，否则回退到环境变量
    const token = authHeader?.replace('Bearer ', '') || env.OPENCODE_TOKEN || '';
    const response = await fetch(`${upstream}/v1/models`, { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } });
    const data = await response.json();
    return jsonResponse(data);
  } catch (err) {
    console.error('Error fetching models:', err.message);
    return jsonResponse({ error: { message: 'Failed to fetch models from upstream' } }, 502);
  }
}

async function handleGetDefaultModel(env) {
  if (env.DB) {
    try {
      await ensureDb(env);
      const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('default_model').first();
      runtimeDefaultModel = (row && row.value) ? row.value : null;
    } catch (e) { console.error('Load default model error:', e.message); }
  }
  return jsonResponse({ runtimeDefault: runtimeDefaultModel, envDefault: env.DEFAULT_MODEL || null });
}

async function handleSetDefaultModel(request, env) {
  if (!defaultModelLoaded) await loadDefaultModelFromDb(env);
  const body = await request.json();
  const { model } = body;
  if (model === null || model === '' || model === undefined) {
    runtimeDefaultModel = null;
    if (env.DB) { try { await ensureDb(env); await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind('default_model').run(); } catch (e) { console.error('Save default model error:', e.message); } }
    return jsonResponse({ success: true, model: null, message: '已取消强制模型，使用客户端传入的模型' });
  }
  runtimeDefaultModel = model;
  if (env.DB) { try { await ensureDb(env); await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('default_model', model).run(); } catch (e) { console.error('Save default model error:', e.message); } }
  return jsonResponse({ success: true, model, message: `已强制使用模型: ${model}` });
}

// ============================
// 新增：上游 Token 池 API
// ============================

async function handleGetUpstreamTokens(env) {
  await ensureDb(env);
  try {
    const tokens = await getAllUpstreamTokens(env.DB);
    // 安全：脱敏处理，只显示 token 前 8 位
    const masked = (tokens || []).map(t => ({
      ...t,
      token: t.token ? t.token.slice(0, 8) + '****' : '****',
    }));
    return jsonResponse({ tokens: masked });
  } catch (e) {
    console.error('Get upstream tokens error:', e.message);
    return jsonResponse({ error: { message: '获取上游 Token 列表失败: ' + e.message } }, 500);
  }
}

async function handleCreateUpstreamToken(request, env) {
  await ensureDb(env);
  const body = await request.json();
  const { token, name, weight, upstream_url, max_failures, priority, check_interval_minutes, enabled } = body;
  if (!token || !name) return jsonResponse({ error: { message: 'token 和 name 为必填项' } }, 400);
  const record = await createUpstreamToken(env.DB, { token, name, weight: parseInt(weight, 10) || 1, upstream_url: upstream_url || null, max_failures: parseInt(max_failures, 10) || 3, priority: parseInt(priority, 10) || 5, check_interval_minutes: parseInt(check_interval_minutes, 10) || 5, enabled: enabled !== undefined ? ((enabled === true || enabled === 1 || enabled === "1") ? 1 : 0) : 1 });
  return jsonResponse({ success: true, token: record ? { ...record, token: record.token.slice(0, 8) + '****' } : null });
}

async function handleUpdateUpstreamToken(request, env, id) {
  await ensureDb(env);
  const existing = await getUpstreamTokenById(env.DB, id);
  if (!existing) return jsonResponse({ error: { message: 'Token 不存在' } }, 404);
  const body = await request.json();
  const { token, name, weight, upstream_url, max_failures, priority, check_interval_minutes, enabled } = body;
  const updated = await updateUpstreamToken(env.DB, id, { token: token || existing.token, name: name || existing.name, weight: weight !== undefined ? parseInt(weight, 10) : existing.weight, upstream_url: upstream_url !== undefined ? upstream_url : existing.upstream_url, max_failures: max_failures !== undefined ? parseInt(max_failures, 10) : existing.max_failures, priority: priority !== undefined ? parseInt(priority, 10) : existing.priority, check_interval_minutes: check_interval_minutes !== undefined ? parseInt(check_interval_minutes, 10) : existing.check_interval_minutes, enabled: enabled !== undefined ? ((enabled === true || enabled === 1 || enabled === "1") ? 1 : 0) : existing.enabled });
  return jsonResponse({ success: true, token: updated ? { ...updated, token: updated.token.slice(0, 8) + '****' } : null });
}

async function handleDeleteUpstreamToken(env, id) {
  await ensureDb(env);
  await deleteUpstreamToken(env.DB, id);
  return jsonResponse({ success: true });
}

async function handleHealthCheck(env) {
  await ensureDb(env);
  await checkAndRecoverDisabledTokens(env.DB, getUpstreamUrl(env));
  return jsonResponse({ success: true, message: '健康检查已完成' });
}

// ============================
// 新增：本地 Token API
// ============================

async function handleGetLocalTokens(env) {
  await ensureDb(env);
  try {
    const tokens = await getAllLocalTokens(env.DB);
    // 安全：脱敏处理，只显示 token 前 10 位
    const masked = (tokens || []).map(t => ({
      ...t,
      token: t.token ? t.token.slice(0, 10) + '****' : '****',
    }));
    return jsonResponse({ tokens: masked });
  } catch (e) {
    console.error('Get local tokens error:', e.message);
    return jsonResponse({ error: { message: '获取本地 Token 列表失败: ' + e.message } }, 500);
  }
}

async function handleCreateLocalToken(request, env) {
  await ensureDb(env);
  const body = await request.json();
  const { name, token: customToken } = body;
  if (!name) return jsonResponse({ error: { message: 'name 为必填项' } }, 400);
  try {
    const record = await createLocalToken(env.DB, { name, token: customToken || null });
    return jsonResponse({ success: true, token: { ...record, _full_token: record.token } });
  } catch (err) {
    return jsonResponse({ error: { message: '创建失败: ' + err.message } }, 500);
  }
}

async function handleUpdateLocalToken(request, env, id) {
  await ensureDb(env);
  const existing = await getLocalTokenById(env.DB, id);
  if (!existing) return jsonResponse({ error: { message: 'Token 不存在' } }, 404);
  const body = await request.json();
  const { name, enabled } = body;
  const updated = await updateLocalToken(env.DB, id, { name: name || existing.name, enabled: enabled !== undefined ? ((enabled === true || enabled === 1 || enabled === "1") ? 1 : 0) : existing.enabled });
  return jsonResponse({ success: true, token: updated });
}

async function handleDeleteLocalToken(env, id) {
  await ensureDb(env);
  await deleteLocalToken(env.DB, id);
  return jsonResponse({ success: true });
}

// ============================
// 新增：统计概览
// ============================

async function handleStatsOverview(env) {
  await ensureDb(env);
  try {
    const localTokens = await getAllLocalTokens(env.DB) || [];
    const upstreamTokens = await getAllUpstreamTokens(env.DB) || [];
    const totalRequests = localTokens.reduce((sum, t) => sum + (t.total_requests || 0), 0);
    const totalSuccess = localTokens.reduce((sum, t) => sum + (t.success_count || 0), 0);
    const totalFail = localTokens.reduce((sum, t) => sum + (t.fail_count || 0), 0);
    const totalInputTokens = localTokens.reduce((sum, t) => sum + (t.total_input_tokens || 0), 0);
    const totalOutputTokens = localTokens.reduce((sum, t) => sum + (t.total_output_tokens || 0), 0);
    return jsonResponse({
      local: { total: localTokens.length, enabled: localTokens.filter(t => t.enabled).length, disabled: localTokens.filter(t => !t.enabled).length },
      requests: { total: totalRequests, success: totalSuccess, fail: totalFail },
      tokens: { input: totalInputTokens, output: totalOutputTokens },
      upstream: { total: upstreamTokens.length, enabled: upstreamTokens.filter(t => t.enabled).length, disabled: upstreamTokens.filter(t => !t.enabled).length },
    });
  } catch (e) {
    console.error('Stats overview error:', e.message);
    return jsonResponse({ error: { message: '获取统计概览失败: ' + e.message } }, 500);
  }
}

// ============================
// 代理请求处理器（使用新认证逻辑）
// ============================

async function handleResponses(request, env, ctx) {
  try {
    if (!modelMapLoaded) await loadModelMapFromDb(env);
    if (!settingsLoaded) await loadSettingsFromDb(env);
    if (!defaultModelLoaded) await loadDefaultModelFromDb(env);
    if (!tokenLimitsLoaded) await loadTokenLimitsFromDb(env);

    const upstreamBase = getUpstreamUrl(env);
    const clientToken = request.headers.get('authorization')?.replace('Bearer ', '');
    const startTime = Date.now();

    const auth = await resolveAuth(env.DB, clientToken, upstreamBase, env);
    if (!auth.actualToken) {
      return jsonResponse({ error: { message: 'No authentication token provided.', type: 'authentication_error' } }, 401);
    }

    const reqBody = await request.json();
    const originalModel = reqBody?.model || 'unknown';
    const resolvedModel = resolveModel(originalModel, env, runtimeDefaultModel, runtimeModelMap);
    const isStream = reqBody?.stream === true;

    if (runtimeMaxOutputTokens && !reqBody.max_output_tokens) reqBody.max_output_tokens = runtimeMaxOutputTokens;

    const useAnthropic = isAnthropicModel(resolvedModel);
    let upstreamBody, upstreamPath;

    if (useAnthropic) { upstreamBody = convertRequestToAnthropic(reqBody, resolvedModel); upstreamPath = '/v1/messages'; }
    else { upstreamBody = convertRequestToChatCompletions(reqBody, resolvedModel); upstreamPath = '/v1/chat/completions'; }

    const upstreamUrl = buildUpstreamUrl(auth.actualUpstreamUrl, upstreamPath);
    console.log(`[Responses] -> ${upstreamUrl} (model: ${originalModel} -> ${resolvedModel}, stream: ${isStream}, api: ${useAnthropic ? 'anthropic' : 'openai'}, token: #${auth.upstreamToken?.id || 'env'}, local: ${auth.mode === 'local' ? '#' + auth.localTokenId : 'passthrough'})`);

    const response = await makeUpstreamRequest(upstreamUrl, upstreamBody, auth.actualToken, useAnthropic);
    const durationMs = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Upstream error ${response.status}: ${errorText.substring(0, 500)}`);
      await recordRequestStats(env.DB, ctx, auth.localTokenId, auth.upstreamToken?.id, originalModel, resolvedModel, useAnthropic ? 'anthropic' : 'openai', isStream, response.status, durationMs, '/v1/responses');
      try { return jsonResponse(JSON.parse(errorText), response.status); }
      catch { return jsonResponse({ error: { message: `Upstream error: ${response.status} ${errorText.substring(0, 200)}`, type: 'upstream_error' } }, response.status); }
    }

    if (isStream) {
      const converter = useAnthropic ? createAnthropicStreamConverter(originalModel) : createChatStreamConverter(originalModel);
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const transformed = response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) { const text = decoder.decode(chunk, { stream: true }); const converted = converter.process(text); if (converted) controller.enqueue(encoder.encode(converted)); },
        flush(controller) { const remaining = converter.flush(); if (remaining) controller.enqueue(encoder.encode(remaining)); },
      }));
      await recordRequestStats(env.DB, ctx, auth.localTokenId, auth.upstreamToken?.id, originalModel, resolvedModel, useAnthropic ? 'anthropic' : 'openai', isStream, response.status, durationMs, '/v1/responses');
      return new Response(transformed, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', ...corsHeaders() } });
    } else {
      const data = await response.text();
      try {
        const upstreamResp = JSON.parse(data);
        if (upstreamResp.error) {
          // 上游返回 200 但包含 error 字段：使用 error 中的状态码或默认 502
          const errorStatus = upstreamResp.error?.status || upstreamResp.error?.http_status || response.status || 502;
          await recordRequestStats(env.DB, ctx, auth.localTokenId, auth.upstreamToken?.id, originalModel, resolvedModel, useAnthropic ? 'anthropic' : 'openai', isStream, errorStatus, durationMs, '/v1/responses');
          return jsonResponse(upstreamResp, errorStatus);
        }
        const result = useAnthropic ? convertAnthropicResponseToResponse(upstreamResp, originalModel) : convertChatCompletionToResponse(upstreamResp, originalModel);
        await recordRequestStats(env.DB, ctx, auth.localTokenId, auth.upstreamToken?.id, originalModel, resolvedModel, useAnthropic ? 'anthropic' : 'openai', isStream, response.status, durationMs, '/v1/responses');
        if (upstreamResp.usage && auth.localTokenId) {
          const inputTokens = upstreamResp.usage.prompt_tokens || upstreamResp.usage.input_tokens || 0;
          const outputTokens = upstreamResp.usage.completion_tokens || upstreamResp.usage.output_tokens || 0;
          if (inputTokens > 0 || outputTokens > 0) await updateLocalTokenUsage(env.DB, auth.localTokenId, inputTokens, outputTokens);
        }
        return jsonResponse(result);
      } catch (e) {
        console.error('Response parse error:', e.message);
        await recordRequestStats(env.DB, ctx, auth.localTokenId, auth.upstreamToken?.id, originalModel, resolvedModel, useAnthropic ? 'anthropic' : 'openai', isStream, 502, durationMs, '/v1/responses');
        return jsonResponse({ error: { message: 'Failed to parse upstream response', type: 'server_error' } }, 502);
      }
    }
  } catch (err) {
    console.error('Proxy handler error:', err.message);
    return jsonResponse({ error: { message: `Upstream error: ${err.message}`, type: 'proxy_error' } }, 502);
  }
}

async function handleChatCompletions(request, env, ctx) {
  try {
    if (!modelMapLoaded) await loadModelMapFromDb(env);
    if (!settingsLoaded) await loadSettingsFromDb(env);
    if (!defaultModelLoaded) await loadDefaultModelFromDb(env);
    if (!tokenLimitsLoaded) await loadTokenLimitsFromDb(env);

    const upstreamBase = getUpstreamUrl(env);
    const clientToken = request.headers.get('authorization')?.replace('Bearer ', '');
    const startTime = Date.now();

    const auth = await resolveAuth(env.DB, clientToken, upstreamBase, env);
    if (!auth.actualToken) {
      return jsonResponse({ error: { message: 'No auth token.', type: 'authentication_error' } }, 401);
    }

    const reqBody = await request.json();
    const originalModel = reqBody?.model || 'gpt-4o';
    const resolvedModel = resolveModel(originalModel, env, runtimeDefaultModel, runtimeModelMap);
    reqBody.model = resolvedModel;

    if (runtimeMaxOutputTokens && !reqBody.max_tokens) reqBody.max_tokens = runtimeMaxOutputTokens;

    const useAnthropic = isAnthropicModel(resolvedModel);
    let upstreamBody, upstreamPath;

    if (useAnthropic) {
      const pseudoResponsesBody = { model: resolvedModel, messages: reqBody.messages, stream: reqBody.stream || false, max_output_tokens: reqBody.max_tokens || 64000, temperature: reqBody.temperature, top_p: reqBody.top_p, stop: reqBody.stop, tools: reqBody.tools };
      upstreamBody = convertRequestToAnthropic(pseudoResponsesBody, resolvedModel);
      upstreamPath = '/v1/messages';
    } else {
      upstreamBody = { ...reqBody };
      if (Array.isArray(upstreamBody.messages)) upstreamBody.messages = upstreamBody.messages.map(m => ({ ...m, role: normalizeRole(m.role) }));
      if (upstreamBody.tools) upstreamBody.tools = convertTools(upstreamBody.tools);
      upstreamPath = '/v1/chat/completions';
    }

    const upstreamUrl = buildUpstreamUrl(auth.actualUpstreamUrl, upstreamPath);
    const isStream = reqBody?.stream === true;
    console.log(`[Chat] -> ${upstreamUrl} (model: ${originalModel} -> ${resolvedModel}, api: ${useAnthropic ? 'anthropic' : 'openai'}, token: #${auth.upstreamToken?.id || 'env'}, local: ${auth.mode === 'local' ? '#' + auth.localTokenId : 'passthrough'})`);

    const response = await makeUpstreamRequest(upstreamUrl, upstreamBody, auth.actualToken, useAnthropic);
    const durationMs = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Upstream error ${response.status}: ${errorText.substring(0, 500)}`);
      await recordRequestStats(env.DB, ctx, auth.localTokenId, auth.upstreamToken?.id, originalModel, resolvedModel, useAnthropic ? 'anthropic' : 'openai', isStream, response.status, durationMs, '/v1/chat/completions');
      try { return jsonResponse(JSON.parse(errorText), response.status); }
      catch { return jsonResponse({ error: { message: `Upstream error: ${response.status}`, type: 'upstream_error' } }, response.status); }
    }

    if (isStream) {
      if (useAnthropic) {
        const converter = createAnthropicToChatStreamConverter(resolvedModel);
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        const transformed = response.body.pipeThrough(new TransformStream({
          transform(chunk, controller) { const text = decoder.decode(chunk, { stream: true }); const converted = converter.process(text); if (converted) controller.enqueue(encoder.encode(converted)); },
          flush(controller) { const remaining = converter.flush(); if (remaining) controller.enqueue(encoder.encode(remaining)); controller.enqueue(encoder.encode('data: [DONE]\n\n')); },
        }));
        await recordRequestStats(env.DB, ctx, auth.localTokenId, auth.upstreamToken?.id, originalModel, resolvedModel, useAnthropic ? 'anthropic' : 'openai', isStream, response.status, durationMs, '/v1/chat/completions');
        return new Response(transformed, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', ...corsHeaders() } });
      } else {
        await recordRequestStats(env.DB, ctx, auth.localTokenId, auth.upstreamToken?.id, originalModel, resolvedModel, useAnthropic ? 'anthropic' : 'openai', isStream, response.status, durationMs, '/v1/chat/completions');
        return new Response(response.body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', ...corsHeaders() } });
      }
    } else {
      const data = await response.text();
      try {
        const upstreamResp = JSON.parse(data);
        const result = useAnthropic ? convertAnthropicToChatCompletion(upstreamResp, resolvedModel) : upstreamResp;
        await recordRequestStats(env.DB, ctx, auth.localTokenId, auth.upstreamToken?.id, originalModel, resolvedModel, useAnthropic ? 'anthropic' : 'openai', isStream, response.status, durationMs, '/v1/chat/completions');
        if (upstreamResp.usage && auth.localTokenId) {
          const inputTokens = upstreamResp.usage.prompt_tokens || upstreamResp.usage.input_tokens || 0;
          const outputTokens = upstreamResp.usage.completion_tokens || upstreamResp.usage.output_tokens || 0;
          if (inputTokens > 0 || outputTokens > 0) await updateLocalTokenUsage(env.DB, auth.localTokenId, inputTokens, outputTokens);
        }
        return jsonResponse(result);
      } catch {
        // 解析响应失败：返回 502 而非原始数据，避免客户端收到无效 JSON 却认为成功
        await recordRequestStats(env.DB, ctx, auth.localTokenId, auth.upstreamToken?.id, originalModel, resolvedModel, useAnthropic ? 'anthropic' : 'openai', isStream, 502, durationMs, '/v1/chat/completions');
        return jsonResponse({ error: { message: 'Failed to parse upstream response', type: 'server_error' } }, 502);
      }
    }
  } catch (err) {
    console.error('Chat handler error:', err.message);
    return jsonResponse({ error: { message: err.message, type: 'proxy_error' } }, 502);
  }
}

// ============================
// 主 Fetch Handler
// ============================

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });

    const url = new URL(request.url);
    const path = url.pathname;

    // ---- 公共路由 ----
    if (path === '/health' && request.method === 'GET') return handleHealth();
    if (path === '/v1/models' && request.method === 'GET') return handleModels(request.headers.get('authorization'), env);

    // ---- 认证 ----
    if (path === '/api/auth' && request.method === 'POST') {
      const currentPassword = await getPasswordFromDb(env);
      const body = await request.json();
      if (body.password === currentPassword) return jsonResponse({ success: true, message: '登录成功' });
      return jsonResponse({ error: { message: '密码错误' } }, 401);
    }
    if (path === '/api/auth/change' && request.method === 'POST') {
      const currentPassword = await getPasswordFromDb(env);
      const body = await request.json();
      if (body.oldPassword !== currentPassword) return jsonResponse({ error: { message: '当前密码错误' } }, 401);
      if (!body.newPassword || body.newPassword.length < 4) return jsonResponse({ error: { message: '新密码至少 4 位' } }, 400);
      if (env.DB) { try { await ensureDb(env); await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('web_password', body.newPassword).run(); } catch (e) { console.error('Save password error:', e.message); } }
      return jsonResponse({ success: true, message: '密码已修改' });
    }

    // ---- 上游 Token 池 API ----
    if (path === '/api/upstream-tokens' && request.method === 'GET') {
      if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
      return handleGetUpstreamTokens(env);
    }
    if (path === '/api/upstream-tokens' && request.method === 'POST') {
      if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
      return handleCreateUpstreamToken(request, env);
    }
    if (path === '/api/upstream-tokens/health-check' && request.method === 'POST') {
      if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
      return handleHealthCheck(env);
    }
    const upstreamMatch = path.match(/^\/api\/upstream-tokens\/(\d+)$/);
    if (upstreamMatch) {
      const id = parseInt(upstreamMatch[1], 10);
      if (request.method === 'PUT') {
        if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
        return handleUpdateUpstreamToken(request, env, id);
      }
      if (request.method === 'DELETE') {
        if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
        return handleDeleteUpstreamToken(env, id);
      }
    }

    // ---- 本地 Token API ----
    if (path === '/api/local-tokens' && request.method === 'GET') {
      if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
      return handleGetLocalTokens(env);
    }
    if (path === '/api/local-tokens' && request.method === 'POST') {
      if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
      return handleCreateLocalToken(request, env);
    }
    const localMatch = path.match(/^\/api\/local-tokens\/(\d+)$/);
    if (localMatch) {
      const id = parseInt(localMatch[1], 10);
      if (request.method === 'PUT') {
        if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
        return handleUpdateLocalToken(request, env, id);
      }
      if (request.method === 'DELETE') {
        if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
        return handleDeleteLocalToken(env, id);
      }
    }

    // ---- 统计概览 ----
    if (path === '/api/stats/overview' && request.method === 'GET') {
      if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
      return handleStatsOverview(env);
    }

    // ---- 原有 API ----
    if (path === '/api/default-model' && request.method === 'GET') return handleGetDefaultModel(env);
    if (path === '/api/default-model' && request.method === 'POST') {
      if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
      return handleSetDefaultModel(request, env);
    }

    if (path === '/api/logs' && request.method === 'GET') {
      if (!env.DB) return jsonResponse({ logs: [], total: 0, error: 'DB binding not found' });
      try {
        await ensureDb(env);
        const since = parseInt(url.searchParams.get('since') || '0', 10);
        const total = await getTotalLogCount(env.DB);
        const logs = since ? await getLogsSince(env.DB, since) : await getRecentLogs(env.DB, 50);
        const mapped = logs.map(r => ({ id: r.id, time: r.time, method: r.method, path: r.path, model: r.model, resolvedModel: r.resolved_model, api: r.api, stream: !!r.stream, status: r.status }));
        if (!since) mapped.reverse();
        return jsonResponse({ logs: mapped, total });
      } catch (e) { console.error('Logs read error:', e.message); return jsonResponse({ logs: [], total: 0, error: e.message }); }
    }
    if (path === '/api/logs' && request.method === 'DELETE') {
      if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
      if (env.DB) { try { await ensureDb(env); await clearAllLogs(env.DB); } catch (e) { console.error('Logs clear error:', e.message); } }
      return jsonResponse({ success: true, message: '日志已清空' });
    }

    if (path === '/api/model-map' && request.method === 'GET') {
      if (!modelMapLoaded && env.DB) await loadModelMapFromDb(env);
      return jsonResponse({ modelMap: { ...runtimeModelMap }, anthropicModels: [...ANTHROPIC_MODELS] });
    }
    if (path === '/api/model-map' && request.method === 'POST') {
      if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
      const body = await request.json();
      const { from, to } = body;
      if (!from || !to) return jsonResponse({ error: { message: 'from 和 to 字段必填' } }, 400);
      runtimeModelMap[from] = to;
      if (env.DB) { try { await ensureDb(env); await env.DB.prepare('INSERT OR REPLACE INTO model_map (from_model, to_model) VALUES (?, ?)').bind(from, to).run(); } catch (e) { console.error('Save model map error:', e.message); } }
      return jsonResponse({ success: true, message: `已添加映射: ${from} → ${to}`, modelMap: { ...runtimeModelMap } });
    }
    if (path === '/api/model-map' && request.method === 'DELETE') {
      if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
      const body = await request.json();
      const { from } = body;
      if (!from) return jsonResponse({ error: { message: 'from 字段必填' } }, 400);
      delete runtimeModelMap[from];
      if (env.DB) { try { await ensureDb(env); await env.DB.prepare('DELETE FROM model_map WHERE from_model = ?').bind(from).run(); } catch (e) { console.error('Delete model map error:', e.message); } }
      return jsonResponse({ success: true, message: `已删除映射: ${from}`, modelMap: { ...runtimeModelMap } });
    }

    if (path === '/api/upstream-url' && request.method === 'GET') {
      if (!settingsLoaded && env.DB) await loadSettingsFromDb(env);
      return jsonResponse({ current: getUpstreamUrl(env), default: DEFAULT_UPSTREAM, custom: runtimeUpstreamUrl || null });
    }
    if (path === '/api/upstream-url' && request.method === 'POST') {
      if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
      const body = await request.json();
      const { url: newUrl } = body;
      if (!newUrl) return jsonResponse({ error: { message: 'url 字段必填' } }, 400);
      runtimeUpstreamUrl = newUrl.replace(/\/+$/, '');
      if (env.DB) { try { await ensureDb(env); await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('upstream_url', runtimeUpstreamUrl).run(); } catch (e) { console.error('Save upstream url error:', e.message); } }
      settingsLoaded = true;
      return jsonResponse({ success: true, message: `上游地址已设置为: ${runtimeUpstreamUrl}`, url: runtimeUpstreamUrl });
    }
    if (path === '/api/upstream-url' && request.method === 'DELETE') {
      if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
      runtimeUpstreamUrl = null;
      settingsLoaded = true;
      if (env.DB) { try { await ensureDb(env); await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind('upstream_url').run(); } catch (e) { console.error('Delete upstream url error:', e.message); } }
      return jsonResponse({ success: true, message: '已恢复默认上游地址', url: env.UPSTREAM_BASE_URL || DEFAULT_UPSTREAM });
    }

    if (path === '/api/token-limits' && request.method === 'GET') {
      if (!tokenLimitsLoaded) await loadTokenLimitsFromDb(env);
      return jsonResponse({ maxContextTokens: runtimeMaxContextTokens, maxOutputTokens: runtimeMaxOutputTokens });
    }
    if (path === '/api/token-limits' && request.method === 'POST') {
      if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
      const body = await request.json();
      const { maxContextTokens, maxOutputTokens } = body;
      if (maxContextTokens !== undefined) {
        runtimeMaxContextTokens = maxContextTokens ? parseInt(maxContextTokens, 10) : null;
        if (env.DB) { try { await ensureDb(env); if (runtimeMaxContextTokens) await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('max_context_tokens', String(runtimeMaxContextTokens)).run(); else await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind('max_context_tokens').run(); } catch (e) { console.error('Save max context tokens error:', e.message); } }
      }
      if (maxOutputTokens !== undefined) {
        runtimeMaxOutputTokens = maxOutputTokens ? parseInt(maxOutputTokens, 10) : null;
        if (env.DB) { try { await ensureDb(env); if (runtimeMaxOutputTokens) await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('max_output_tokens', String(runtimeMaxOutputTokens)).run(); else await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind('max_output_tokens').run(); } catch (e) { console.error('Save max output tokens error:', e.message); } }
      }
      return jsonResponse({ success: true, message: 'Token 限制已更新', maxContextTokens: runtimeMaxContextTokens, maxOutputTokens: runtimeMaxOutputTokens });
    }

    // ---- 代理路由 ----
    if (path === '/v1/responses' && request.method === 'POST') return handleResponses(request, env, ctx);
    if (path === '/v1/chat/completions' && request.method === 'POST') return handleChatCompletions(request, env, ctx);

    if (path.startsWith('/v1/')) return jsonResponse({ error: { message: `Route ${request.method} ${path} not found` } }, 404);

    // ---- 静态页面 ----
    if (path === '/' || path === '/index.html' || path === '/favicon.ico') {
      if (path === '/favicon.ico') return new Response(null, { status: 204 });
      return new Response(indexHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders() } });
    }

    return jsonResponse({ error: { message: `Route ${request.method} ${path} not found` } }, 404);
  },
};

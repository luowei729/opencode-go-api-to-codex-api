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
  logInfo,
  logWarn,
  logError,
  logDebug,
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

// 模型元数据缓存（model_id -> {context_window, max_output_tokens, ...}）
const runtimeModelMeta = {};
let modelMetaLoaded = false;

// ============================
// D1 初始化
// ============================

async function ensureDb(env) {
  if (dbInitialized || !env.DB) return;
  await ensureDbTables(env.DB);
  dbInitialized = true;
}

// 从 D1 加载模型元数据到运行时缓存
async function loadModelMetaFromDb(env) {
  if (modelMetaLoaded) return;
  if (!env.DB) return;
  try {
    await ensureDb(env);
    const result = await env.DB.prepare('SELECT * FROM model_meta').all();
    // 清空缓存并重新加载
    Object.keys(runtimeModelMeta).forEach(key => delete runtimeModelMeta[key]);
    for (const row of (result.results || [])) {
      runtimeModelMeta[row.model_id] = {
        vendor: row.vendor,
        context_window: row.context_window,
        max_output_tokens: row.max_output_tokens,
        supports_vision: row.supports_vision,
        supports_tools: row.supports_tools,
        pricing_input: row.pricing_input,
        pricing_output: row.pricing_output,
        api_format: row.api_format
      };
    }
    modelMetaLoaded = true;
    console.log(`[ModelMeta] Loaded ${Object.keys(runtimeModelMeta).length} models`);
  } catch (e) {
    console.error('[ModelMeta] Load error:', e.message);
  }
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

/**
 * 处理 /v1/models 请求
 * 合并上游模型列表和 D1 中的元数据，返回完整的模型信息
 */
async function handleModels(request, env, ctx) {
  try {
    // 使用动态上游地址，优先从 D1 设置读取
    const upstream = getUpstreamUrl(env);
    // 认证 Token：优先使用请求头的 Bearer Token，否则回退到环境变量
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '') || env.OPENCODE_TOKEN || '';
    
    // 获取上游模型列表
    const response = await fetch(`${upstream}/v1/models`, { 
      headers: { 
        'Authorization': `Bearer ${token}`, 
        'Content-Type': 'application/json' 
      } 
    });
    
    if (!response.ok) {
      throw new Error(`Upstream returned ${response.status}`);
    }
    
    const upstreamData = await response.json();
    const upstreamModels = upstreamData.data || [];
    
    // 从 D1 获取元数据
    let metaData = {};
    if (env.DB) {
      try {
        await ensureDb(env);
        const rows = await env.DB.prepare('SELECT * FROM model_meta').all();
        rows.results?.forEach(row => {
          metaData[row.model_id] = {
            vendor: row.vendor,
            context_window: row.context_window,
            max_output_tokens: row.max_output_tokens,
            source: row.source,
            supports_vision: row.supports_vision,
            supports_tools: row.supports_tools,
            pricing_input: row.pricing_input,
            pricing_output: row.pricing_output,
            api_format: row.api_format,
            updated_at: row.updated_at
          };
        });
      } catch (e) {
        console.error('Load model meta error:', e.message);
      }
    }
    
    // 合并上游模型和元数据
    const mergedModels = upstreamModels.map(m => {
      const meta = metaData[m.id] || {};
      return {
        id: m.id,
        object: m.object || 'model',
        created: m.created || null,
        owned_by: m.owned_by || '',
        // 合并元数据
        context_window: meta.context_window || null,
        max_output_tokens: meta.max_output_tokens || null,
        vendor: meta.vendor || null,
        source: meta.source || null,
        supports_vision: meta.supports_vision || 0,
        supports_tools: meta.supports_tools || 1,
        pricing_input: meta.pricing_input || 0,
        pricing_output: meta.pricing_output || 0,
        api_format: meta.api_format || 'openai',
        last_updated: meta.updated_at || null
      };
    });
    
    return jsonResponse({
      object: 'list',
      data: mergedModels
    });
    
  } catch (err) {
    console.error('Error fetching models:', err.message);
    return jsonResponse({ 
      error: { 
        message: `Failed to fetch models: ${err.message}`,
        type: 'upstream_error'
      } 
    }, 502);
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

async function handleSetDefaultModel(request, env, ctx) {
  if (!defaultModelLoaded) await loadDefaultModelFromDb(env);
  const body = await request.json();
  const { model } = body;
  if (model === null || model === '' || model === undefined) {
    runtimeDefaultModel = null;
    if (env.DB) { try { await ensureDb(env); await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind('default_model').run(); } catch (e) { console.error('Save default model error:', e.message); } }
    await logInfo(env.DB, ctx, 'system', '取消强制模型设置', { model: null });
    return jsonResponse({ success: true, model: null, message: '已取消强制模型，使用客户端传入的模型' });
  }
  runtimeDefaultModel = model;
  if (env.DB) { try { await ensureDb(env); await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('default_model', model).run(); } catch (e) { console.error('Save default model error:', e.message); } }
  await logInfo(env.DB, ctx, 'system', `设置强制模型: ${model}`, { model });
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

async function handleCreateUpstreamToken(request, env, ctx) {
  await ensureDb(env);
  const body = await request.json();
  const { token, name, weight, upstream_url, max_failures, priority, check_interval_minutes, enabled } = body;
  if (!token || !name) return jsonResponse({ error: { message: 'token 和 name 为必填项' } }, 400);
  const record = await createUpstreamToken(env.DB, { token, name, weight: parseInt(weight, 10) || 1, upstream_url: upstream_url || null, max_failures: parseInt(max_failures, 10) || 3, priority: parseInt(priority, 10) || 5, check_interval_minutes: parseInt(check_interval_minutes, 10) || 5, enabled: enabled !== undefined ? ((enabled === true || enabled === 1 || enabled === "1") ? 1 : 0) : 1 });
  await logInfo(env.DB, ctx, 'db', `创建上游 Token: ${name}`, { tokenId: record?.id, weight, upstream_url });
  return jsonResponse({ success: true, token: record ? { ...record, token: record.token.slice(0, 8) + '****' } : null });
}

async function handleUpdateUpstreamToken(request, env, ctx, id) {
  await ensureDb(env);
  const existing = await getUpstreamTokenById(env.DB, id);
  if (!existing) return jsonResponse({ error: { message: 'Token 不存在' } }, 404);
  const body = await request.json();
  const { token, name, weight, upstream_url, max_failures, priority, check_interval_minutes, enabled } = body;
  const updated = await updateUpstreamToken(env.DB, id, { token: token || existing.token, name: name || existing.name, weight: weight !== undefined ? parseInt(weight, 10) : existing.weight, upstream_url: upstream_url !== undefined ? upstream_url : existing.upstream_url, max_failures: max_failures !== undefined ? parseInt(max_failures, 10) : existing.max_failures, priority: priority !== undefined ? parseInt(priority, 10) : existing.priority, check_interval_minutes: check_interval_minutes !== undefined ? parseInt(check_interval_minutes, 10) : existing.check_interval_minutes, enabled: enabled !== undefined ? ((enabled === true || enabled === 1 || enabled === "1") ? 1 : 0) : existing.enabled });
  await logInfo(env.DB, ctx, 'db', `更新上游 Token #${id}: ${name}`, { tokenId: id, changes: { weight, upstream_url, enabled } });
  return jsonResponse({ success: true, token: updated ? { ...updated, token: updated.token.slice(0, 8) + '****' } : null });
}

async function handleDeleteUpstreamToken(env, ctx, id) {
  await ensureDb(env);
  await deleteUpstreamToken(env.DB, id);
  await logInfo(env.DB, ctx, 'db', `删除上游 Token #${id}`, { tokenId: id });
  return jsonResponse({ success: true });
}

async function handleHealthCheck(env, ctx) {
  await ensureDb(env);
  await logInfo(env.DB, ctx, 'system', '手动触发健康检查');
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

async function handleCreateLocalToken(request, env, ctx) {
  await ensureDb(env);
  const body = await request.json();
  const { name, token: customToken } = body;
  if (!name) return jsonResponse({ error: { message: 'name 为必填项' } }, 400);
  try {
    const record = await createLocalToken(env.DB, { name, token: customToken || null });
    await logInfo(env.DB, ctx, 'db', `创建本地 Token: ${name}`, { tokenId: record?.id, name });
    return jsonResponse({ success: true, token: { ...record, _full_token: record.token } });
  } catch (err) {
    await logError(env.DB, ctx, 'db', `创建本地 Token 失败: ${err.message}`, { name });
    return jsonResponse({ error: { message: '创建失败: ' + err.message } }, 500);
  }
}

async function handleUpdateLocalToken(request, env, ctx, id) {
  await ensureDb(env);
  const existing = await getLocalTokenById(env.DB, id);
  if (!existing) return jsonResponse({ error: { message: 'Token 不存在' } }, 404);
  const body = await request.json();
  const { name, enabled } = body;
  const updated = await updateLocalToken(env.DB, id, { name: name || existing.name, enabled: enabled !== undefined ? ((enabled === true || enabled === 1 || enabled === "1") ? 1 : 0) : existing.enabled });
  await logInfo(env.DB, ctx, 'db', `更新本地 Token #${id}: ${name}`, { tokenId: id, name, enabled });
  return jsonResponse({ success: true, token: updated });
}

async function handleDeleteLocalToken(env, ctx, id) {
  await ensureDb(env);
  await deleteLocalToken(env.DB, id);
  await logInfo(env.DB, ctx, 'db', `删除本地 Token #${id}`, { tokenId: id });
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
    // 加载模型元数据缓存，用于获取每个模型的默认 max_output_tokens
    // 原因：不同模型的最大输出 Token 限制不同，需要根据模型自动设置合理默认值
    if (!modelMetaLoaded) await loadModelMetaFromDb(env);

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

    // 获取当前模型的默认 max_output_tokens
    // 优先级：runtimeMaxOutputTokens（全局设置）> 模型元数据中的 max_output_tokens > 64000（硬编码默认）
    const modelMeta = runtimeModelMeta[resolvedModel];
    const defaultMaxTokens = modelMeta?.max_output_tokens || 64000;

    // 自动注入 max_output_tokens（Responses API 格式）
    // 原因：部分客户端可能不传 max_output_tokens，需要根据模型能力设置合理默认值
    if (!reqBody.max_output_tokens) {
      reqBody.max_output_tokens = runtimeMaxOutputTokens || defaultMaxTokens;
    }
    // 同时设置 max_tokens（Chat Completions 格式），兼容两种 API 格式
    if (!reqBody.max_tokens) {
      reqBody.max_tokens = runtimeMaxOutputTokens || defaultMaxTokens;
    }

    const useAnthropic = isAnthropicModel(resolvedModel);
    let upstreamBody, upstreamPath;

    if (useAnthropic) { upstreamBody = convertRequestToAnthropic(reqBody, resolvedModel); upstreamPath = '/v1/messages'; }
    else { upstreamBody = convertRequestToChatCompletions(reqBody, resolvedModel); upstreamPath = '/v1/chat/completions'; }

    // 流式请求时添加 stream_options 以获取 Token 用量统计
    // 原因：OpenAI 流式响应默认不包含 usage 字段，需要显式请求
    // 注意：仅对 OpenAI 兼容模型有效，Anthropic 模型通过 message_delta 事件返回 usage
    if (isStream && !useAnthropic && auth.localTokenId) {
      upstreamBody.stream_options = { include_usage: true };
    }

    const upstreamUrl = buildUpstreamUrl(auth.actualUpstreamUrl, upstreamPath);
    // 记录请求日志，包含 max_tokens 信息以便验证自定义值是否生效
    const maxTokensLog = upstreamBody.max_tokens || upstreamBody.max_output_tokens || 'N/A';
    console.log(`[Responses] -> ${upstreamUrl} (model: ${originalModel} -> ${resolvedModel}, max_tokens: ${maxTokensLog}, stream: ${isStream}, api: ${useAnthropic ? 'anthropic' : 'openai'}, token: #${auth.upstreamToken?.id || 'env'}, local: ${auth.mode === 'local' ? '#' + auth.localTokenId : 'passthrough'})`);

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
      // 流式请求需要从 SSE 数据中提取 Token 用量
      let streamUsage = null;
      const transformed = response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          const text = decoder.decode(chunk, { stream: true });
          // 尝试从 SSE data 行中提取 usage 信息
          const lines = text.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              try {
                const json = JSON.parse(line.slice(6));
                if (json.usage) streamUsage = json.usage;
              } catch {}
            }
          }
          const converted = converter.process(text);
          if (converted) controller.enqueue(encoder.encode(converted));
        },
        async flush(controller) {
          const remaining = converter.flush();
          if (remaining) controller.enqueue(encoder.encode(remaining));
          // 流结束时异步更新 Token 用量统计
          if (streamUsage && auth.localTokenId) {
            try {
              const inputTokens = streamUsage.prompt_tokens || streamUsage.input_tokens || 0;
              const outputTokens = streamUsage.completion_tokens || streamUsage.output_tokens || 0;
              if (inputTokens > 0 || outputTokens > 0) {
                await updateLocalTokenUsage(env.DB, auth.localTokenId, inputTokens, outputTokens);
              }
            } catch (e) { console.error('Stream usage update error:', e.message); }
          }
        },
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
    // 加载模型元数据缓存，用于获取每个模型的默认 max_output_tokens
    // 原因：不同模型的最大输出 Token 限制不同，需要根据模型自动设置合理默认值
    if (!modelMetaLoaded) await loadModelMetaFromDb(env);

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

    // 获取当前模型的默认 max_output_tokens
    // 优先级：runtimeMaxOutputTokens（全局设置）> 模型元数据中的 max_output_tokens > 64000（硬编码默认）
    const modelMeta = runtimeModelMeta[resolvedModel];
    const defaultMaxTokens = modelMeta?.max_output_tokens || 64000;

    // 自动注入 max_tokens（Chat Completions 格式）
    // 原因：部分客户端可能不传 max_tokens，需要根据模型能力设置合理默认值
    if (!reqBody.max_tokens) {
      reqBody.max_tokens = runtimeMaxOutputTokens || defaultMaxTokens;
    }
    // 同时设置 max_output_tokens（Responses API 格式），兼容两种 API 格式
    if (!reqBody.max_output_tokens) {
      reqBody.max_output_tokens = runtimeMaxOutputTokens || defaultMaxTokens;
    }

    const useAnthropic = isAnthropicModel(resolvedModel);
    let upstreamBody, upstreamPath;

    if (useAnthropic) {
      const pseudoResponsesBody = { model: resolvedModel, messages: reqBody.messages, stream: reqBody.stream || false, max_output_tokens: reqBody.max_tokens, temperature: reqBody.temperature, top_p: reqBody.top_p, stop: reqBody.stop, tools: reqBody.tools };
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
    
    // 流式请求添加 stream_options 以获取 Token 用量统计
    if (isStream && !useAnthropic && auth.localTokenId) {
      upstreamBody.stream_options = { include_usage: true };
    }
    
    // 记录请求日志，包含 max_tokens 信息以便验证自定义值是否生效
    const maxTokensLog = upstreamBody.max_tokens || upstreamBody.max_output_tokens || 'N/A';
    console.log(`[Chat] -> ${upstreamUrl} (model: ${originalModel} -> ${resolvedModel}, max_tokens: ${maxTokensLog}, api: ${useAnthropic ? 'anthropic' : 'openai'}, token: #${auth.upstreamToken?.id || 'env'}, local: ${auth.mode === 'local' ? '#' + auth.localTokenId : 'passthrough'})`);

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
        // 流式请求需要从 SSE 数据中提取 Token 用量
        // 原因：统计每个本地 Token 的累计输入/输出 Token 数
        let usage = null;
        const transformed = response.body.pipeThrough(new TransformStream({
          transform(chunk, controller) { 
            const text = decoder.decode(chunk, { stream: true }); 
            const converted = converter.process(text); 
            if (converted) controller.enqueue(encoder.encode(converted));
            // 尝试从 SSE data 行中提取 Anthropic usage 信息
            // 原因：Anthropic 在 message_start 和 message_delta 事件中返回 usage
            const lines = text.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                  const json = JSON.parse(line.slice(6));
                  if (json.type === 'message_delta' && json.usage) usage = json.usage;
                  if (json.type === 'message_start' && json.message?.usage) usage = json.message.usage;
                } catch {}
              }
            }
          },
          async flush(controller) { 
            const remaining = converter.flush(); 
            if (remaining) controller.enqueue(encoder.encode(remaining)); 
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            // 流结束时更新 Token 用量
            // 原因：流式请求的 usage 在流结束时才能完整获取
            if (usage && auth.localTokenId) {
              const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
              const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
              if (inputTokens > 0 || outputTokens > 0) {
                await updateLocalTokenUsage(env.DB, auth.localTokenId, inputTokens, outputTokens);
                addLog(env.DB, ctx, { level: 'info', type: 'usage', message: `流式请求 Token 用量: 输入 ${inputTokens}, 输出 ${outputTokens}`, localTokenId: auth.localTokenId });
              }
            }
          },
        }));
        await recordRequestStats(env.DB, ctx, auth.localTokenId, auth.upstreamToken?.id, originalModel, resolvedModel, useAnthropic ? 'anthropic' : 'openai', isStream, response.status, durationMs, '/v1/chat/completions');
        return new Response(transformed, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', ...corsHeaders() } });
      } else {
        // OpenAI 格式的流式请求
        const decoder = new TextDecoder();
        // 流式请求需要从 SSE 数据中提取 Token 用量
        // 原因：统计每个本地 Token 的累计输入/输出 Token 数
        let usage = null;
        const transformed = response.body.pipeThrough(new TransformStream({
          async transform(chunk, controller) {
            const text = decoder.decode(chunk, { stream: true });
            controller.enqueue(chunk);
            // 尝试从 SSE data 行中提取 OpenAI usage 信息
            // 原因：OpenAI 流式响应在最后一个 chunk 中返回 usage（需请求时带 stream_options）
            const lines = text.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                  const json = JSON.parse(line.slice(6));
                  if (json.usage) usage = json.usage;
                } catch {}
              }
            }
          },
          async flush(controller) {
            // 流结束时更新 Token 用量
            // 原因：流式请求的 usage 在流结束时才能完整获取
            if (usage && auth.localTokenId) {
              const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
              const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
              if (inputTokens > 0 || outputTokens > 0) {
                await updateLocalTokenUsage(env.DB, auth.localTokenId, inputTokens, outputTokens);
                addLog(env.DB, ctx, { level: 'info', type: 'usage', message: `流式请求 Token 用量: 输入 ${inputTokens}, 输出 ${outputTokens}`, localTokenId: auth.localTokenId });
              }
            }
          },
        }));
        await recordRequestStats(env.DB, ctx, auth.localTokenId, auth.upstreamToken?.id, originalModel, resolvedModel, useAnthropic ? 'anthropic' : 'openai', isStream, response.status, durationMs, '/v1/chat/completions');
        return new Response(transformed, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', ...corsHeaders() } });
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
    if (path === '/v1/models' && request.method === 'GET') return handleModels(request, env, ctx);

    // ---- 认证 ----
    if (path === '/api/auth' && request.method === 'POST') {
      const currentPassword = await getPasswordFromDb(env);
      const body = await request.json();
      if (body.password === currentPassword) {
        await logInfo(env.DB, ctx, 'auth', '管理员登录成功');
        return jsonResponse({ success: true, message: '登录成功' });
      }
      await logWarn(env.DB, ctx, 'auth', '管理员登录失败：密码错误');
      return jsonResponse({ error: { message: '密码错误' } }, 401);
    }
    if (path === '/api/auth/change' && request.method === 'POST') {
      const currentPassword = await getPasswordFromDb(env);
      const body = await request.json();
      if (body.oldPassword !== currentPassword) {
        await logWarn(env.DB, ctx, 'auth', '修改密码失败：当前密码错误');
        return jsonResponse({ error: { message: '当前密码错误' } }, 401);
      }
      if (!body.newPassword || body.newPassword.length < 4) return jsonResponse({ error: { message: '新密码至少 4 位' } }, 400);
      if (env.DB) { try { await ensureDb(env); await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('web_password', body.newPassword).run(); } catch (e) { console.error('Save password error:', e.message); } }
      await logInfo(env.DB, ctx, 'auth', '管理员密码已修改');
      return jsonResponse({ success: true, message: '密码已修改' });
    }

    // ---- 上游 Token 池 API ----
    if (path === '/api/upstream-tokens' && request.method === 'GET') {
      if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
      return handleGetUpstreamTokens(env);
    }
    if (path === '/api/upstream-tokens' && request.method === 'POST') {
      if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
      return handleCreateUpstreamToken(request, env, ctx);
    }
    if (path === '/api/upstream-tokens/health-check' && request.method === 'POST') {
      if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
      return handleHealthCheck(env, ctx);
    }
    const upstreamMatch = path.match(/^\/api\/upstream-tokens\/(\d+)$/);
    if (upstreamMatch) {
      const id = parseInt(upstreamMatch[1], 10);
      if (request.method === 'PUT') {
        if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
        return handleUpdateUpstreamToken(request, env, ctx, id);
      }
      if (request.method === 'DELETE') {
        if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
        return handleDeleteUpstreamToken(env, ctx, id);
      }
    }

    // ---- 本地 Token API ----
    if (path === '/api/local-tokens' && request.method === 'GET') {
      if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
      return handleGetLocalTokens(env);
    }
    if (path === '/api/local-tokens' && request.method === 'POST') {
      if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
      return handleCreateLocalToken(request, env, ctx);
    }
    const localMatch = path.match(/^\/api\/local-tokens\/(\d+)$/);
    if (localMatch) {
      const id = parseInt(localMatch[1], 10);
      if (request.method === 'PUT') {
        if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
        return handleUpdateLocalToken(request, env, ctx, id);
      }
      if (request.method === 'DELETE') {
        if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
        return handleDeleteLocalToken(env, ctx, id);
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
      return handleSetDefaultModel(request, env, ctx);
    }

    // ---- 增强版日志 API ----
    if (path === '/api/logs' && request.method === 'GET') {
      if (!env.DB) return jsonResponse({ logs: [], total: 0, error: 'DB binding not found' });
      try {
        await ensureDb(env);
        // 支持多种查询参数
        const since = parseInt(url.searchParams.get('since') || '0', 10);
        const limit = parseInt(url.searchParams.get('limit') || '100', 10);
        const level = url.searchParams.get('level'); // info, warn, error, debug
        const type = url.searchParams.get('type'); // request, auth, db, system, error
        
        // 构建查询条件
        let whereClause = '';
        const conditions = [];
        if (since > 0) conditions.push(`id > ${since}`);
        if (level) conditions.push(`level = '${level}'`);
        if (type) conditions.push(`type = '${type}'`);
        if (conditions.length > 0) whereClause = 'WHERE ' + conditions.join(' AND ');
        
        // 获取总数
        const countResult = await env.DB.prepare(`SELECT COUNT(*) as cnt FROM logs ${whereClause}`).first();
        const total = countResult ? countResult.cnt : 0;
        
        // 获取日志
        const query = since > 0 
          ? `SELECT * FROM logs ${whereClause} ORDER BY id ASC LIMIT ?`
          : `SELECT * FROM logs ${whereClause} ORDER BY id DESC LIMIT ?`;
        const logsResult = await env.DB.prepare(query).bind(Math.min(limit, 500)).all();
        const logs = logsResult.results || [];
        
        // 映射字段
        const mapped = logs.map(r => ({
          id: r.id,
          time: r.time,
          level: r.level || 'info',
          type: r.type || 'request',
          message: r.message || '',
          method: r.method,
          path: r.path,
          model: r.model,
          resolvedModel: r.resolved_model,
          api: r.api,
          stream: !!r.stream,
          status: r.status,
          localTokenId: r.local_token_id,
          upstreamTokenId: r.upstream_token_id,
          durationMs: r.duration_ms,
          extra: r.extra ? JSON.parse(r.extra) : null,
        }));
        
        // 非增量模式倒序
        if (!since) mapped.reverse();
        
        return jsonResponse({ logs: mapped, total, limit, level, type });
      } catch (e) { 
        console.error('Logs read error:', e.message); 
        return jsonResponse({ logs: [], total: 0, error: e.message }); 
      }
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

    // ---- 模型元数据管理 API ----
    // GET: 获取所有模型元数据
    if (path === '/api/model-meta' && request.method === 'GET') {
      if (!env.DB) return jsonResponse({ models: [], error: 'DB not available' });
      try {
        await ensureDb(env);
        const result = await env.DB.prepare('SELECT * FROM model_meta ORDER BY vendor, model_id').all();
        return jsonResponse({ models: result.results || [] });
      } catch (e) {
        console.error('Get model-meta error:', e.message);
        return jsonResponse({ error: { message: '获取模型元数据失败: ' + e.message } }, 500);
      }
    }
    
    // POST: 创建或更新模型元数据（upsert）
    if (path === '/api/model-meta' && request.method === 'POST') {
      if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
      if (!env.DB) return jsonResponse({ error: { message: 'DB not available' } }, 500);
      const body = await request.json();
      const defaults = {
        contextWindow: 250000,
        maxOutputTokens: 64000,
        supportsVision: 0,
        supportsTools: 1,
        pricingInput: 0,
        pricingOutput: 0,
        apiFormat: 'openai'
      };
      const { modelId, vendor, contextWindow, maxOutputTokens, source, supportsVision, supportsTools, pricingInput, pricingOutput, apiFormat } = body;
      if (!modelId) return jsonResponse({ error: { message: 'modelId 必填' } }, 400);
      try {
        await ensureDb(env);
        await env.DB.prepare(
          'INSERT OR REPLACE INTO model_meta (model_id, vendor, context_window, max_output_tokens, source, supports_vision, supports_tools, pricing_input, pricing_output, api_format, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
        ).bind(
          modelId,
          vendor || 'Unknown',
          contextWindow ? parseInt(contextWindow, 10) : defaults.contextWindow,
          maxOutputTokens ? parseInt(maxOutputTokens, 10) : defaults.maxOutputTokens,
          source || '',
          supportsVision !== undefined ? (supportsVision ? 1 : 0) : defaults.supportsVision,
          supportsTools !== undefined ? (supportsTools ? 1 : 0) : defaults.supportsTools,
          pricingInput ? parseFloat(pricingInput) : defaults.pricingInput,
          pricingOutput ? parseFloat(pricingOutput) : defaults.pricingOutput,
          apiFormat || defaults.apiFormat
        ).run();
        return jsonResponse({ success: true, message: `模型 ${modelId} 元数据已保存` });
      } catch (e) {
        console.error('Save model-meta error:', e.message);
        return jsonResponse({ error: { message: '保存模型元数据失败: ' + e.message } }, 500);
      }
    }
    
    // DELETE: 删除模型元数据
    if (path === '/api/model-meta' && request.method === 'DELETE') {
      if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
      if (!env.DB) return jsonResponse({ error: { message: 'DB not available' } }, 500);
      const body = await request.json();
      const { modelId } = body;
      if (!modelId) return jsonResponse({ error: { message: 'modelId 必填' } }, 400);
      try {
        await ensureDb(env);
        await env.DB.prepare('DELETE FROM model_meta WHERE model_id = ?').bind(modelId).run();
        return jsonResponse({ success: true, message: `模型 ${modelId} 元数据已删除` });
      } catch (e) {
        console.error('Delete model-meta error:', e.message);
        return jsonResponse({ error: { message: '删除失败: ' + e.message } }, 500);
      }
    }
    
    // POST: 重新同步上游模型列表到 model_meta（为缺失的模型创建默认值）
    if (path === '/api/model-meta/sync' && request.method === 'POST') {
      if (!await checkAuth(request, env)) return jsonResponse({ error: { message: '未授权' } }, 401);
      if (!env.DB) return jsonResponse({ error: { message: 'DB not available' } }, 500);
      try {
        await ensureDb(env);
        // 从上游获取最新模型列表
        const upstream = getUpstreamUrl(env);
        const response = await fetch(upstream + '/v1/models', { 
          headers: { 'Content-Type': 'application/json' } 
        });
        const data = await response.json();
        const upstreamModels = data.data || [];
        // 为上游有新但 D1 中没有的模型创建默认元数据
        let created = 0;
        for (const m of upstreamModels) {
          const existing = await env.DB.prepare('SELECT model_id FROM model_meta WHERE model_id = ?').bind(m.id).first();
          if (!existing) {
            await env.DB.prepare(
              'INSERT INTO model_meta (model_id, vendor, context_window, max_output_tokens, source, supports_vision, supports_tools, pricing_input, pricing_output, api_format, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
            ).bind(m.id, 'Unknown', 250000, 64000, 'Default (未配置)', 0, 1, 0, 0, 'openai').run();
            created++;
          }
        }
        return jsonResponse({ success: true, message: `同步完成，新增 ${created} 个模型元数据` });
      } catch (e) {
        console.error('Sync model-meta error:', e.message);
        return jsonResponse({ error: { message: '同步失败: ' + e.message } }, 500);
      }
    }

    // ---- 代理路由 ----
    if (path === '/v1/responses' && request.method === 'POST') return handleResponses(request, env, ctx);
    if (path === '/v1/chat/completions' && request.method === 'POST') return handleChatCompletions(request, env, ctx);

    if (path.startsWith('/v1/')) return jsonResponse({ error: { message: `Route ${request.method} ${path} not found` } }, 404);

    // ---- 日志查看页面 ----
    if (path === '/logs' || path === '/logs.html') {
      return new Response(getLogsPageHtml(), { 
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders() } 
      });
    }

    // ---- 静态页面 ----
    if (path === '/' || path === '/index.html' || path === '/favicon.ico') {
      if (path === '/favicon.ico') return new Response(null, { status: 204 });
      return new Response(indexHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders() } });
    }

    return jsonResponse({ error: { message: `Route ${request.method} ${path} not found` } }, 404);
  },
};

/**
 * 生成日志查看页面 HTML
 * 原因：提供独立的日志查看页面，方便排查问题
 */
function getLogsPageHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>系统日志 - OpenCode Go API Proxy</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e1e4e8; min-height: 100vh; }
  .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
  h1 { font-size: 24px; margin-bottom: 8px; color: #fff; }
  .subtitle { color: #8b949e; margin-bottom: 20px; font-size: 14px; }
  
  /* 筛选栏 */
  .filter-bar { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 16px; margin-bottom: 20px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .filter-bar label { color: #8b949e; font-size: 13px; }
  .filter-bar select, .filter-bar input { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 6px 10px; color: #e1e4e8; font-size: 13px; outline: none; }
  .filter-bar select:focus, .filter-bar input:focus { border-color: #58a6ff; }
  .filter-bar button { background: #238636; color: #fff; border: none; padding: 6px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .filter-bar button:hover { background: #2ea043; }
  .filter-bar button.secondary { background: #21262d; color: #8b949e; border: 1px solid #30363d; }
  .filter-bar button.secondary:hover { color: #e1e4e8; border-color: #8b949e; }
  .filter-bar button.danger { background: #da3633; }
  .filter-bar button.danger:hover { background: #f85149; }
  
  /* 统计信息 */
  .stats { display: flex; gap: 16px; margin-bottom: 16px; }
  .stat-item { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px 16px; }
  .stat-label { color: #8b949e; font-size: 12px; }
  .stat-value { color: #fff; font-size: 20px; font-weight: 600; }
  
  /* 日志表格 */
  .logs-table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #30363d; border-radius: 12px; overflow: hidden; }
  .logs-table th { background: #21262d; padding: 10px 12px; text-align: left; font-size: 12px; color: #8b949e; font-weight: 600; border-bottom: 1px solid #30363d; position: sticky; top: 0; }
  .logs-table td { padding: 8px 12px; font-size: 13px; border-bottom: 1px solid #1b1f23; vertical-align: top; }
  .logs-table tr:last-child td { border-bottom: none; }
  .logs-table tr:hover { background: #1c2129; }
  
  /* 日志级别标签 */
  .level-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .level-info { background: #1f3a28; color: #3fb950; }
  .level-warn { background: #3d2a1a; color: #d29922; }
  .level-error { background: #3d1a1a; color: #f85149; }
  .level-debug { background: #1a2a3d; color: #58a6ff; }
  
  /* 日志类型标签 */
  .type-badge { display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: 500; background: #21262d; color: #8b949e; }
  
  /* 状态码 */
  .status-ok { color: #3fb950; font-weight: 600; }
  .status-err { color: #f85149; font-weight: 600; }
  
  /* 时间 */
  .time { color: #484f58; font-size: 12px; white-space: nowrap; }
  
  /* 消息 */
  .message { color: #c9d1d9; max-width: 400px; word-break: break-all; }
  
  /* 额外数据 */
  .extra-toggle { color: #58a6ff; cursor: pointer; font-size: 12px; }
  .extra-data { display: none; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; padding: 8px; margin-top: 4px; font-family: monospace; font-size: 11px; color: #79c0ff; white-space: pre-wrap; word-break: break-all; max-width: 500px; }
  .extra-data.show { display: block; }
  
  /* 空状态 */
  .empty { text-align: center; padding: 40px; color: #484f58; }
  
  /* 自动刷新指示器 */
  .auto-refresh { display: flex; align-items: center; gap: 8px; }
  .auto-refresh input[type="checkbox"] { width: 16px; height: 16px; }
  .refresh-indicator { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
</style>
</head>
<body>
<div class="container">
  <h1>📋 系统日志</h1>
  <p class="subtitle">OpenCode Go API Proxy - 实时日志查看</p>
  
  <!-- 筛选栏 -->
  <div class="filter-bar">
    <label>级别:</label>
    <select id="filterLevel">
      <option value="">全部</option>
      <option value="info">Info</option>
      <option value="warn">Warn</option>
      <option value="error">Error</option>
      <option value="debug">Debug</option>
    </select>
    
    <label>类型:</label>
    <select id="filterType">
      <option value="">全部</option>
      <option value="request">Request</option>
      <option value="auth">Auth</option>
      <option value="db">Database</option>
      <option value="system">System</option>
      <option value="error">Error</option>
    </select>
    
    <label>数量:</label>
    <select id="filterLimit">
      <option value="50">50</option>
      <option value="100" selected>100</option>
      <option value="200">200</option>
      <option value="500">500</option>
    </select>
    
    <button onclick="fetchLogs()">刷新</button>
    <button class="secondary" onclick="clearLogs()">清空日志</button>
    
    <div class="auto-refresh">
      <input type="checkbox" id="autoRefresh" checked>
      <label for="autoRefresh">自动刷新</label>
      <div class="refresh-indicator" id="refreshIndicator"></div>
    </div>
  </div>
  
  <!-- 统计信息 -->
  <div class="stats">
    <div class="stat-item">
      <div class="stat-label">总日志数</div>
      <div class="stat-value" id="totalCount">-</div>
    </div>
    <div class="stat-item">
      <div class="stat-label">当前显示</div>
      <div class="stat-value" id="showCount">-</div>
    </div>
    <div class="stat-item">
      <div class="stat-label">错误数</div>
      <div class="stat-value" id="errorCount" style="color:#f85149">-</div>
    </div>
  </div>
  
  <!-- 日志表格 -->
  <table class="logs-table">
    <thead>
      <tr>
        <th style="width:80px">ID</th>
        <th style="width:160px">时间</th>
        <th style="width:60px">级别</th>
        <th style="width:70px">类型</th>
        <th>消息</th>
        <th style="width:60px">方法</th>
        <th>路径</th>
        <th style="width:120px">模型</th>
        <th style="width:60px">状态</th>
        <th style="width:70px">耗时</th>
      </tr>
    </thead>
    <tbody id="logsBody">
      <tr><td colspan="10" class="empty">加载中...</td></tr>
    </tbody>
  </table>
</div>

<script>
let refreshTimer = null;
let lastLogId = 0;

// 获取日志
async function fetchLogs() {
  const level = document.getElementById('filterLevel').value;
  const type = document.getElementById('filterType').value;
  const limit = document.getElementById('filterLimit').value;
  
  let url = '/api/logs?limit=' + limit;
  if (level) url += '&level=' + level;
  if (type) url += '&type=' + type;
  
  try {
    const resp = await fetch(url);
    const data = await resp.json();
    
    if (data.error) {
      document.getElementById('logsBody').innerHTML = '<tr><td colspan="10" class="empty">错误: ' + escapeHtml(data.error) + '</td></tr>';
      return;
    }
    
    renderLogs(data.logs || []);
    document.getElementById('totalCount').textContent = data.total || 0;
    document.getElementById('showCount').textContent = (data.logs || []).length;
    
    // 统计错误数
    const errorCount = (data.logs || []).filter(l => l.level === 'error').length;
    document.getElementById('errorCount').textContent = errorCount;
  } catch (e) {
    document.getElementById('logsBody').innerHTML = '<tr><td colspan="10" class="empty">加载失败: ' + escapeHtml(e.message) + '</td></tr>';
  }
}

// 渲染日志
function renderLogs(logs) {
  const tbody = document.getElementById('logsBody');
  if (logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">暂无日志</td></tr>';
    return;
  }
  
  tbody.innerHTML = '';
  logs.forEach(log => {
    const tr = document.createElement('tr');
    const statusClass = log.status >= 400 ? 'status-err' : 'status-ok';
    const levelClass = 'level-' + (log.level || 'info');
    
    tr.innerHTML = 
      '<td>' + log.id + '</td>' +
      '<td class="time">' + formatTime(log.time) + '</td>' +
      '<td><span class="level-badge ' + levelClass + '">' + (log.level || 'info').toUpperCase() + '</span></td>' +
      '<td><span class="type-badge">' + (log.type || 'request') + '</span></td>' +
      '<td class="message">' + escapeHtml(log.message || '-') + '</td>' +
      '<td>' + (log.method || '-') + '</td>' +
      '<td>' + escapeHtml(log.path || '-') + '</td>' +
      '<td>' + escapeHtml(log.model || '-') + (log.resolvedModel && log.resolvedModel !== log.model ? ' → ' + log.resolvedModel : '') + '</td>' +
      '<td class="' + statusClass + '">' + (log.status || '-') + '</td>' +
      '<td>' + (log.durationMs ? log.durationMs + 'ms' : '-') + '</td>';
    
    // 如果有额外数据，添加展开按钮
    if (log.extra) {
      const extraTd = tr.querySelector('.message');
      const extraDiv = document.createElement('div');
      extraDiv.className = 'extra-data';
      extraDiv.textContent = JSON.stringify(log.extra, null, 2);
      
      const toggle = document.createElement('span');
      toggle.className = 'extra-toggle';
      toggle.textContent = ' [详情]';
      toggle.onclick = () => extraDiv.classList.toggle('show');
      
      extraTd.appendChild(toggle);
      extraTd.appendChild(extraDiv);
    }
    
    tbody.appendChild(tr);
  });
}

// 清空日志
async function clearLogs() {
  if (!confirm('确定清空所有日志？此操作不可恢复。')) return;
  
  try {
    const resp = await fetch('/api/logs', { method: 'DELETE' });
    const data = await resp.json();
    if (data.success) {
      alert('日志已清空');
      fetchLogs();
    } else {
      alert('清空失败: ' + (data.error || '未知错误'));
    }
  } catch (e) {
    alert('清空失败: ' + e.message);
  }
}

// 格式化时间
function formatTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', { hour12: false });
}

// HTML 转义
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 自动刷新
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(fetchLogs, 3000);
  document.getElementById('refreshIndicator').style.display = 'block';
}

function stopAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  document.getElementById('refreshIndicator').style.display = 'none';
}

document.getElementById('autoRefresh').addEventListener('change', (e) => {
  if (e.target.checked) startAutoRefresh();
  else stopAutoRefresh();
});

// 初始化
fetchLogs();
startAutoRefresh();
</script>
</body>
</html>`;
}

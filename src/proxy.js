// 含上游 Token 池和本地 Token 统计的代理核心逻辑
// reasons see database.js comments

const crypto = require('crypto');
const db = require('./database'); // 导入数据库操作层

// Runtime default model（可通过 Web UI 动态修改，无需重启）
let runtimeDefaultModel = null;

// ---- 模型 API 协议分类 ----
// 模型分为 OpenAI 兼容和 Anthropic 兼容两种协议，选择不同上游端点
// 原因：不同模型对应不同上游 API，需要提前判断走哪条协议
const ANTHROPIC_MODELS = new Set([
  'minimax-m3', 'minimax-m2.7', 'minimax-m2.5',
  'qwen3.7-max', 'qwen3.7-plus',
]);

// ---- 内置模型映射表 ----
// 覆盖主流 Codex CLI / OpenAI SDK 常用的模型名，转换为 OpenCode Go 可用模型名
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

// ============================
// 上游 Token 池选择逻辑
// ============================

/**
 * 检查并恢复过期的禁用 Token
 * 原因：被禁用的 Token 超过 check_interval_minutes 后，自动发起探测请求验证是否恢复
 * 每次最多检查 3 个最早过期的禁用 Token，避免流量大时开销过大
 */
async function checkAndRecoverDisabledTokens(upstreamBaseUrl) {
  try {
    const expired = db.getExpiredDisabledTokens();
    if (!expired || expired.length === 0) return;

    for (const tokenRecord of expired) {
      try {
        const testUrl = buildUpstreamUrl(
          tokenRecord.upstream_url || upstreamBaseUrl,
          '/v1/models'
        );
        const response = await fetch(testUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${tokenRecord.token}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
        });

        if (response.ok) {
          // 探测成功：恢复该 Token
          db.enableUpstreamToken(tokenRecord.id);
          console.log(`[HealthCheck] Token #${tokenRecord.id}(${tokenRecord.name}) 自动恢复成功`);
        } else {
          // 仍然失败：延长禁用时间（下次再试）
          db.disableUpstreamToken(tokenRecord.id);
          console.log(`[HealthCheck] Token #${tokenRecord.id}(${tokenRecord.name}) 仍然不可用，保持禁用`);
        }
      } catch (err) {
        // 网络错误：保持禁用，更新 disabled_at 推迟下次检查
        db.disableUpstreamToken(tokenRecord.id);
        console.log(`[HealthCheck] Token #${tokenRecord.id}(${tokenRecord.name}) 探测失败: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('[HealthCheck] 检查禁用 Token 时出错:', err.message);
  }
}

/**
 * 从上游 Token 池中选择一个 Token
 * 算法：usage_count / weight 比值最低者优先（负载均衡策略）
 * 原因：weight 大的 Token 理论承载能力高，允许更多请求；usage 小的更能均衡分配
 * 只考虑 enabled=1 的 Token，无可用 Token 时返回 null
 */
function selectUpstreamToken(upstreamBaseUrl) {
  const enabledTokens = db.getEnabledUpstreamTokens();

  // 如果没有启用的 Token，返回 null（fallback 到环境变量或客户端透传）
  if (!enabledTokens || enabledTokens.length === 0) return null;

  // 先按 priority 升序排列（priority 小的优先，同优先级按 usage/weight 排序）
  const sorted = enabledTokens
    .map(t => ({
      ...t,
      ratio: t.usage_count / (t.weight || 1), // 防止除零，weight 至少为 1
    }))
    .sort((a, b) => {
      // 第一排序键：priority（越小越优先）
      if (a.priority !== b.priority) return a.priority - b.priority;
      // 第二排序键：usage/weight 比值（越小越优先）
      return a.ratio - b.ratio;
    });

  return sorted[0]; // 返回最优 Token
}

// ============================
// 认证与配置加载
// ============================

/**
 * 解析请求中的认证信息
 * 新逻辑（本地优先）：
 *   1. 检查 Bearer Token 是否存在于 local_tokens 表 → 找到则走本地 Token 流程
 *   2. 未找到 → 走 passthrough（旧逻辑，客户端 Token 原样转发）
 * 原因：兼容旧 API Key 配置，同时支持新的本地 Token 体系
 */
function resolveAuth(clientToken, upstreamBaseUrl) {
  const now = Date.now();
  const startTime = now;

  // 1. 先发健康检查（异步，不阻塞请求）
  checkAndRecoverDisabledTokens(upstreamBaseUrl).catch(() => {});

  // 2. 优先查找本地 Token 表
  if (clientToken) {
    const localToken = db.getLocalTokenByValue(clientToken);
    if (localToken && localToken.enabled) {
      // 找到有效本地 Token
      const upstreamToken = selectUpstreamToken(upstreamBaseUrl);
      return {
        mode: 'local',
        localTokenId: localToken.id,
        upstreamToken,
        upstreamBaseUrl,
        actualToken: upstreamToken ? upstreamToken.token : (process.env.OPENCODE_TOKEN || clientToken),
        actualUpstreamUrl: upstreamToken 
          ? (upstreamToken.upstream_url || upstreamBaseUrl) 
          : upstreamBaseUrl,
      };
    }
  }

  // 3. 未找到本地 Token → passthrough（旧逻辑）
  return {
    mode: 'passthrough',
    localTokenId: null,
    upstreamToken: null,
    upstreamBaseUrl,
    actualToken: process.env.OPENCODE_TOKEN || clientToken || '',
    actualUpstreamUrl: upstreamBaseUrl,
  };
}

// ============================
// 记录使用统计（供业务层异步调用）
// ============================

/**
 * 请求完成后更新统计
 * 原因：本地 Token 用量、上游 Token 使用次数、请求日志，三者统一在此更新
 * @param {string} requestPath - 原始请求路径（如 /v1/responses 或 /v1/chat/completions）
 */
function recordRequestStats(localTokenId, upstreamTokenId, model, resolvedModel, api, stream, status, durationMs, requestPath) {
  try {
    // 本地 Token 统计
    if (localTokenId) {
      if (status >= 200 && status < 300) {
        db.recordLocalSuccess(localTokenId);
      } else {
        db.recordLocalFail(localTokenId);
      }
    }

    // 上游 Token 使用计数
    if (upstreamTokenId && status >= 200 && status < 300) {
      db.incrementUpstreamUsage(upstreamTokenId);
    }

    // 构建描述性消息
    const statusText = status >= 200 && status < 300 ? '成功' : '失败';
    const message = `${requestPath || '/v1/chat/completions'} ${statusText} (${status}) ${model}→${resolvedModel} ${stream ? 'stream' : ''} ${durationMs}ms`;

    // 写入请求日志（使用原始请求路径，而非上游路径）
    db.addLog({
      level: status >= 400 ? 'error' : 'info',
      type: 'request',
      message,
      method: 'POST',
      path: requestPath || '/v1/chat/completions',
      model,
      resolvedModel,
      api,
      stream: !!stream,
      status,
      localTokenId,
      upstreamTokenId,
      durationMs,
    });
  } catch (err) {
    // 统计失败不影响主流程，静默处理
    console.error('[Stats] 记录统计失败:', err.message);
  }
}

// ============================
// 原有工具函数（保持不变） ----
// ============================

function isAnthropicModel(modelName) {
  const clean = modelName.replace(/^opencode-go\//, '');
  return ANTHROPIC_MODELS.has(clean);
}

function getRuntimeDefaultModel() {
  return runtimeDefaultModel;
}

function setRuntimeDefaultModel(model) {
  runtimeDefaultModel = model || null;
}

// 模型解析优先级：Runtime 强制 > env DEFAULT_MODEL > env MODEL_MAP > 内置映射 > 透传
// 原因：管理员可通过 Web UI 最灵活，env 变量作为兜底，内置映射覆盖常用模型
function resolveModel(modelName) {
  // 1. Runtime 强制模型（Web UI 设置，优先级最高）
  if (runtimeDefaultModel) {
    return runtimeDefaultModel.replace(/^opencode-go\//, '');
  }

  // 2. 环境变量 DEFAULT_MODEL
  if (process.env.DEFAULT_MODEL) {
    return process.env.DEFAULT_MODEL.replace(/^opencode-go\//, '');
  }

  // 3. 环境变量 MODEL_MAP（格式 from1:to1,from2:to2）
  const modelMapEnv = process.env.MODEL_MAP || '';
  if (modelMapEnv) {
    const pairs = modelMapEnv.split(',');
    for (const pair of pairs) {
      const [from, to] = pair.split(':');
      if (from?.trim() && to?.trim() && modelName === from.trim()) {
        return to.trim().replace(/^opencode-go\//, '');
      }
    }
  }

  // 4. 内置映射表
  if (DEFAULT_MODEL_MAP[modelName]) {
    return DEFAULT_MODEL_MAP[modelName];
  }

  // 5. 透传（去除前缀）
  return modelName.replace(/^opencode-go\//, '');
}

function buildUpstreamUrl(base, path) {
  const baseStr = (base || 'https://opencode.ai/zen/go').replace(/\/+$/, '');
  const pathStr = path.startsWith('/') ? path : '/' + path;
  return baseStr + pathStr;
}

/**
 * 规范化消息角色：将 'developer' 映射为 'system'
 * 原因：大多数上游 API 不支持 'developer' 角色，需要提前转换
 */
function normalizeRole(role) {
  if (role === 'developer') return 'system';
  return role;
}

// ---- 消息格式转换 ----

/**
 * 将 Responses API 的 input 字段转换为 Chat Completions 格式的 messages
 *原因：Responses API 使用扁平 input 数组，与 messages 格式不同，需要转换
 */
function convertInputToMessages(input) {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  if (!Array.isArray(input)) {
    return [{ role: 'user', content: JSON.stringify(input) }];
  }

  const messages = [];
  for (const item of input) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item });
      continue;
    }

    // 处理 function_call 类型（Assistant 的工具调用）
    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: item.call_id || item.id,
          type: 'function',
          function: {
            name: item.name,
            arguments: item.arguments || '{}',
          },
        }],
      });
      continue;
    }

    // 处理 function_call_output 类型（工具调用结果）
    if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id,
        content: item.output || '',
      });
      continue;
    }

    if (item.type === 'message' || item.role) {
      const role = normalizeRole(item.role || 'user');
      const content = item.content;

      // 处理 content 数组（可能包含 function_call 等混合块）
      if (Array.isArray(content)) {
        const textParts = [];
        const toolMessages = [];

        for (const part of content) {
          if (typeof part === 'string') {
            textParts.push(part);
          } else if (part.type === 'function_call') {
            toolMessages.push({
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: part.call_id || part.id,
                type: 'function',
                function: { name: part.name, arguments: part.arguments || '{}' },
              }],
            });
          } else if (part.type === 'function_call_output') {
            toolMessages.push({
              role: 'tool',
              tool_call_id: part.call_id || part.id,
              content: part.output || '',
            });
          } else if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
            textParts.push(part.text || '');
          } else if (part.type === 'tool_use') {
            toolMessages.push({
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: part.call_id || part.id,
                type: 'function',
                function: { name: part.name, arguments: part.arguments || '{}' },
              }],
            });
          } else if (part.type === 'tool_result') {
            toolMessages.push({
              role: 'tool',
              tool_call_id: part.tool_use_id || part.call_id || part.id,
              content: part.content || '',
            });
          }
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
    if (item.content) {
      messages.push({ role: normalizeRole(item.role || 'user'), content: extractContent(item.content) });
    }
  }
  return messages;
}

/**
 * 从 content 对象中提取文本内容
 */
function extractContent(content) {
  if (typeof content === 'string') return content;
  if (!content) return '';
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') return part.text || '';
      if (part.type === 'input_image' || part.type === 'input_file') return `[${part.type}]`;
      // function_call 和 function_call_output 单独处理，此处跳过
      if (part.type === 'function_call' || part.type === 'function_call_output') return '';
      return part.text || JSON.stringify(part);
    }).filter(Boolean).join('\n');
  }
  if (typeof content === 'object') return content.text || JSON.stringify(content);
  return String(content);
}

/**
 * 转换工具定义：统一为 OpenAI function 格式
 * 原因：前端可能传 Responses API 格式（name/parameters 在顶层）或 Chat Completions 格式
 */
function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const filtered = tools
    .filter(tool => tool.type === 'function' || tool.name)
    .map(tool => {
      if (tool.type === 'function' && tool.function) {
        return tool;
      }
      return {
        type: 'function',
        function: {
          name: tool.name || tool.function?.name,
          description: tool.description || tool.function?.description || '',
          parameters: tool.parameters || tool.function?.parameters || { type: 'object', properties: {} },
        },
      };
    });
  return filtered.length > 0 ? filtered : undefined;
}

/**
 * 转换工具为 Anthropic 格式
 * 修复：从 tool.function 中提取 name/description/parameters，而非只看 tool.name
 * 原因：OpenAI 格式下 tool.name 为 undefined，实际 name 在 tool.function.name
 */
function convertToolsToAnthropic(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map(tool => {
    if (tool.type === 'function') {
      return {
        name: tool.name || tool.function?.name,
        description: tool.description || tool.function?.description || '',
        input_schema: tool.parameters || tool.function?.parameters || { type: 'object', properties: {} },
      };
    }
    if (tool.name) {
      return {
        name: tool.name,
        description: tool.description || '',
        input_schema: tool.parameters || tool.input_schema || { type: 'object', properties: {} },
      };
    }
    return tool;
  });
}

/**
 * 将 OpenAI Messages 转换为 Anthropic Messages 格式
 */
function convertToAnthropicMessages(messages) {
  let system = '';
  const anthropicMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system += (system ? '\n' : '') + (typeof msg.content === 'string' ? msg.content : extractContent(msg.content));
      continue;
    }

    // 处理 tool role（工具结果）- Anthropic 要求作为 user 消息的 tool_result
    if (msg.role === 'tool') {
      anthropicMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id || msg.id,
          content: msg.content || '',
        }],
      });
      continue;
    }

    let role = msg.role;
    let content = msg.content;

    // 处理带 tool_calls 的 assistant 消息
    if (role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
      const parts = [];
      if (content) {
        parts.push({ type: 'text', text: typeof content === 'string' ? content : extractContent(content) });
      }
      for (const tc of msg.tool_calls) {
        parts.push({
          type: 'tool_use',
          id: tc.id || tc.call_id,
          name: tc.function?.name || '',
          input: (() => { try { return JSON.parse(tc.function?.arguments || '{}'); } catch { return {}; } })(),
        });
      }
      anthropicMessages.push({ role: 'assistant', content: parts });
      continue;
    }

    const extracted = typeof content === 'string' ? content : extractContent(content);
    if (extracted) anthropicMessages.push({ role, content: [{ type: 'text', text: extracted }] });
  }

  return { system, messages: anthropicMessages };
}

// ---- 请求体转换 ----

/**
 * 将 Responses API 请求体转换为 OpenAI Chat Completions 格式
 */
function convertRequestToChatCompletions(body, resolvedModel) {
  const result = {
    model: resolvedModel,
    stream: body.stream || false,
  };

  if (body.input) {
    result.messages = convertInputToMessages(body.input);
  } else if (body.messages) {
    result.messages = body.messages;
  }

  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.max_tokens !== undefined) result.max_tokens = body.max_tokens;
  if (body.max_output_tokens !== undefined) result.max_tokens = body.max_output_tokens;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.frequency_penalty !== undefined) result.frequency_penalty = body.frequency_penalty;
  if (body.presence_penalty !== undefined) result.presence_penalty = body.presence_penalty;
  if (body.stop !== undefined) result.stop = body.stop;
  if (body.tools !== undefined) result.tools = convertTools(body.tools);
  if (body.tool_choice !== undefined) {
    if (body.tool_choice === 'auto' || body.tool_choice === 'none' || body.tool_choice === 'required') {
      result.tool_choice = body.tool_choice;
    } else if (typeof body.tool_choice === 'object' && body.tool_choice.function) {
      result.tool_choice = body.tool_choice;
    } else if (typeof body.tool_choice === 'object' && body.tool_choice.name) {
      result.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
    }
  }

  return result;
}

/**
 * 将 Responses API 请求体转换为 Anthropic Messages 格式
 */
function convertRequestToAnthropic(body, resolvedModel) {
  let messages = [];
  if (body.input) {
    messages = convertInputToMessages(body.input);
  } else if (body.messages) {
    messages = body.messages;
  }

  const { system, messages: anthropicMessages } = convertToAnthropicMessages(messages);

  const result = {
    model: resolvedModel,
    stream: body.stream || false,
    max_tokens: body.max_output_tokens || body.max_tokens || 64000,
    messages: anthropicMessages,
  };

  if (system) result.system = system;
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stop !== undefined) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];

  // 只包含有 tools 的场景（上游 500 如果只有 tool_choice 没有 tools）
  const convertedTools = body.tools !== undefined ? convertToolsToAnthropic(body.tools) : undefined;
  if (convertedTools && convertedTools.length > 0) {
    result.tools = convertedTools;

    if (body.tool_choice !== undefined) {
      if (body.tool_choice === 'auto') result.tool_choice = { type: 'auto' };
      else if (body.tool_choice === 'none') result.tool_choice = { type: 'none' };
      else if (body.tool_choice === 'required') result.tool_choice = { type: 'any' };
      else if (typeof body.tool_choice === 'object' && body.tool_choice.name) {
        result.tool_choice = { type: 'tool', name: body.tool_choice.name };
      }
    }
  }

  return result;
}

// ---- 响应格式转换 ----

/**
 * 将 OpenAI Chat Completions 响应转换为 Responses API 格式
 */
function convertChatCompletionToResponse(chatResp, originalModel) {
  const respId = `resp_${crypto.randomBytes(12).toString('hex')}`;
  const msgId = `msg_${crypto.randomBytes(12).toString('hex')}`;
  const choice = chatResp.choices?.[0];
  const message = choice?.message || {};
  const outputText = message.content || '';
  const output = [];

  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      output.push({
        type: 'function_call',
        id: tc.id || `call_${crypto.randomBytes(8).toString('hex')}`,
        call_id: tc.id,
        name: tc.function?.name || '',
        arguments: tc.function?.arguments || '{}',
      });
    }
  }

  output.push({
    type: 'message',
    id: msgId,
    role: 'assistant',
    content: [{ type: 'output_text', text: outputText, annotations: [] }],
  });

  const usage = chatResp.usage || {};
  return {
    id: respId,
    object: 'response',
    created_at: chatResp.created || Math.floor(Date.now() / 1000),
    model: originalModel,
    status: 'completed',
    output,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
    },
  };
}

/**
 * 将 Anthropic 响应转换为 Responses API 格式
 */
function convertAnthropicResponseToResponse(anthResp, originalModel) {
  const respId = `resp_${crypto.randomBytes(12).toString('hex')}`;
  const msgId = `msg_${crypto.randomBytes(12).toString('hex')}`;
  const output = [];
  let textContent = '';

  if (Array.isArray(anthResp.content)) {
    for (const block of anthResp.content) {
      if (block.type === 'text') {
        textContent += block.text || '';
      } else if (block.type === 'tool_use') {
        output.push({
          type: 'function_call',
          id: block.id || `call_${crypto.randomBytes(8).toString('hex')}`,
          call_id: block.id,
          name: block.name || '',
          arguments: JSON.stringify(block.input || {}),
        });
      }
    }
  }

  output.push({
    type: 'message',
    id: msgId,
    role: 'assistant',
    content: [{ type: 'output_text', text: textContent, annotations: [] }],
  });

  const usage = anthResp.usage || {};
  return {
    id: respId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: originalModel,
    status: 'completed',
    output,
    usage: {
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    },
  };
}

/**
 * 将 Anthropic 响应转换为 Chat Completions 格式
 */
function convertAnthropicToChatCompletion(anthResp, model) {
  const message = { role: 'assistant', content: '' };
  const toolCalls = [];

  if (Array.isArray(anthResp.content)) {
    for (const block of anthResp.content) {
      if (block.type === 'text') {
        message.content += block.text || '';
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
        });
      }
    }
  }

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  const usage = anthResp.usage || {};
  return {
    id: `chatcmpl-${crypto.randomBytes(12).toString('hex')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message,
      finish_reason: anthResp.stop_reason === 'end_turn' ? 'stop' : (anthResp.stop_reason === 'tool_use' ? 'tool_calls' : anthResp.stop_reason || 'stop'),
    }],
    usage: {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    },
  };
}

// ---- 流式转换器 ----

/**
 * 创建 Chat Completions stream → Responses API stream 的转换器
 * 原因：OpenAI 流式格式和 Responses API 流式格式事件名和结构不同
 */
function createChatStreamConverter(originalModel) {
  const respId = `resp_${crypto.randomBytes(12).toString('hex')}`;
  const msgId = `msg_${crypto.randomBytes(12).toString('hex')}`;
  const createdAt = Math.floor(Date.now() / 1000);

  let fullText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let headersSent = false;
  let toolCalls = [];
  let buffer = '';

  function buildBaseResponse(status) {
    const resp = {
      id: respId, object: 'response', created_at: createdAt, model: originalModel,
      output: [],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
    };
    if (status) resp.status = status;
    return resp;
  }

  function sse(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function processEvents(events, parts) {
    for (const part of parts) {
      let dataStr = '';
      for (const line of part.split('\n')) {
        if (line.startsWith('data:')) {
          dataStr += line.slice(5).trim();
        }
      }
      if (!dataStr) continue;

      if (dataStr === '[DONE]') {
        events.push(sse('response.output_text.done', { type: 'response.output_text.done', output_index: 0, content_index: 0, text: fullText }));
        events.push(sse('response.content_part.done', { type: 'response.content_part.done', output_index: 0, content_index: 0, part: { type: 'output_text', text: fullText, annotations: [] } }));

        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          events.push(sse('response.output_item.added', { type: 'response.output_item.added', output_index: i + 1, item: { type: 'function_call', id: tc.id, call_id: tc.id, name: tc.name, arguments: '' } }));
          events.push(sse('response.output_item.done', { type: 'response.output_item.done', output_index: i + 1, item: { type: 'function_call', id: tc.id, call_id: tc.id, name: tc.name, arguments: tc.arguments } }));
        }

        events.push(sse('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: msgId, role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] } }));

        const finalResp = buildBaseResponse('completed');
        for (const tc of toolCalls) {
          finalResp.output.push({ type: 'function_call', id: tc.id, call_id: tc.id, name: tc.name, arguments: tc.arguments });
        }
        finalResp.output.push({ type: 'message', id: msgId, role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] });
        events.push(sse('response.completed', { type: 'response.completed', response: finalResp }));
        continue;
      }

      try {
        const parsed = JSON.parse(dataStr);
        if (parsed.usage) {
          inputTokens = parsed.usage.prompt_tokens || inputTokens;
          outputTokens = parsed.usage.completion_tokens || outputTokens;
        }

        const choice = parsed.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};

        if (delta.role && !headersSent) {
          headersSent = true;
          events.push(sse('response.created', { type: 'response.created', response: buildBaseResponse('in_progress') }));
          events.push(sse('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: msgId, role: 'assistant', status: 'in_progress', content: [] } }));
          events.push(sse('response.content_part.added', { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }));
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index || 0;
            if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || '', name: tc.function?.name || '', arguments: '' };
            if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
          }
          continue;
        }

        if (delta.content) {
          fullText += delta.content;
          events.push(sse('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: delta.content }));
        }
      } catch (e) { /* skip malformed */ }
    }
  }

  function processChunk(chunk) {
    const events = [];
    buffer += chunk;
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    processEvents(events, parts);
    return events.join('');
  }

  processChunk.flush = function() {
    if (!buffer.trim()) return '';
    const events = [];
    processEvents(events, [buffer]);
    buffer = '';
    return events.join('');
  };

  return processChunk;
}

/**
 * 创建 Anthropic stream → Responses API stream 的转换器
 */
function createAnthropicStreamConverter(originalModel) {
  const respId = `resp_${crypto.randomBytes(12).toString('hex')}`;
  const msgId = `msg_${crypto.randomBytes(12).toString('hex')}`;
  const createdAt = Math.floor(Date.now() / 1000);

  let fullText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let headersSent = false;
  let toolCalls = [];
  let currentToolIndex = -1;
  let buffer = '';

  function buildBaseResponse(status) {
    const resp = {
      id: respId, object: 'response', created_at: createdAt, model: originalModel,
      output: [],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
    };
    if (status) resp.status = status;
    return resp;
  }

  function sse(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function processAnthropicEvents(events, parts) {
    for (const part of parts) {
      let dataStr = '';
      for (const line of part.split('\n')) {
        if (line.startsWith('data:')) dataStr += line.slice(5).trim();
      }
      if (!dataStr || dataStr === '[DONE]') continue;

      try {
        const parsed = JSON.parse(dataStr);
        const eventType = parsed.type;

        if (eventType === 'message_start') {
          const msg = parsed.message || {};
          inputTokens = msg.usage?.input_tokens || 0;
          if (!headersSent) {
            headersSent = true;
            events.push(sse('response.created', { type: 'response.created', response: buildBaseResponse('in_progress') }));
            events.push(sse('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: msgId, role: 'assistant', status: 'in_progress', content: [] } }));
            events.push(sse('response.content_part.added', { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }));
          }
        } else if (eventType === 'content_block_start') {
          const block = parsed.content_block || {};
          if (block.type === 'tool_use') {
            currentToolIndex = toolCalls.length;
            toolCalls.push({ id: block.id || '', name: block.name || '', arguments: '' });
            events.push(sse('response.output_item.added', { type: 'response.output_item.added', output_index: currentToolIndex + 1, item: { type: 'function_call', id: block.id || '', call_id: block.id || '', name: block.name || '', arguments: '' } }));
          }
        } else if (eventType === 'content_block_delta') {
          const delta = parsed.delta || {};
          if (delta.type === 'text_delta' && delta.text) {
            fullText += delta.text;
            events.push(sse('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: delta.text }));
          } else if (delta.type === 'input_json_delta' && delta.partial_json) {
            if (currentToolIndex >= 0 && toolCalls[currentToolIndex]) {
              toolCalls[currentToolIndex].arguments += delta.partial_json;
            }
          }
        } else if (eventType === 'message_delta') {
          outputTokens = parsed.usage?.output_tokens || 0;
        } else if (eventType === 'message_stop') {
          events.push(sse('response.output_text.done', { type: 'response.output_text.done', output_index: 0, content_index: 0, text: fullText }));
          events.push(sse('response.content_part.done', { type: 'response.content_part.done', output_index: 0, content_index: 0, part: { type: 'output_text', text: fullText, annotations: [] } }));

          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i];
            events.push(sse('response.output_item.added', { type: 'response.output_item.added', output_index: i + 1, item: { type: 'function_call', id: tc.id, call_id: tc.id, name: tc.name, arguments: '' } }));
            events.push(sse('response.output_item.done', { type: 'response.output_item.done', output_index: i + 1, item: { type: 'function_call', id: tc.id, call_id: tc.id, name: tc.name, arguments: tc.arguments } }));
          }

          events.push(sse('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: msgId, role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] } }));

          const finalResp = buildBaseResponse('completed');
          for (const tc of toolCalls) {
            finalResp.output.push({ type: 'function_call', id: tc.id, call_id: tc.id, name: tc.name, arguments: tc.arguments });
          }
          finalResp.output.push({ type: 'message', id: msgId, role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] });
          events.push(sse('response.completed', { type: 'response.completed', response: finalResp }));
        }
      } catch (e) { /* skip malformed */ }
    }
  }

  function processChunk(chunk) {
    const events = [];
    buffer += chunk;
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    processAnthropicEvents(events, parts);
    return events.join('');
  }

  processChunk.flush = function() {
    if (!buffer.trim()) return '';
    const events = [];
    processAnthropicEvents(events, [buffer]);
    buffer = '';
    return events.join('');
  };

  return processChunk;
}

/**
 * 创建 Anthropic stream → Chat Completions stream 的转换器
 */
function createAnthropicToChatStreamConverter(model) {
  const respId = `chatcmpl-${crypto.randomBytes(8).toString('hex')}`;
  let toolCallIndex = -1;
  let buffer = '';

  function sse(data) {
    return `data: ${JSON.stringify(data)}\n\n`;
  }

  function processAnthropicToChatEvents(events, parts) {
    for (const part of parts) {
      let dataStr = '';
      for (const line of part.split('\n')) {
        if (line.startsWith('data:')) dataStr += line.slice(5).trim();
      }
      if (!dataStr) continue;

      try {
        const parsed = JSON.parse(dataStr);
        const eventType = parsed.type;

        if (eventType === 'message_start') {
          events.push(sse({
            id: respId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
          }));
        } else if (eventType === 'content_block_start') {
          const block = parsed.content_block || {};
          if (block.type === 'tool_use') {
            toolCallIndex++;
            events.push(sse({
              id: respId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta: { tool_calls: [{ index: toolCallIndex, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }] }, finish_reason: null }],
            }));
          }
        } else if (eventType === 'content_block_delta') {
          const delta = parsed.delta || {};
          if (delta.type === 'text_delta' && delta.text) {
            events.push(sse({
              id: respId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }],
            }));
          } else if (delta.type === 'input_json_delta' && delta.partial_json) {
            events.push(sse({
              id: respId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta: { tool_calls: [{ index: toolCallIndex, function: { arguments: delta.partial_json } }] }, finish_reason: null }],
            }));
          }
        } else if (eventType === 'message_delta') {
          const stopReason = parsed.delta?.stop_reason;
          if (stopReason) {
            const finishReason = stopReason === 'end_turn' ? 'stop' : (stopReason === 'tool_use' ? 'tool_calls' : stopReason);
            events.push(sse({
              id: respId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            }));
          }
        }
      } catch (e) { /* skip malformed */ }
    }
  }

  function processChunk(chunk) {
    const events = [];
    buffer += chunk;
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    processAnthropicToChatEvents(events, parts);
    return events.join('');
  }

  processChunk.flush = function() {
    if (!buffer.trim()) return '';
    const events = [];
    processAnthropicToChatEvents(events, [buffer]);
    buffer = '';
    return events.join('');
  };

  return processChunk;
}

/**
 * 向上游发起 HTTP 请求（含超时控制）
 * 原因：上游响应可能很慢（模型推理时间长），需要 5 分钟超时避免无限挂起
 * 注：upstreamTokenId 已在外层 recordRequestStats 中使用，此处不再传入
 */
async function makeUpstreamRequest(url, body, token, useAnthropic) {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (useAnthropic) {
    headers['x-api-key'] = token;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const bodyStr = JSON.stringify(body);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000); // 5 分钟超时

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

// ---- 代理处理器工厂 ----

/**
 * 创建 Responses API 代理处理器
 * 新增功能：
 * 1. 本地 Token 认证（优先）/ passthrough 兼容
 * 2. 上游 Token 池负载均衡选择
 * 3. 请求完成后记录本地 Token 统计和上游 Token 使用计数
 * 4. 写请求日志
 */
function createResponsesProxyHandler() {
  return async (req, res) => {
    try {
      const upstreamBase = process.env.UPSTREAM_BASE_URL || 'https://opencode.ai/zen/go';
      const clientToken = req.headers.authorization?.replace('Bearer ', '');
      const startTime = Date.now();

      const auth = resolveAuth(clientToken, upstreamBase);

      if (!auth.actualToken) {
        return res.status(401).json({ error: { message: 'No authentication token provided.', type: 'authentication_error' } });
      }

      const originalModel = req.body?.model || 'unknown';
      const resolvedModel = resolveModel(originalModel);
      const isStream = req.body?.stream === true;
      const useAnthropic = isAnthropicModel(resolvedModel);

      let upstreamBody;
      let upstreamPath;

      if (useAnthropic) {
        upstreamBody = convertRequestToAnthropic(req.body, resolvedModel);
        upstreamPath = '/v1/messages';
      } else {
        upstreamBody = convertRequestToChatCompletions(req.body, resolvedModel);
        upstreamPath = '/v1/chat/completions';
      }

      const upstreamUrl = buildUpstreamUrl(auth.actualUpstreamUrl, upstreamPath);
      console.log(`[${new Date().toISOString()}] POST /v1/responses -> ${upstreamUrl} (model: ${originalModel} -> ${resolvedModel}, stream: ${isStream}, api: ${useAnthropic ? 'anthropic' : 'openai'}, token: #${auth.upstreamToken?.id || 'env'}, local: ${auth.mode === 'local' ? '#' + auth.localTokenId : 'passthrough'})`);

      const response = await makeUpstreamRequest(upstreamUrl, upstreamBody, auth.actualToken, useAnthropic);

      const durationMs = Date.now() - startTime;
      const status = response.status;

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Upstream error ${response.status}: ${errorText.substring(0, 500)}`);
        try {
          const errorJson = JSON.parse(errorText);
          recordRequestStats(auth.localTokenId, auth.upstreamToken?.id, originalModel, resolvedModel, useAnthropic ? 'anthropic' : 'openai', isStream, response.status, durationMs, '/v1/responses');
          return res.status(response.status).json(errorJson);
        } catch {
          recordRequestStats(auth.localTokenId, auth.upstreamToken?.id, originalModel, resolvedModel, useAnthropic ? 'anthropic' : 'openai', isStream, response.status, durationMs, '/v1/responses');
          return res.status(response.status).json({ error: { message: `Upstream error: ${response.status} ${errorText.substring(0, 200)}`, type: 'upstream_error' } });
        }
      }

      if (isStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const converter = useAnthropic
          ? createAnthropicStreamConverter(originalModel)
          : createChatStreamConverter(originalModel);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            const converted = converter(chunk);
            if (converted) res.write(converted);
          }
          const remaining = converter.flush();
          if (remaining) res.write(remaining);
        } catch (streamErr) {
          console.error('Stream read error:', streamErr.message);
          if (!res.writableEnded) {
            const errorEvent = `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { id: 'error', status: 'failed', error: { message: streamErr.message } } })}\n\n`;
            res.write(errorEvent);
          }
        }
        res.end();
        // 流式请求完成后记录统计
        recordRequestStats(auth.localTokenId, auth.upstreamToken?.id, originalModel, resolvedModel, useAnthropic ? 'anthropic' : 'openai', isStream, status, durationMs, '/v1/responses');
      } else {
        const data = await response.text();
        try {
          const upstreamResp = JSON.parse(data);
          if (upstreamResp.error) {
            // 上游返回 200 但包含 error 字段：使用 error 中的状态码或默认 502
            const errorStatus = upstreamResp.error?.status || upstreamResp.error?.http_status || status || 502;
            recordRequestStats(auth.localTokenId, auth.upstreamToken?.id, originalModel, resolvedModel, useAnthropic ? 'anthropic' : 'openai', isStream, errorStatus, durationMs, '/v1/responses');
            const usage = upstreamResp.usage || upstreamResp.error?.metadata?.usage || {};
            updateTokenUsageFromResponse(auth.localTokenId, usage);
            return res.status(errorStatus).json(upstreamResp);
          }
          if (useAnthropic) {
            res.json(convertAnthropicResponseToResponse(upstreamResp, originalModel));
          } else {
            res.json(convertChatCompletionToResponse(upstreamResp, originalModel));
          }
          // 非流式成功：记录统计和 usage
          recordRequestStats(auth.localTokenId, auth.upstreamToken?.id, originalModel, resolvedModel, useAnthropic ? 'anthropic' : 'openai', isStream, status, durationMs, '/v1/responses');
          const usageData = upstreamResp.usage || {};
          updateTokenUsageFromResponse(auth.localTokenId, usageData);
        } catch (e) {
          console.error('Response parse error:', e.message, 'Raw:', data.substring(0, 500));
          recordRequestStats(auth.localTokenId, auth.upstreamToken?.id, originalModel, resolvedModel, useAnthropic ? 'anthropic' : 'openai', isStream, 502, durationMs, '/v1/responses');
          return res.status(502).json({ error: { message: 'Failed to parse upstream response', type: 'server_error' } });
        }
      }

    } catch (err) {
      console.error('Proxy handler error:', err.message);
      if (!res.headersSent) res.status(502).json({ error: { message: `Upstream error: ${err.message}`, type: 'proxy_error' } });
      else res.end();
    }
  };
}

/**
 * 从上游响应中提取 usage 并更新本地 Token 的累计 Token 统计
 */
function updateTokenUsageFromResponse(localTokenId, usage) {
  try {
    if (!localTokenId || !usage) return;
    const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
    const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
    if (inputTokens > 0 || outputTokens > 0) {
      db.updateLocalTokenUsage(localTokenId, inputTokens, outputTokens);
    }
  } catch (err) {
    // usage 统计失败不影响主流程
  }
}

/**
 * 创建 Chat Completions API 代理处理器
 * 新增功能同 createResponsesProxyHandler
 */
function createChatCompletionsProxyHandler() {
  return async (req, res) => {
    try {
      const upstreamBase = process.env.UPSTREAM_BASE_URL || 'https://opencode.ai/zen/go';
      const clientToken = req.headers.authorization?.replace('Bearer ', '');
      const startTime = Date.now();

      const auth = resolveAuth(clientToken, upstreamBase);

      if (!auth.actualToken) {
        return res.status(401).json({ error: { message: 'No auth token', type: 'authentication_error' } });
      }

      const originalModel = req.body?.model || 'gpt-4o';
      const resolvedModel = resolveModel(originalModel);
      req.body.model = resolvedModel;

      const useAnthropic = isAnthropicModel(resolvedModel);
      let upstreamBody;
      let upstreamPath;

      if (useAnthropic) {
        // Anthropic 模型：构造 pseudo Responses body 再转为 Anthropic 格式
        // 原因：统一走 convertRequestToAnthropic 处理工具调用等边界情况
        const pseudoResponsesBody = {
          model: resolvedModel,
          messages: req.body.messages,
          stream: req.body.stream || false,
          max_output_tokens: req.body.max_tokens || 64000,
          temperature: req.body.temperature,
          top_p: req.body.top_p,
          stop: req.body.stop,
          tools: req.body.tools,
        };
        upstreamBody = convertRequestToAnthropic(pseudoResponsesBody, resolvedModel);
        upstreamPath = '/v1/messages';
      } else {
        // OpenAI 兼容模型：直接透传，仅做角色和工具格式规范化
        upstreamBody = { ...req.body };
        if (Array.isArray(upstreamBody.messages)) {
          upstreamBody.messages = upstreamBody.messages.map(m => ({
            ...m,
            role: normalizeRole(m.role),
          }));
        }
        if (upstreamBody.tools) {
          upstreamBody.tools = convertTools(upstreamBody.tools);
        }
        upstreamPath = '/v1/chat/completions';
      }

      const upstreamUrl = buildUpstreamUrl(auth.actualUpstreamUrl, upstreamPath);
      const isStream = req.body?.stream === true;

      console.log(`[${new Date().toISOString()}] POST /v1/chat/completions -> ${upstreamUrl} (model: ${originalModel} -> ${resolvedModel}, api: ${useAnthropic ? 'anthropic' : 'openai'}, token: #${auth.upstreamToken?.id || 'env'}, local: ${auth.mode === 'local' ? '#' + auth.localTokenId : 'passthrough'})`);

      const response = await makeUpstreamRequest(upstreamUrl, upstreamBody, auth.actualToken, useAnthropic);

      const durationMs = Date.now() - startTime;
      const status = response.status;

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Upstream error ${response.status}: ${errorText.substring(0, 500)}`);
        try {
          const errorJson = JSON.parse(errorText);
          recordRequestStats(auth.localTokenId, auth.upstreamToken?.id, originalModel, resolvedModel, useAnthropic ? 'anthropic' : 'openai', isStream, response.status, durationMs, '/v1/chat/completions');
          return res.status(response.status).json(errorJson);
        } catch {
          recordRequestStats(auth.localTokenId, auth.upstreamToken?.id, originalModel, resolvedModel, useAnthropic ? 'anthropic' : 'openai', isStream, response.status, durationMs, '/v1/chat/completions');
          return res.status(response.status).json({ error: { message: `Upstream error: ${response.status}`, type: 'upstream_error' } });
        }
      }

      if (isStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        if (useAnthropic) {
          // Anthropic stream → 转换为 Chat Completions stream
          const converter = createAnthropicToChatStreamConverter(resolvedModel);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              const converted = converter(chunk);
              if (converted) res.write(converted);
            }
            const remaining = converter.flush();
            if (remaining) res.write(remaining);
          } catch (streamErr) {
            console.error('Stream read error:', streamErr.message);
          }
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          // OpenAI stream 直接透传（无需转换）
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(decoder.decode(value, { stream: true }));
            }
          } catch (streamErr) {
            console.error('Stream read error:', streamErr.message);
          }
          res.end();
        }
        // 流式请求完成后记录统计
        recordRequestStats(auth.localTokenId, auth.upstreamToken?.id, originalModel, resolvedModel, useAnthropic ? 'anthropic' : 'openai', isStream, status, durationMs, '/v1/chat/completions');
      } else {
        const data = await response.text();
        try {
          const upstreamResp = JSON.parse(data);
          if (useAnthropic) {
            res.json(convertAnthropicToChatCompletion(upstreamResp, resolvedModel));
          } else {
            res.json(upstreamResp);
          }
          // 非流式成功：记录统计和 usage
          recordRequestStats(auth.localTokenId, auth.upstreamToken?.id, originalModel, resolvedModel, useAnthropic ? 'anthropic' : 'openai', isStream, status, durationMs, '/v1/chat/completions');
          const usageData = upstreamResp.usage || {};
          updateTokenUsageFromResponse(auth.localTokenId, usageData);
        } catch {
          // 解析响应失败：返回 502 而非原始数据，避免客户端收到无效 JSON 却认为成功
          recordRequestStats(auth.localTokenId, auth.upstreamToken?.id, originalModel, resolvedModel, useAnthropic ? 'anthropic' : 'openai', isStream, 502, durationMs, '/v1/chat/completions');
          return res.status(502).json({ error: { message: 'Failed to parse upstream response', type: 'server_error' } });
        }
      }

    } catch (err) {
      console.error('Chat handler error:', err.message);
      if (!res.headersSent) res.status(502).json({ error: { message: err.message, type: 'proxy_error' } });
      else res.end();
    }
  };
}

// 导出
module.exports = {
  createResponsesProxyHandler,
  createChatCompletionsProxyHandler,
  getRuntimeDefaultModel,
  setRuntimeDefaultModel,
  isAnthropicModel,
  // 新增导出（供 server.js 和测试使用）
  checkAndRecoverDisabledTokens,
  selectUpstreamToken,
  resolveAuth,
  recordRequestStats,
  db,
};

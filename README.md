# OpenCode Go API to Codex API Proxy

将 OpenCode Go API 转换为 Codex (OpenAI 兼容) API 格式的代理服务。支持 **Cloudflare Workers** 和 **Docker** 双部署。

## 功能特性

- 将 Codex CLI / OpenAI SDK 的请求转发到 OpenCode Go API
- 支持 Responses API (`/v1/responses`) 和 Chat Completions API (`/v1/chat/completions`)
- 支持流式响应 (SSE)
- 自动识别 Anthropic / OpenAI 兼容模型并转换协议
- **上游 Token 池负载均衡**：配置多个上游 API Token，按权重自动分配请求
- **本地访问 Token 管理**：生成多个本地 Token，客户端使用本地 Token 调用代理
- **实时使用统计**：每个本地 Token 的请求数、成功/失败、Token 用量实时统计
- **自动健康检查**：上游 Token 失败超阈值自动禁用，定时探测自动恢复
- Web UI 管理面板（模型管理 + Token 池 + 本地 Token + 统计）
- Cloudflare Workers 无服务器部署 / Docker 容器化部署

## 支持的模型

| 模型 | 模型 ID |
|------|---------|
| GLM-5.1 | glm-5.1 |
| GLM-5 | glm-5 |
| Kimi K2.5 | kimi-k2.5 |
| Kimi K2.6 | kimi-k2.6 |
| DeepSeek V4 Pro | deepseek-v4-pro |
| DeepSeek V4 Flash | deepseek-v4-flash |
| MiMo-V2.5 | mimo-v2.5 |
| MiMo-V2.5-Pro | mimo-v2.5-pro |
| MiniMax M3 | minimax-m3 |
| MiniMax M2.7 | minimax-m2.7 |
| MiniMax M2.5 | minimax-m2.5 |
| Qwen3.7 Max | qwen3.7-max |
| Qwen3.7 Plus | qwen3.7-plus |
| Qwen3.6 Plus | qwen3.6-plus |

## 部署

### 获取 OpenCode Go Token

访问 https://opencode.ai/auth 登录并获取你的 API Token。

---

### 方式一：Cloudflare Workers（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/luowei729/opencode-go-api-to-codex-api)

> 点击按钮一键部署到你的 Cloudflare 账号，自动 Fork 仓库并配置 GitHub Actions 持续部署。

#### 手动部署

1. **Fork 本仓库**到你的 GitHub 账号
2. **在 Cloudflare Dashboard 创建 Worker**：
   - 进入 Workers & Pages > Create > Workers
   - 记下你的 Account ID
3. **配置 GitHub Secrets**（仓库 Settings > Secrets and variables > Actions）：

   | Secret 名称 | 说明 |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | CF API Token（需要 Workers Scripts:Edit 权限） |
   | `CLOUDFLARE_ACCOUNT_ID` | 你的 CF Account ID |

4. **Push 到 main 分支**，GitHub Actions 自动部署

#### 设置环境变量

部署后在 CF Dashboard 的 Worker Settings > Variables 中配置：

| 变量名 | 必填 | 说明 |
|---|---|---|
| `UPSTREAM_BASE_URL` | 否 | 上游地址，默认 `https://opencode.ai/zen/go` |
| `DEFAULT_MODEL` | 否 | 强制所有请求使用的模型 |
| `MODEL_MAP` | 否 | 模型映射，格式 `from1:to1,from2:to2` |

> **安全说明**：CF Workers 部署**不在服务端存储用户 Token**。每个用户调用 API 时必须通过 `Authorization: Bearer <your_token>` 传递自己的 OpenCode Go Token。

#### 本地开发 (CF Workers)

```bash
npm install
cp .dev.vars.example .dev.vars   # 编辑填入配置
npm run cf:dev                    # 启动本地开发服务器
```

---

### 方式二：Docker Compose

```bash
# 配置环境变量
cp .env.example .env
# 编辑 .env 填入 OPENCODE_TOKEN、WEB_PASSWORD 等

# 构建并启动
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止
docker-compose down
```

**环境变量说明**（`.env`）：

| 变量名 | 必填 | 说明 |
|---|---|---|
| `PORT` | 否 | 监听端口，默认 `30001` |
| `UPSTREAM_BASE_URL` | 否 | 上游地址，默认 `https://opencode.ai/zen/go` |
| `OPENCODE_TOKEN` | 否 | 服务端 Token（设置后客户端无需传 Token） |
| `DEFAULT_MODEL` | 否 | 强制所有请求使用的模型 |
| `MODEL_MAP` | 否 | 模型映射，格式 `from1:to1,from2:to2` |
| `WEB_PASSWORD` | **是** | Web UI 管理密码（保护上游 Token 池和本地 Token 管理接口） |

---

### 方式三：直接运行

```bash
npm install
cp .env.example .env   # 编辑配置（必须设置 WEB_PASSWORD）
npm start               # 启动
npm run dev             # 开发模式（自动重载）
```

## 使用方法

### 配置 Codex CLI

```bash
# CF Workers 部署
export OPENAI_BASE_URL=https://your-worker.workers.dev/v1
export OPENAI_API_KEY=your_opencode_token   # 必须填写自己的 Token

# Docker 部署（若服务端已配置 OPENCODE_TOKEN，API_KEY 可填任意值）
export OPENAI_BASE_URL=http://localhost:30001/v1
export OPENAI_API_KEY=your_opencode_token

# 启动 codex
codex
```

### 使用 OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://your-worker.workers.dev/v1",  # 或 Docker: http://localhost:30001/v1
    api_key="your_opencode_token"                    # CF Workers 必须填写自己的 Token
)

response = client.chat.completions.create(
    model="kimi-k2.6",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### 使用 curl

```bash
# CF Workers 部署
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_opencode_token" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'

# Responses API
curl https://your-worker.workers.dev/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_opencode_token" \
  -d '{
    "model": "gpt-4o",
    "input": "Hello!",
    "stream": false
  }'
```

## API 端点

| 端点 | 说明 |
|------|------|
| `GET /` | Web UI 管理面板 |
| `GET /health` | 健康检查 |
| `GET /v1/models` | 获取可用模型列表 |
| `POST /v1/responses` | Responses API（转换为 Chat Completions / Anthropic） |
| `POST /v1/chat/completions` | Chat Completions API |
| `GET /api/default-model` | 获取当前强制模型 |
| `POST /api/default-model` | 设置强制模型 |
| `GET /api/upstream-tokens` | 获取上游 Token 池列表 |
| `POST /api/upstream-tokens` | 添加上游 Token |
| `PUT /api/upstream-tokens/:id` | 更新上游 Token |
| `DELETE /api/upstream-tokens/:id` | 删除上游 Token |
| `POST /api/upstream-tokens/health-check` | 手动触发健康检查 |
| `GET /api/local-tokens` | 获取本地 Token 列表 |
| `POST /api/local-tokens` | 生成本地 Token |
| `PUT /api/local-tokens/:id` | 更新本地 Token |
| `DELETE /api/local-tokens/:id` | 删除本地 Token |
| `GET /api/stats/overview` | 获取使用统计概览 |

## 上游 Token 池与负载均衡

### 工作原理

1. **上游 Token 池**：在 Web UI 中配置多个 OpenCode Go API Token，每个 Token 可设置：
   - `weight`：权重（正整数，越大承载越多请求）
   - `upstream_url`：独立上游地址（留空使用全局默认）
   - `max_failures`：最大失败次数（超过自动禁用）
   - `check_interval_minutes`：检查间隔（禁用后多久探测一次）
   - `priority`：优先级（数字越小越优先，用于恢复排序）

2. **负载均衡算法**：每次请求选择 `usage_count / weight` 比值最低的 Token（优先分配给使用量少的 Token）

3. **自动健康检查**：
   - 请求失败时 `fail_count += 1`，超过 `max_failures` 自动禁用
   - 每次请求前检查最多 3 个过期禁用的 Token，发送探测请求验证是否恢复
   - 探测成功自动恢复，探测失败延长禁用时间

### 本地访问 Token

1. **生成本地 Token**：在 Web UI 中生成，格式为 `lt_xxxxxxxxxxxxxxxx`
2. **客户端使用**：将本地 Token 作为 `Authorization: Bearer lt_xxx` 传给代理
3. **认证流程**：
   - 代理先查本地 Token 表，找到则走新流程（从上游池选 Token 转发）
   - 未找到则走旧流程（passthrough，客户端 Token 原样转发）
4. **使用统计**：每个本地 Token 实时统计请求数、成功/失败、输入/输出 Token 数

## 认证方式

| | CF Workers 部署 | Docker 部署 |
|---|---|---|
| **服务端 Token** | ✘ 不支持 | ✔ `.env` 中设置 `OPENCODE_TOKEN` |
| **客户端 Token** | ✔ 必须通过 `Authorization` 头传递 | ✔ 服务端未配置时使用客户端 Token |
| **本地 Token** | ✔ 通过 Web UI 生成，客户端使用 | ✔ 通过 Web UI 生成，客户端使用 |
| **管理密码** | ✔ 默认 `abcd.1234`，可修改 | ✔ `.env` 中设置 `WEB_PASSWORD`（必须） |

- **CF Workers**：安全优先，不在服务端存储任何用户密钥，每个用户必须传自己的 Token
- **Docker**：支持服务端统一配置 Token（适合团队内部使用），也支持客户端透传
- **本地 Token**：两种部署都支持，通过 Web UI 生成，客户端使用本地 Token 调用代理

## 项目结构

```
├── worker/                  # Cloudflare Workers
│   ├── index.js            # Workers 入口 (fetch handler)
│   └── proxy-logic.js      # 代理核心逻辑 (ESM)
├── src/                     # Node.js / Docker
│   ├── server.js           # Express 服务入口
│   ├── proxy.js            # 代理核心逻辑 (CJS)
│   ├── database.js         # SQLite 数据库操作封装
│   └── index.html          # Web UI
├── pages/
│   └── index.html          # Web UI (CF Workers 版本)
├── data/                    # SQLite 数据库文件（Docker 版，gitignore）
├── wrangler.toml           # CF Workers 配置
├── Dockerfile              # Docker 镜像
├── docker-compose.yml      # Docker Compose 编排
└── .github/workflows/      # GitHub Actions 自动部署
```

## 架构

```
Codex CLI / OpenAI SDK
        |
        v
┌─────────────────┐
│  Proxy Server   │  :30001
│  (this service) │
│                 │
│  ┌───────────┐  │
│  │ 本地 Token │  │  ← 客户端认证
│  │ 认证层    │  │
│  └─────┬─────┘  │
│        │        │
│  ┌─────▼─────┐  │
│  │ 上游 Token │  │  ← 负载均衡选择
│  │ 池选择    │  │
│  └─────┬─────┘  │
│        │        │
│  ┌─────▼─────┐  │
│  │ 协议转换  │  │  ← OpenAI ↔ Anthropic
│  │ 层        │  │
│  └─────┬─────┘  │
└────────┼────────┘
         │
         v
┌─────────────────────────┐
│  OpenCode Go API        │
│  opencode.ai/zen/go/v1  │
└─────────────────────────┘
```

## 更新日志

### 2026-06-08 12:35 - 模型透传功能

- **重要**: 修改 `resolveModel` 函数：未设置强制模型时透传用户请求的模型
- 移除默认 `qwen3.7-plus` 的硬编码
- 同步修改 Docker 和 Workers 版本
- 清除 D1 中的强制模型设置

### 2026-06-08 12:15 - 强制使用 qwen3.7-plus 模型

- **重要**: 修改 `resolveModel` 函数默认返回 `qwen3.7-plus`（OpenCode 不支持 GPT 模型）
- 移除复杂的模型映射逻辑，简化模型解析流程
- 同步修改 Docker 和 Workers 版本
- 通过 D1 数据库设置默认模型为 `qwen3.7-plus`

### 2026-06-08 19:05 - 第二轮审查 Bug 修复（7 项）

- **HIGH**: Workers 版默认密码添加启动警告，提醒管理员修改密码
- **MEDIUM**: `localStorage` 明文密码改为 `sessionStorage`，关闭浏览器后自动失效
- **MEDIUM**: 页面卸载时清除 `logsTimer` 定时器，避免内存泄漏
- **LOW**: 所有 `parseInt()` 调用补全 `radix=10`，防止字符串前导零被误解析为八进制
- **LOW**: `enabled` 字段增强类型兼容：字符串 `"0"` 现在正确识别为禁用
- **LOW**: `editUpstream()` 改为优先使用缓存数据，减少不必要的全量 API 调用
- **LOW**: 移除 `makeUpstreamRequest` 废弃的 `upstreamTokenId` 参数

### 2026-06-08 18:55 - 全面代码审查 Bug 修复（13 项）

**CRITICAL 修复：**
- 修复 Docker 版缺少 `/api/logs`（GET/DELETE）路由，导致"使用统计"标签页日志功能完全不工作
- 修复 Workers 版 `resolveModel` 忽略运行时强制模型和 DB model-map，导致 Web UI 设置的模型覆盖无效
- 修复 XSS 漏洞：`upstream_url` 字段未转义直接注入 innerHTML，管理员可被注入恶意脚本
- 修复 `convertToolsToAnthropic` 丢失工具名：OpenAI 格式下 `tool.name` 为 undefined，应从 `tool.function.name` 提取

**HIGH 修复：**
- 修复上游返回 200 但包含 error 字段时，代理也返回 200 的错误，现在返回 error 中的状态码或 502
- 修复 Chat Completions 非流式请求解析失败时，原始数据以 200 返回客户端，现在返回 502
- 修复 `GET /api/local-tokens` 未对 Token 值脱敏，现在只返回前 10 位 + `****`
- 修复 Workers 版健康检查 `fetch` 无超时设置，可能导致请求无限挂起，现在 10 秒超时
- 修复 Workers 版 `resolveAuth` passthrough 模式缺少 `OPENCODE_TOKEN` 环境变量回退
- 修复 Workers 版 `handleModels` 使用硬编码上游 URL 且缺少 OPENCODE_TOKEN 回退

**MEDIUM 修复：**
- 修复 `data/` 目录不存在时 Docker 版启动崩溃（`SQLITE_CANTOPEN`），自动创建目录
- 修复密码比较存在时序攻击风险，改用 `crypto.timingSafeEqual`
- 修复错误消息未转义导致的潜在 XSS（模型加载失败时的 `err.message`）

**代码清理：**
- 移除废弃的 `stmtIncrementLocalSuccess` 预编译语句（已有更好的替代实现）

### 2026-06-08 10:33 - Bug 修复（6 项）

- **CRITICAL**: 修复 `proxy.js` 中 `data` 变量作用域错误，非流式请求成功后会抛出 ReferenceError 导致崩溃
- **CRITICAL**: 修复 `database.js` 中 `recordLocalSuccess` 首次请求时 `success_count` 和 `total_requests` 不递增的 bug（过期变量导致错误分支）
- **SECURITY**: 修复 `GET /api/upstream-tokens` 无认证即可访问且泄露完整 Token 值的安全漏洞，现已要求管理密码认证并移除 `fullToken` 字段
- **修复**: 日志 `path` 字段现在记录原始请求路径（`/v1/responses` 或 `/v1/chat/completions`），而非上游转发路径
- **修复**: Express `:id` 路由参数增加 NaN 校验，防止非数字 ID 导致数据库查询异常
- **修复**: Workers 版同步修复上述所有问题（安全、日志路径、recordRequestStats 签名）

### 2026-06-08 - 新增上游 Token 池与本地 Token 管理

- **上游 Token 池**：支持配置多个上游 API Token，按权重负载均衡
- **独立上游地址**：每个上游 Token 可设置独有的上游服务器地址
- **本地访问 Token**：Web UI 生成多个本地 Token，客户端使用本地 Token 调用代理
- **实时使用统计**：每个本地 Token 的请求数、成功/失败、Token 用量实时统计
- **自动健康检查**：上游 Token 失败超阈值自动禁用，定时探测自动恢复
- **Tab 化 UI**：Web 管理面板分为模型管理、上游 Token 池、本地 Token、使用统计四个 Tab
- **Docker 版密码保护**：新增 `WEB_PASSWORD` 环境变量，保护管理接口
- **持久化存储**：Docker 版使用 SQLite（better-sqlite3），Workers 版使用 D1

## License

MIT

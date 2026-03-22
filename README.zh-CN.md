<div align="center">
  <img src="assets/readme_banner.png" width="500" alt="Banner">
  <br><br>
  <strong><font size="4">面向 Agent 的安全沙盒与监控协议</font></strong>
  
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-22+-green.svg" alt="Node.js"></a>
  <a href="https://www.python.org"><img src="https://img.shields.io/badge/Python-3.10+-blue.svg" alt="Python"></a>
  <br>
  
  <a href="./README.md">English</a> | <b>中文</b>
  
</div>


Paddock 是一个开源的 AI Agent 沙盒与监控协议。它的核心思路不是重写你的 Agent，而是把 Agent 放进一台隔离的 Linux MicroVM 中运行，在不破坏 Agent 自身能力的前提下，为其补上隔离、监控、审计、审批与回滚等平台级安全能力。

当前仓库以 [OpenClaw](https://github.com/anthropics/claude-code) 作为参考集成对象。你可以在 Paddock 创建的 `simple-box`（命令行Linux）或 `computer-box`（GUI Linux）中部署并运行 OpenClaw，同时通过 **AMP 协议** 观察它的每一次工具调用、LLM 请求、文件变化和安全裁决。

## 为什么需要 Paddock？

当今大多数 AI Agent 框架默认与用户拥有同等权限，这会导致一系列真实问题：

| 问题 | 后果 |
|------|------|
| **提示注入** | Agent 被操纵后执行危险操作 |
| **密钥泄露** | Agent 读取 `.env`、SSH key、数据库连接串后外泄 |
| **作用域逃逸** | Agent 从工作目录扩展到系统目录甚至宿主边界 |
| **执行不可观测** | 不知道 Agent 做了什么，出了问题无法复盘 |
| **操作不可逆** | 高风险操作做错后无法撤销 |

**Paddock 的解决方案：**

1. 让 Agent 在真正隔离的 Linux 沙盒（MicroVM）中运行
2. 让 Agent 的每一个关键行为都经过结构化协议（AMP）
3. 在不重写 Agent 的前提下，为其补上平台级安全层

Paddock 不是 OpenClaw 的 fork，也不是另一个 Agent 框架。它是：

- 一个**通用的 Agent 沙盒平台**
- 一套**标准化的 Agent 监控与边界协议**
- 一个**面向任意 Agent 的安全运行时**

## 核心特性

### 🔒 完整 Linux 沙盒隔离
Agent 运行在 BoxLite 驱动的 MicroVM 中，文件系统、网络和进程隔离在硬件级别实施，而非直接运行在宿主机。

### 🧠 保留 Agent 完整能力
OpenClaw 以完整环境模式运行。文件读写、命令执行、浏览器自动化等所有能力默认留在沙盒内部。

### 📡 AMP 监控协议
**Agent Monitoring Protocol** 提供统一的结构化事件流，覆盖命令、LLM 调用、工具调用、文件变化、安全裁决、审批和回滚。→ [完整 AMP 协议规范](./docs/AMP_PROTOCOL.zh-CN.md)

### 🛡️ 多层安全门禁
每一次工具调用在执行前都必须经过 **4 层安全引擎**：

| 层 | 机制 |
|----|------|
| **1. 规则引擎** | 模式匹配、命令注入检测、路径穿越防护 |
| **2. 污点追踪** | 数据流标签：`Secret`、`PII`、`ExternalContent`、`FileContent` |
| **3. 行为分析** | 序列模式检测、循环/断路器、异常评分 |
| **4. 信任衰减** | 会话级信任分（0–100），违规时惩罚加成 |

风险分数对应裁决级别：

| 风险分数 | 裁决 | 操作 |
|---------|------|------|
| 0–30 | `approve` | 立即执行 |
| 31–70 | `approve` | 执行并告警 |
| 71–90 | `ask` | 需要人工审批 |
| 91–100 | `reject` | 阻断执行 |

### 🧑‍⚖️ 人工审批（HITL）
高风险操作会在 Dashboard 中触发审批对话框。用户可以批准、拒绝或修改工具参数。

### 🔑 零信任凭证隔离
API 密钥**永远不进入沙盒**。Agent 使用假密钥；Sidecar LLM Proxy 拦截请求，控制面在宿主侧注入真实密钥后转发给 LLM 提供商。

### 🔗 宿主边界清晰
外部 API、TTS、channel、webhook 等宿主侧能力通过控制面和 MCP 边界显式接出——绝不静默泄漏宿主权限。

### 📊 实时 Dashboard
创建和管理沙盒、部署 Agent、发送命令、查看语义执行树、审查原始事件日志、配置 LLM 提供商、管理审批——全部通过 Web UI 完成。

### 📋 防篡改审计链
每个事件存储在 SQLite 中，附带 SHA-256 哈希链。每个事件的哈希由 `SHA256(prev_hash + id + seq + type + payload)` 计算，构成不可篡改的审计轨迹。

### 🎛️ 可选本地 LLM 审核与脱敏
可选启用本地 LLM，对原生 `amp.llm.request` / `amp.llm.response` 事件做语义审核，并生成审计用的脱敏摘要。审核和脱敏是两套独立接口，后续可以分别替换成更专业的模型。

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                          宿主机                              │
│                                                             │
│  ┌──────────┐    ┌──────────────────────────────────────┐   │
│  │Dashboard │◄──►│        控制面 Control Plane (:3100)   │   │
│  │  (:3200) │    │  ┌────────────┐  ┌───────────────┐   │   │
│  │          │    │  │  会话管理    │  │  事件存储      │   │   │
│  │ • 创建   │    │  │  Session    │  │  (SQLite +    │   │   │
│  │ • 部署   │    │  │  Manager   │  │   哈希链)      │   │   │
│  │ • 监控   │    │  ├────────────┤  ├───────────────┤   │   │
│  │ • 审批   │    │  │ LLM Relay  │  │ HITL 仲裁器   │   │   │
│  │ • 审计   │    │  │ (密钥注入   │  ├───────────────┤   │   │
│  └──────────┘    │  │  + 代理)   │  │ 快照管理器     │   │   │
│                  │  ├────────────┤  └───────────────┘   │   │
│                  │  │ 沙盒驱动    │                      │   │
│                  │  └────────────┘                      │   │
│                  └──────────────────────────────────────┘   │
│                           │                                  │
│              ┌────────────▼────────────┐                    │
│              │     MicroVM 沙盒         │                    │
│              │                         │                    │
│              │  ┌───────────────────┐  │                    │
│              │  │ Sidecar           │  │                    │
│              │  │ • LLM 代理 :8800   │  │                    │
│              │  │ • AMP 门禁 :8801   │  │                    │
│              │  │ • 策略引擎         │  │                    │
│              │  │ • 文件监控         │  │                    │
│              │  │ • 事件上报         │  │                    │
│              │  │ • 敏感数据保险库    │  │                    │
│              │  └───────────────────┘  │                    │
│              │                         │                    │
│              │  ┌───────────────────┐  │                    │
│              │  │ Agent 运行时       │  │                    │
│              │  │ (OpenClaw)        │  │                    │
│              │  │ + AMP 适配器       │  │                    │
│              │  └───────────────────┘  │                    │
│              │                         │                    │
│              └─────────────────────────┘                    │
└─────────────────────────────────────────────────────────────┘
```

### 包结构

| 包 | 说明 |
|---|------|
| `packages/control-plane` | 宿主机控制面：会话管理、事件存储、LLM Relay、资源边界、快照管理、Dashboard API |
| `packages/sidecar` | 运行在 VM 内部：LLM 代理、AMP Gate、安全引擎、文件监控、事件上报 |
| `packages/dashboard` | Web UI：沙盒管理、Agent 部署、监控、HITL 审批 |
| `packages/amp-openclaw` | OpenClaw AMP 适配层与运行时组件（Python） |
| `packages/types` | 共享 TypeScript 类型定义：AMP 事件、安全、会话、沙盒 |
| `thirdparty/openclaw` | 推荐放置固定版本上游 OpenClaw 源码的位置 |

## AMP 协议

**Agent Monitoring Protocol (AMP)** 是 Paddock 的核心创新。它定义了 Agent 与沙盒平台之间的结构化边界协议。

AMP 不是 Agent 框架，也不是模型协议。它规定了：

- 工具调用如何被监控和门禁
- 行为如何被审查和评分
- 事件如何被上报和审计
- 外部能力如何被显式接出
- 快照与回滚如何与命令关联

### 四类边界

| 边界类型 | 示例 | 原则 |
|---------|------|------|
| `sandbox-local` | `read`、`write`、`edit`、`exec`、`browser` | 在 guest VM 内完成；经过 AMP Gate 审查 |
| `control-plane-routed` | `sessions_*`、`subagents`、`cron`、`rollback` | 对 Agent 看起来像内部能力，但真相由控制面维护 |
| `mcp-external` | 外部 API、TTS、channel、webhook | 必须显式跨越边界；宿主凭证绝不泄漏 |
| `disabled` | `gateway`（自管理） | 在沙盒内被禁止 |

→ **[完整 AMP 协议规范 →](./docs/AMP_PROTOCOL.md)**

## 支持的沙盒类型

### `simple-box`
- 无 GUI，Ubuntu 22.04
- 适合命令执行、文件操作、编译、CLI Agent 任务
- 基于 BoxLite MicroVM

### `computer-box`
- 带 GUI，Ubuntu XFCE 桌面环境
- 适合浏览器自动化、桌面 UI 任务
- 通过 noVNC 访问（HTTP :6080 / HTTPS :6443）

### `macos`（即将推出）
- macOS 沙盒支持——规划中

## 从零开始：完整使用说明

### 环境要求

| 要求 | 版本 |
|------|------|
| **操作系统** | macOS Apple Silicon（推荐）或 Linux |
| **Node.js** | 22+ |
| **pnpm** | 9+ |
| **Python** | 3.10+ |
| **Docker** | 最新版（用于 rootfs 准备） |

> Docker 用于拉取基础镜像和准备 OCI rootfs。准备完成后，日常运行不需要 Docker 持续参与。

### 第 1 步：克隆仓库

```bash
git clone https://github.com/loopzy/ai-paddock
cd ai-paddock
```

### 第 2 步：安装 JavaScript / TypeScript 依赖

```bash
pnpm install
```

### 第 3 步：准备 OpenClaw 上游源码

克隆固定版本的 OpenClaw 源码：

```bash
mkdir -p thirdparty
git clone https://github.com/openclaw/openclaw thirdparty/openclaw
git -C thirdparty/openclaw checkout 1b31ede435bb5f07d87a5570d07e5d0d2dd5cccf
```

也可以自定义路径：

```bash
export OPENCLAW_SRC=/path/to/your/openclaw
```

查找优先级：`OPENCLAW_SRC` → `thirdparty/openclaw`

### 第 4 步：拉取基础镜像

```bash
# simple-box（命令行 Linux）
docker pull ubuntu:22.04

# computer-box（GUI Linux）
docker pull lscr.io/linuxserver/webtop:ubuntu-xfce
```

根据需要选择拉取，两者均为可选。

### 第 5 步：准备本地 OCI rootfs

提前烘焙本地 rootfs，避免首次启动时在线拉取：

```bash
# 同时准备两种沙盒
pnpm run prepare:sandbox-rootfs

# 或者分别准备：
pnpm run prepare:simplebox-rootfs
pnpm run prepare:computerbox-rootfs
```

如果你使用的是宿主机本地代理，例如运行在 `127.0.0.1` / `localhost` 上的 Clash、Surge 或 v2ray，那么保持平时的 shell 导出方式即可。`prepare:sandbox-rootfs` 会自动把这些 loopback 代理改写成 Docker build 容器可访问的 `host.docker.internal`，并附带 host-gateway 映射，让构建容器能够连回宿主机代理。

例如：

```bash
export https_proxy=http://127.0.0.1:7890
export http_proxy=http://127.0.0.1:7890
export all_proxy=socks5://127.0.0.1:7890
pnpm run prepare:sandbox-rootfs
```

如果你使用的是较老的 Docker 版本，不支持 `host-gateway`，可以在执行准备步骤前，手动把代理地址直接写成 `http://host.docker.internal:7890`。

### 受限网络环境：为当前 VM 手工配置网页工具代理

如果 LLM 调用正常，但 `web_fetch`、`browser` 之类直接在沙盒内访问网页的工具经常 `fetch failed`、超时，通常说明：

- 宿主机侧的 LLM Relay 已经能通过本地代理正常出网
- 但 VM 自己的网页流量还没有显式走到宿主机代理

这种情况下，可以先按下面的步骤为**当前 session**做一次手工验证和临时配置。

#### 宿主机执行

先照常导出你平时使用的代理环境变量：

```bash
export https_proxy=http://127.0.0.1:7890
export http_proxy=http://127.0.0.1:7890
export all_proxy=socks5://127.0.0.1:7890
```

然后确认两件事：

1. 代理端口确实在宿主机上监听
2. 找到一个 **VM 可以访问到的宿主机 IP**（通常是局域网地址，而不是 `127.0.0.1`）

可参考：

```bash
lsof -nP -iTCP:7890 -sTCP:LISTEN
ifconfig | rg "inet 192\\.168\\."
```

如果代理应用只监听 `127.0.0.1:7890`，那么 VM 无法直接连接它。此时需要先在代理应用中开启“允许局域网连接”或等效选项，让 VM 能通过宿主机 IP 访问该端口。

#### VM 内执行

在 Dashboard 的 terminal 中进入当前 VM，把下面的 `192.168.x.x` 替换成上一步查到的宿主机可达 IP：

```bash
export http_proxy=http://192.168.x.x:7890
export https_proxy=http://192.168.x.x:7890
export all_proxy=socks5://192.168.x.x:7890
export NO_PROXY=127.0.0.1,localhost
```

先验证代理变量已生效：

```bash
env | grep -i proxy
```

再验证网页访问：

```bash
curl -I https://openrouter.ai
curl -I https://news.google.com
curl -I https://www.bbc.com/news
```

如果这些请求恢复正常，那么当前 VM 内的 `web_fetch` / `browser` 通常也会随之恢复。

这组命令是**当前 VM 的临时设置**，适合快速验证和临时工作流。重建沙盒或新建 session 后需要重新执行；如果你希望把这套代理行为自动化，再考虑把它收进正式配置或启动流程。

### 第 6 步：准备 Node 运行时

Node 运行时是必须的，因为 OpenClaw 会在 VM 内部运行。

```bash
# VM 内使用的 Node.js 运行时
pnpm run prepare:node-runtime
```

### 第 7 步：可选 - 构建 OpenClaw Runtime Bundle

这一步的目的主要是提升启动速度，并让发布构建更稳定可复现。如果你更看重最大兼容性，或者希望在 VM 内直接按源码方式安装和调试 OpenClaw，那么这一步可以跳过。

跳过后，Paddock 仍然可以把固定版本的 OpenClaw 源码复制进 VM，并在 VM 内完成官方安装和构建。

```bash
# 构建 OpenClaw 运行时 bundle（可选，用于加快启动）
pnpm run build:openclaw-runtime
```

### 第 8 步：构建控制面、Dashboard 与 Sidecar

```bash
pnpm build
./scripts/build-sidecar.sh
```

### 第 9 步：配置 LLM 提供商

#### 方式 A：环境变量

```bash
# OpenRouter（推荐入门使用）
export OPENROUTER_API_KEY="your-openrouter-api-key"

# 或使用其他提供商：
export ANTHROPIC_API_KEY="your-anthropic-api-key"
export OPENAI_API_KEY="your-openai-api-key"
export GOOGLE_API_KEY="your-google-api-key"
```

#### 方式 B：Dashboard 配置

启动后，点击 Dashboard 顶栏的 **"API Keys"** 按钮交互式配置。

### 第 10 步：启动控制面

```bash
pnpm run dev:control
```

默认地址：`http://localhost:3100`

### 第 11 步：启动 Dashboard

打开新终端：

```bash
pnpm run dev:dashboard
```

默认地址：`http://localhost:3200`

### 第 12 步：创建沙盒

1. 打开 Dashboard `http://localhost:3200`
2. 点击 **"+"** 创建新沙盒
3. 选择沙盒类型：
   - **Simple Box** — 无头 Ubuntu 22.04
   - **Computer Box** — GUI Ubuntu XFCE 桌面
4. 等待状态从 `Starting` 变为 `Running`

### 第 13 步：部署 OpenClaw

1. 在会话面板中点击 **"Deploy Agent"**
2. 选择 **OpenClaw (auto-install with bundle/source fallback)**
3. 等待 Agent 上报就绪

Paddock 会按下面的顺序选择部署路径：

1. **官方 runtime bundle**：最快，适合发布构建
2. **VM 内源码安装**：从 `OPENCLAW_SRC` 或 `thirdparty/openclaw` 复制固定版本源码到 VM，再在 VM 内安装并构建

> 如果你在第 7 步构建了 runtime bundle，Paddock 会优先使用它来获得更快的启动速度。如果没有构建，或者你更看重最大兼容性，Paddock 也可以直接在 VM 内按固定源码安装 OpenClaw。首次部署时，安装脚本还会在 VM 内通过 `apt` 安装 Chromium 浏览器（如果尚未安装）。VM 内源码安装这条路径还会在 VM 内安装 `pnpm` 和 OpenClaw 依赖，所以会更慢，并且可能需要沙盒具备网络访问能力。

### 第 14 步：在沙盒内使用 OpenClaw

部署完成后，通过 Dashboard 向 OpenClaw 发送命令：

- *"帮我创建一个 hello world 的 C 程序并运行"*
- *"去浏览器里打开某个页面并总结内容"*
- *"在工作目录里搭一个简单的 Python HTTP 服务"*

### 第 15 步：查看执行过程

Dashboard 提供两种视图：

| 视图 | 说明 |
|------|------|
| **Commands** | 语义级执行树——用户命令、模型步骤、模型审核、工具意图、裁决、结果、最终回复 |
| **Raw Logs** | 完整事件流，用于排障和取证审计 |

## 可选：启用本地 LLM 审核与观测脱敏

默认安全流水线是完全确定性的（规则引擎 → 污点追踪 → 行为分析）。你还可以给原生 `amp.llm.request` / `amp.llm.response` 事件增加两套彼此独立的本地 LLM 模块：

- **LLM 审核器**：产出 `amp.llm.review`，给 prompt/response 增加语义风险信号，可把后续工具抬进 HITL，也可以在危险回复后直接拦截后续工具。
- **LLM 观测脱敏器**：产出 `reviewSanitization` 摘要和细节压缩，用于 Dashboard 展示和审核输入，不再依赖原始 prompt/response。

Dashboard 会把这些结果显示成可读的 `Model review` 卡片，以及 `Prompt needs approval`、`Response blocked` 这类顶层摘要标签。

如果你没有给审核器或脱敏器单独配置模型，它们会自动回退到现有的 `PADDOCK_BEHAVIOR_LLM_*` 行为审核配置。

### 复用现有行为审核模型

```bash
export PADDOCK_BEHAVIOR_LLM_ENABLED=1
export PADDOCK_BEHAVIOR_LLM_PROVIDER=ollama
export PADDOCK_BEHAVIOR_LLM_MODEL=qwen3:0.6b
export PADDOCK_BEHAVIOR_LLM_BASE_URL=http://127.0.0.1:11434
```

### 为观测脱敏单独指定本地模型

```bash
export PADDOCK_LLM_SANITIZER_ENABLED=1
export PADDOCK_LLM_SANITIZER_PROVIDER=ollama
export PADDOCK_LLM_SANITIZER_MODEL=qwen3:0.6b
export PADDOCK_LLM_SANITIZER_BASE_URL=http://127.0.0.1:11434
export PADDOCK_LLM_SANITIZER_TIMEOUT_MS=30000
export PADDOCK_LLM_SANITIZER_MAX_TOKENS=300
```

### 为 prompt / response 审核单独指定模型

```bash
export PADDOCK_LLM_AUDIT_ENABLED=1
export PADDOCK_LLM_AUDIT_PROVIDER=openai-compatible
export PADDOCK_LLM_AUDIT_MODEL=gpt-4.1-mini
export PADDOCK_LLM_AUDIT_BASE_URL=https://your-endpoint/v1
export PADDOCK_LLM_AUDIT_API_KEY=your-key
export PADDOCK_LLM_AUDIT_TIMEOUT_MS=8000
export PADDOCK_LLM_AUDIT_MAX_TOKENS=300
```

这两套独立接口还支持：

- `*_TEMPERATURE`
- `*_MAX_TOKENS`
- `*_TIMEOUT_MS`

其中 `*` 分别是 `PADDOCK_LLM_SANITIZER` 或 `PADDOCK_LLM_AUDIT`。

## 支持的 LLM 提供商

| 提供商 | 环境变量 | API 地址 |
|--------|---------|---------|
| Anthropic | `ANTHROPIC_API_KEY` | `https://api.anthropic.com` |
| OpenAI | `OPENAI_API_KEY` | `https://api.openai.com` |
| OpenRouter | `OPENROUTER_API_KEY` | `https://openrouter.ai` |
| Google | `GOOGLE_API_KEY` | `https://generativelanguage.googleapis.com` |

## Roadmap

- ✅ 控制面、Sidecar、Dashboard 核心链路
- ✅ `simple-box` / `computer-box` 双沙盒支持
- ✅ OpenClaw 在沙盒内完整运行
- ✅ 全链路事件流：LLM、工具、文件变化、安全裁决
- ✅ 4 层安全引擎：规则、污点追踪、行为分析、信任衰减
- ✅ 可选 LLM 行为审核层
- ✅ 独立本地 LLM prompt/response 审核与观测脱敏
- ✅ Dashboard 语义执行树 + 原始日志双视图
- ✅ 敏感数据保险库（自动遮蔽 LLM 流量中的密钥）
- 🔜 意图注入语义审查模块
- 🔜 快照与回滚
- 🔜 增强的审批与策略系统
- 🔜 多 Agent 编排支持
- 🔜 自定义安全规则插件市场
- 🔜 macOS沙盒支持

`ai-paddock` 目前正处于早期开发阶段，提前发布旨在验证 这套智能体管理协议的核心架构，并收集社区意见。非常欢迎提交 PR！

## 许可证

本项目采用 [Apache License 2.0](./LICENSE)。

## 致谢

- [OpenClaw / Claude Code](https://github.com/anthropics/claude-code) — 参考 Agent 集成对象
- [BoxLite](https://docs.boxlite.ai/) — MicroVM 运行时引擎

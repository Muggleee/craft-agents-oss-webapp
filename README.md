# Craft Agents OSS Webapp

一个基于 Claude Agent SDK 的 AI 聊天 Web 应用。

## 快速开始

```bash
# 安装依赖
bun install

# 启动开发服务器 (前端 + 后端)
bun run dev
```

访问 http://localhost:5173

## 配置

在 `~/.craft-agent/config.json` 中配置 API：

```json
{
  "authType": "api_key",
  "anthropicBaseUrl": "https://open.bigmodel.cn/api/anthropic"
}
```

API Key 存储在系统 keychain 中。

## 项目结构

```
├── apps/webapp/      # Web 应用 (前端 + 后端)
├── packages/
│   ├── shared/       # 共享代码 (认证、配置等)
│   ├── core/         # 核心逻辑
│   └── ui/           # UI 组件
```

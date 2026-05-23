#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { login, start } from "weixin-agent-sdk";

import { getDebugLogPath, logInfo } from "./src/debug-log.js";
import { VcpAgent } from "./src/vcp-agent.js";

/**
 * 这个入口文件只做三件事：
 * 1. 解析命令行，区分扫码登录和正式启动。
 * 2. 从当前包目录读取本地 `.env`，把桥接所需参数补进进程环境变量。
 * 3. 组装 `VcpAgent`，再交给 `weixin-agent-sdk` 驱动整个微信会话生命周期。
 */
const command = process.argv[2];
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE_PATH = path.join(CURRENT_DIR, ".env");

/**
 * `.env` 里经常会写成 `KEY="value"` 或 `KEY='value'`。
 * 这里统一把最外层包裹引号剥掉，避免后续请求地址、Token 等值把引号一起带进去。
 */
function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * 只从当前包目录读取本地 `.env`，并且遵守“显式环境变量优先”的约定：
 * 如果外部已经注入了同名变量，这里不会覆盖，方便本地调试和部署环境共存。
 */
function loadLocalEnvFile(): void {
  if (!fs.existsSync(ENV_FILE_PATH)) {
    return;
  }

  const source = fs.readFileSync(ENV_FILE_PATH, "utf8");
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key] != null) {
      continue;
    }

    const rawValue = line.slice(separatorIndex + 1).trim();
    process.env[key] = stripWrappingQuotes(rawValue);
  }
}

loadLocalEnvFile();

/**
 * 启动桥接时，`VCP_BASE_URL` 和 `VCP_API_KEY` 是硬依赖。
 * 这里在启动初期就失败，可以把错误留在配置层，而不是等到首条消息进来后才暴露。
 */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`缺少环境变量: ${name}`);
  }
  return value;
}

/**
 * `main` 是运行态编排层。
 * - `login`：只负责触发微信登录态建立。
 * - `start`：组装桥接参数、创建 Agent、注册退出信号并阻塞等待 bot 结束。
 */
async function main() {
  switch (command) {
    case "login": {
      await login();
      break;
    }

    case "start": {
      logInfo("example-vcp start invoked", {
        envFilePath: ENV_FILE_PATH,
        debugLogPath: getDebugLogPath(),
      });
      const agent = new VcpAgent({
        baseUrl: requireEnv("VCP_BASE_URL"),
        apiKey: requireEnv("VCP_API_KEY"),
        model: process.env.VCP_MODEL?.trim() || "gpt-5.4",
        systemPrompt: process.env.VCP_SYSTEM_PROMPT?.trim() || undefined,
        forceToolView: process.env.VCP_FORCE_TOOL_VIEW === "true",
        maxTurns: Number(process.env.VCP_HISTORY_MAX_TURNS || 12),
        maxChars: Number(process.env.VCP_HISTORY_MAX_CHARS || 15000),
        timeoutMs: Number(process.env.VCP_TIMEOUT_MS || 300000),
        slowTaskMs: Number(process.env.VCP_SLOW_TASK_MS || 12000),
        longTaskKeywords: process.env.VCP_LONG_TASK_KEYWORDS?.split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      });

      const ac = new AbortController();
      process.on("SIGINT", () => {
        console.log("\n正在停止...");
        ac.abort();
      });
      process.on("SIGTERM", () => ac.abort());

      const bot = start(agent, { abortSignal: ac.signal });
      console.log(`[example-vcp] debug log: ${getDebugLogPath()}`);
      await bot.wait();
      break;
    }

    default:
      console.log(`weixin-agent-vcp — 微信 + VCPToolBox 示例

用法:
  npx tsx main.ts login    扫码登录微信
  npx tsx main.ts start    启动 bot

配置文件:
  默认自动读取 packages/example-vcp/.env

环境变量:
  VCP_BASE_URL             VCPToolBox 地址 (必填)
  VCP_API_KEY              VCPToolBox Bearer Token (必填)
  VCP_MODEL                模型名称 (默认 gpt-5.4)
  VCP_SYSTEM_PROMPT        系统提示词
  VCP_HISTORY_MAX_TURNS    轻历史轮数 (默认 12)
  VCP_HISTORY_MAX_CHARS    轻历史字符上限 (默认 15000)
  VCP_FORCE_TOOL_VIEW      true 时切到 /v1/chatvcp/completions
  VCP_TIMEOUT_MS           请求超时毫秒 (默认 300000)
  VCP_SLOW_TASK_MS         视为慢任务的耗时阈值 (默认 12000)
  VCP_LONG_TASK_KEYWORDS   长任务关键词，逗号分隔`);
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
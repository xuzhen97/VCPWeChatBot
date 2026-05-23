# example-vcp

WeChat -> VCPToolBox bridge example for `weixin-agent-sdk`.

## Commands

- `pnpm run login -w packages/example-vcp`
- `pnpm run start -w packages/example-vcp`

## Config

启动时会自动读取 `packages/example-vcp/.env`。

可直接复制 `.env.example` 为 `.env` 后再改值。

最小配置：

```dotenv
VCP_BASE_URL=http://127.0.0.1:8188
VCP_API_KEY=your-bearer-token
```

完整配置：

```dotenv
VCP_BASE_URL=http://127.0.0.1:8188
VCP_API_KEY=your-bearer-token
VCP_MODEL=gpt-5.4
VCP_SYSTEM_PROMPT=你是微信里的 VCP 助手。
VCP_HISTORY_MAX_TURNS=12
VCP_HISTORY_MAX_CHARS=15000
VCP_FORCE_TOOL_VIEW=true
VCP_TIMEOUT_MS=300000
VCP_SLOW_TASK_MS=12000
VCP_LONG_TASK_KEYWORDS=新闻,最新,最近,联网,搜索,查一下,帮我查,实时,今日,热点,汇率,股价,天气,比赛,比分,资讯,web,search,browse,news
```

## 当前桥接链路

当前主链路已经收敛成 5 个稳定阶段：

1. `SessionStore.buildRequestMessages`
   - 组装系统提示 + 轻历史 + 当前用户输入
2. `VcpClient.chat`
   - 向 VCP 发起一次完整请求，并收敛返回文本
3. `parseAssistantResult`
   - 解析工具痕迹、结构化结果、展示文本、历史文本、诊断字段
4. `normalizeWechatReply`
   - 把解析结果压缩成微信可发送的文本 / 媒体结构
5. `SessionStore.commitSuccessfulTurn`
   - 只有真正拿到助手结果后才写回轻历史

## 微信回复模型

- 纯文本：直接回文本
- 纯媒体：回结构化媒体结果
- 文本 + 媒体：先发文本，再发媒体
- 图片、视频、文件都支持本地路径或远程 URL

## P0 长任务止血策略

当前桥接已经接通“先回执、后补结果”的轻量回投链路，但还不是完整的任务队列系统。

现在的状态流是三段：

- 首包在 `VCP_SLOW_TASK_MS` 内完成
  - 直接同步返回最终结果
- 首包超过慢任务阈值
  - 先回一条受理通知
  - 后续结果出来后通过 `followUp` 自动补发
- 首包阶段直接报错或整体请求超时
  - 走同步失败兜底文案

可调参数：

- `VCP_TIMEOUT_MS`：整体请求超时，默认 `300000`
- `VCP_SLOW_TASK_MS`：切到“先回执后补发”的阈值，默认 `12000`
- `VCP_LONG_TASK_KEYWORDS`：长任务候选关键词，逗号分隔

适合纳入长任务候选的典型问题：

- 新闻、热点、实时信息
- 联网搜索、网页浏览
- 依赖外部插件或外部站点返回的查询

## 运行期生命周期策略

当前桥接补了两层保守清理，默认都偏向“先保证稳定，再控制堆积”：

- `SessionStore`
  - 会话空闲超过 6 小时会被回收
  - 进程内最多保留 200 个会话，超出后淘汰最久未更新项
- `media-normalizer`
  - data URI 落地出的临时媒体文件按年龄清理
  - 默认只会低频触发扫描，避免把目录维护变成主链路负担

这些策略都不改变外部调用方式，只控制常驻进程下的内存和临时文件增长。

## Run

1. 登录微信

```bash
pnpm --dir "d:/VCPHub/weixin-agent-sdk" --filter example-vcp run login
```

2. 在 `packages/example-vcp/.env` 填好参数

3. 启动桥接

```bash
pnpm --dir "d:/VCPHub/weixin-agent-sdk" --filter example-vcp run start
```

## Linux 部署

推荐始终从 workspace 根目录启动，这样 `example-vcp -> weixin-agent-sdk` 的构建链路和 workspace 依赖解析最稳定。

目录示例：

```bash
/opt/VCPWeChatBot
```

首次部署建议顺序：

```bash
cd /opt/VCPWeChatBot
pnpm approve-builds
pnpm install
pnpm --filter example-vcp run login
pnpm --filter example-vcp run start
```

说明：

- `login` 需要人工扫码，只需要先手动执行一次
- `start` 才适合交给进程管理器常驻托管
- 运行时会自动读取 `packages/example-vcp/.env`

## PM2

仓库根目录提供了 `ecosystem.config.cjs`，默认按 Linux 路径 `/opt/VCPWeChatBot` 配置 `example-vcp`。

使用方式：

1. 先手动登录微信

```bash
cd /opt/VCPWeChatBot
pnpm --filter example-vcp run login
```

2. 启动 pm2 托管

```bash
cd /opt/VCPWeChatBot
pm2 start ecosystem.config.cjs
```

3. 查看状态和日志

```bash
pm2 status
pm2 logs example-vcp
```

4. 设置开机自启

```bash
pm2 save
pm2 startup
```

`pm2 startup` 会输出一条需要再次执行的系统命令，按提示再执行一次即可。

常用维护命令：

```bash
pm2 restart example-vcp
pm2 stop example-vcp
pm2 delete example-vcp
pm2 logs example-vcp
```

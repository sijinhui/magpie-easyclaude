# EasyClaude 本地 Magpie 插件

一次填写 API Key，在同一 `easyclaude` 供应商中提供模型调用与套餐余额。无 npm 依赖，无额外 HTTP 服务。

## 安装

Magpie → 插件 → 添加插件 → 选择本文件夹；也可运行 `magpie plugin add /插件的绝对路径`。
新用户运行 `magpie plugin login easyclaude` 输入 API Key。已有同 ID 自定义供应商的用户应先备份并验证迁移，不要直接删除供应商或路由。

## 行为

- 供应商 ID：`easyclaude`。Claude 使用日本节点的 Anthropic Messages；GPT 使用同节点 OpenAI Responses；其他模型使用 Chat Completions。模型 ID 不更名。
- 模型列表：`GET https://jp.easyclaude.com/v1/models`。保留框架已有模型元数据，不虚构上下文、价格或推理等级。
- `models.mjs` 保存本机 2026-11-12 models.dev 缓存的 18 个模型能力快照；这是模型目录元数据，不保证中转站支持每个能力或最大上下文。账号模型列表决定最终可用模型；未列出的新模型不猜测能力。
- 登录：`POST https://easyclaude.com/app/login`，JSON `api_key`。
- 余额：`POST https://easyclaude.com/v1/app_web/key/info`，JSON `is_cache: 0`，Cookie `session_token`。
- Cookie 仅保存在插件进程内存中，按 Key 隔离；并发登录合并。23 小时后重新登录，或遇到明确会话失效时重登一次。23 小时是保守客户端缓存上限，不是服务端有效期声明。
- 显示剩余额度、已用/总额与到期时间。无时区的站点日期按 Asia/Shanghai (+08:00) 解释；到期不是自动重置，不冒充配额刷新时间。额度不冒充美元。
- 余额错误不清除模型 Key，不把未知余额记为零。插件从不打印 Key、Cookie、提示词或原始响应；模型请求禁发 Cookie，拒绝未知目标和重定向。
- Key 由 Magpie 以其 API 登录格式保存。该存储是本机私密文件，不宣称是加密保险箱。插件本身不读取其他账号配置。
- 模型响应原样透传，不预读、缓存、重写 SSE 或人为延迟分块；下游取消和上游断流由原始响应流传递。模型请求不自动重试，避免重复生成或扣费；HTTP 错误状态、响应头和响应体保留给 Magpie 处理。
- 请求已取消或读取账号期间被取消时，不再发起模型请求。模型连接异常（包括原始错误及其 cause）和流开始后的异常原样传递给 Magpie，便于排查问题。
- 请求日志速度由 Magpie 根据实际收到的流计算；插件不伪造计时或 token 数，不能保证每条请求都显示速度。
- 站点接口未承诺长期稳定；接口变更可能需调整插件。

## 验证

`npm test` 运行离线测试。真实余额查询会登录主站，不调用模型；模型烟雾测试会消耗少量额度。
插件源码变更后，Magpie 中停用再启用插件加载新版本；进行中回复应先完成。

接口依据：本机 Magpie 插件 host、https://usemagpie.ai/docs/plugins，以及 2026-11-12 读取的 EasyClaude 登录页和余额请求。

## 从自定义供应商迁移

已验证：同 ID 自定义供应商仍保留 API Key/端点时，插件可能显示为 `easyclaude-plugin`。将 Key 通过 Magpie plugin host 的账号写入接口导入 `easyclaude` 后，原 providers 条目只保留 ID、名称、图标、路由偏好等设置，去掉旧 Key 和协议地址，即可由插件使用原 `easyclaude` ID；groups 完全不改。
迁移备份放在 Magpie 的私密 backups 目录（目录 0700、文件 0600），不随本插件分发。回退时停用该本地插件并恢复备份中 EasyClaude 的原供应商条目，不应整文件覆盖之后新增的其他供应商。

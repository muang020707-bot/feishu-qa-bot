# 自建飞书问答机器人

这是自建版，不是飞书 Aily/智能伙伴。

用户在飞书群里 `@机器人 + 问题` 后，云函数会：

1. 判断消息是否真的提到了机器人。
2. 读取 `KNOWLEDGE_SOURCE_URLS` 里的飞书 Wiki、文档或文件夹。
3. 从资料里检索相关片段。
4. 调用 OpenAI 生成只基于资料的回答。
5. 回复到原飞书消息下。

## 本地文件

- `src/feishu-qa-bot.js`：可复制到飞书云函数的 CommonJS 主代码。
- `docs/deploy-feishu-cloud-function.md`：飞书应用、权限、云函数和消息触发配置说明。
- `.env.example`：需要配置的环境变量模板。
- `test/feishu-qa-bot.test.js`：本地行为测试。
- `scripts/local-smoke-test.js`：不连飞书和 OpenAI 的本地模拟。

## 本地验证

```powershell
npm.cmd test
npm.cmd run smoke
```

PowerShell 如果拦截 `npm`，请用 `npm.cmd`。

## 第一版限制

- 自动读取飞书 Wiki 节点和新版文档 `docx` 的纯文本内容。
- 文件夹链接会遍历其中的 `docx` 文件。
- Excel/Sheet 自动解析、群内上传附件自动入库、复杂权限同步不在第一版。

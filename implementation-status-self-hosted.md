# 自建飞书问答机器人实施状态

日期：2026-05-28

## 已完成

- 创建自建飞书应用配置：`cli_aa9d674eedba1bdd`
- 确认机器人名称：`牧火人事助手`
- 确认机器人 open_id：`ou_9787aa3d09d2dc2148de1b9d0707b081`
- 创建 OpenAI API Key，并写入 `.env.local`
- 将知识库入口写入配置：
  `https://vcnh0ynuo3yd.feishu.cn/wiki/G5vLwatTWisiuGkrVITcgompnod?fromScene=spaceOverview`
- 将资料文件夹写入配置：
  `https://vcnh0ynuo3yd.feishu.cn/drive/folder/Pe45fe0GolwNNKdZ3GlcwKuwnqb`
- 机器人代码已支持：
  - 只响应 `@机器人`
  - 读取 Wiki/docx/文件夹知识源
  - 检索资料片段
  - 调用 OpenAI 生成回答
  - 回复飞书消息

## 已验证

- 当前用户身份可读取 Wiki 入口。
- 新应用 bot 身份可读取 Wiki 背后的 docx 内容。
- 新应用已加入测试群：`oc_d032d9b6a1bd3166b1b8995a5fed55fb`
- 已给新应用授予资料文件夹只读权限。
- 新应用 bot 身份可列出资料文件夹内容。
- 新应用 bot 身份可读取资料文件夹内真实员工手册正文。
- 本地测试通过：`npm.cmd test`
- 本地 smoke 测试通过：`npm.cmd run smoke`

## 仍需完成

1. 在飞书低代码/aPaaS 创建云函数并粘贴 `src/feishu-qa-bot.js`。
2. 配置云函数环境变量。
3. 配置消息触发。
4. 群内 `@牧火人事助手` 做真实问答验收。

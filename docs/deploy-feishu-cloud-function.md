# 自建飞书问答机器人部署说明

## 1. 新建飞书应用

1. 在飞书开放平台新建一个企业自建应用。
2. 添加「机器人」能力，并发布到企业内可用范围。
3. 开通权限：
   - `im:message`
   - `im:message:send_as_bot`
   - `im:message:readonly`
   - `drive:drive:readonly`
   - `space:document:retrieve`
   - `docx:document:readonly`
4. 记录应用的 `App ID`、`App Secret` 和机器人 `open_id`。

## 2. 配置云函数

在飞书低代码/aPaaS 云函数中新建 JavaScript 云函数，把 `src/feishu-qa-bot.js` 的内容复制为函数代码。

配置环境变量：

```text
OPENAI_API_KEY=创建好的 OpenAI Key
FEISHU_APP_ID=cli_aa9d674eedba1bdd
FEISHU_APP_SECRET=飞书专用应用 App Secret
BOT_OPEN_ID=ou_9787aa3d09d2dc2148de1b9d0707b081
KNOWLEDGE_SOURCE_URLS=https://vcnh0ynuo3yd.feishu.cn/wiki/G5vLwatTWisiuGkrVITcgompnod?fromScene=spaceOverview,https://vcnh0ynuo3yd.feishu.cn/drive/folder/Pe45fe0GolwNNKdZ3GlcwKuwnqb
OPENAI_MODEL=gpt-4.1-mini
```

当前专用应用：

- App ID: `cli_aa9d674eedba1bdd`
- 机器人 open_id: `ou_9787aa3d09d2dc2148de1b9d0707b081`
- 机器人名称: `牧火人事助手`
- 知识库入口: `https://vcnh0ynuo3yd.feishu.cn/wiki/G5vLwatTWisiuGkrVITcgompnod?fromScene=spaceOverview`
- 资料文件夹: `https://vcnh0ynuo3yd.feishu.cn/drive/folder/Pe45fe0GolwNNKdZ3GlcwKuwnqb`

## 3. 配置消息触发

1. 在飞书低代码平台给云函数添加「飞书消息」触发。
2. 触发范围选择机器人所在单聊/群聊消息。
3. 第一版只在消息中明确 `@机器人` 时回复；普通群聊消息会被忽略。

## 4. 验收

在测试群里执行：

- 不 `@` 机器人发送一句普通话，机器人不应回复。
- `@机器人 公司考勤是怎么样的`，机器人应基于资料回复。
- `@机器人 资料里不存在的问题`，机器人应回复知识库暂无明确答案。
- 关闭本机电脑后继续在群里测试，确认云函数仍可回复。

## 注意

- 当前版本读取飞书 Wiki 节点、新版飞书文档 `docx` 的纯文本内容；文件夹中只会自动读取 `docx` 文件。
- Excel/Sheet 自动解析、群内上传附件自动入库、复杂权限同步留到下一版。

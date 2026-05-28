# Render 部署说明

## 1. 部署服务

1. 打开 `https://dashboard.render.com/`。
2. 新建 Web Service。
3. 如果没有 GitHub 仓库，先把本项目上传到 GitHub；Render 推荐从 GitHub 仓库部署。
4. 使用以下配置：
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Health Check Path: `/health`

项目里已经提供 `render.yaml`，连接 GitHub 后也可以用 Blueprint 部署。

## 2. Render 环境变量

必填：

```text
OPENAI_API_KEY=<本地 .env.local 里的 OpenAI API Key>
FEISHU_APP_ID=cli_aa9d674eedba1bdd
FEISHU_APP_SECRET=<飞书开发者后台里的 App Secret>
BOT_OPEN_ID=ou_9787aa3d09d2dc2148de1b9d0707b081
KNOWLEDGE_SOURCE_URLS=https://vcnh0ynuo3yd.feishu.cn/wiki/G5vLwatTWisiuGkrVITcgompnod?fromScene=spaceOverview,https://vcnh0ynuo3yd.feishu.cn/drive/folder/Pe45fe0GolwNNKdZ3GlcwKuwnqb
OPENAI_MODEL=gpt-4.1-mini
FEISHU_VERIFICATION_TOKEN=<飞书事件订阅里的 Verification Token，可选但推荐>
```

## 3. 飞书事件回调

Render 部署成功后，会得到类似：

```text
https://feishu-qa-bot.onrender.com
```

在飞书开发者后台「事件与回调」里配置请求地址：

```text
https://feishu-qa-bot.onrender.com/feishu/events
```

订阅消息接收事件后，群里 `@牧火人事助手` 即可触发问答。

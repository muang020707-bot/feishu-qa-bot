---
name: feishu-qa-bot-aliyun
description: Build and deploy a self-hosted Feishu/Lark knowledge-base Q&A bot on Alibaba Cloud Function Compute using DashScope Qwen. Use when the user wants a Feishu robot that answers only when mentioned, reads Feishu wiki/docs/folders as knowledge sources, sends matching source document links on material requests, replies with Qwen-generated answers, or needs end-to-end setup, deployment, permissions, callback, and live group validation.
---

# Feishu Q&A Bot On Aliyun

Use this skill to build the proven route:

Feishu group `@bot + question` -> Alibaba Cloud Function Compute HTTP callback -> Feishu wiki/docs/folder retrieval -> local chunk retrieval -> DashScope Qwen answer -> Feishu reply.

Also support material requests such as `给我劳动合同`, `发我员工手册文档`, or `下载考勤制度`, where the bot should reply with matching Feishu document links instead of generating an answer.

## Start Here

1. Prefer the bundled template at `assets/feishu-qa-bot-template` for new projects.
2. Read `references/checklist.md` before touching the Feishu developer console or Alibaba Cloud deployment.
3. Keep all secrets out of chat, git, logs, and final answers. If the user pasted secrets into chat, finish the task and then recommend rotating them.
4. Validate with real Feishu group messages, not only simulated HTTP callbacks.

## Inputs To Collect

Collect or derive these values:

- Feishu app ID and app secret from a dedicated custom app.
- Feishu bot open ID from the app bot info, plus any open ID shown in real message mentions if different.
- Feishu wiki/docx/doc/folder URLs for knowledge sources.
- DashScope API key and model, usually `qwen-plus`.
- Alibaba Cloud Function Compute region and Serverless Devs access alias.
- A Feishu test group chat ID that contains the bot.

## Implementation Pattern

Use the template as the baseline. Preserve these behaviors:

- HTTP callback path: `/feishu/events`.
- Respond to Feishu challenge payloads immediately.
- Ignore group messages that do not explicitly mention the bot.
- Normalize the question by removing Feishu mention placeholders and bot display names.
- Load knowledge from Feishu wiki nodes, docx/doc documents, Drive folders, and folder shortcuts.
- Cache loaded knowledge in memory for a short TTL to reduce callback latency.
- Retrieve relevant chunks locally before calling Qwen.
- Instruct Qwen to answer only from provided knowledge and say the knowledge base has no clear answer when unsupported.
- Detect material/document requests before calling Qwen and reply with matching Feishu document links.
- Reply to Feishu messages with a deterministic `uuid` based on the incoming message ID to avoid duplicate replies after Feishu retries.

## Deployment Pattern

Use Alibaba Cloud Function Compute with Serverless Devs:

- Runtime: `nodejs18`.
- Handler: `aliyun-handler.handler`.
- Trigger: HTTP, GET and POST, anonymous.
- Timeout: at least 60 seconds.
- Environment variables:
  - `DASHSCOPE_API_KEY`
  - `OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1`
  - `OPENAI_MODEL=qwen-plus`
  - `FEISHU_APP_ID`
  - `FEISHU_APP_SECRET`
  - `BOT_OPEN_ID`
  - `KNOWLEDGE_SOURCE_URLS`
  - `FEISHU_VERIFICATION_TOKEN=unused` unless token verification is deliberately enabled.

Use `s deploy --use-local -y` after setting env vars in the process. Redact secrets from command output before showing it to the user.

## Feishu Console Pattern

Create or update a dedicated Feishu app:

- Enable bot capability.
- Add required message and document permissions.
- Grant the app read access to the knowledge folder/wiki/documents.
- Add the bot to the test group.
- Configure event subscription to send events to the Function Compute URL: `https://<function-domain>/feishu/events`.
- Subscribe to message receive events for the bot.
- Publish the app version after permission or event changes.

If Feishu says the request timed out while saving the callback URL, first verify the function challenge response is fast. The template prioritizes challenge responses before any knowledge loading.

## Validation

Run local tests first:

```powershell
npm.cmd test
```

Then validate the live bot in this order:

1. POST a Feishu challenge payload to the deployed URL and confirm HTTP 200 with the same challenge.
2. Send a real group message without `@bot`; confirm no reply.
3. Send `@bot 公司考勤是怎么样的`; confirm a knowledge-grounded answer.
4. Send `@bot 资料里没有的问题`; confirm it says no clear answer.
5. Send `@bot 给我劳动合同` or `@bot 发我员工手册文档`; confirm it sends Feishu document links.
6. Confirm the same incoming message is not replied to twice.
7. Confirm the bot still replies while the local computer is off.

## Common Fixes

- Real Feishu mention open ID can differ from the bot info open ID. Support comma-separated `BOT_OPEN_ID` values.
- Feishu Drive folder list parameters may reject unsupported options. Use only `folder_token` and `page_size` unless verified current docs require more.
- If Vercel or other platforms fail Feishu's 3-second callback save check, switch to Alibaba Cloud Function Compute and prioritize challenge handling.
- If first answers are slow, warm the function once or ship a prebuilt static knowledge index. Still keep live document loading as the simple first version.
- If material requests return too many links, reduce the material match limit or improve title scoring before changing the Q&A path.


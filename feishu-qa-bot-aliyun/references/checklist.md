# Feishu Q&A Bot Checklist

## Feishu App

- Create a dedicated custom Feishu app; do not reuse unrelated apps.
- Enable bot capability.
- Record app ID, app secret, and bot open ID without exposing them in chat or git.
- Add bot to the target test group.
- Grant the app read access to the wiki, docs, or Drive folder used as the knowledge source.
- Add these app capabilities/scopes as needed:
  - Receive group message events.
  - Send and reply to messages as bot.
  - Read docx/doc raw content.
  - Read wiki nodes.
  - Read Drive folder files and shortcuts.
- Publish a new app version after changing permissions, bot availability, or event subscriptions.

## Knowledge Sources

Accept comma-separated URLs:

- `https://...feishu.cn/wiki/<token>`
- `https://...feishu.cn/docx/<token>`
- `https://...feishu.cn/docs/<token>`
- `https://...feishu.cn/drive/folder/<token>`

For folders, support normal doc/docx files and shortcuts to doc/docx files.

## Alibaba Cloud Function Compute

Recommended function settings:

- Region: choose near the user, commonly `cn-hangzhou`.
- Runtime: `nodejs18`.
- Handler: `aliyun-handler.handler`.
- Trigger: HTTP, anonymous, GET and POST.
- Timeout: 60 seconds or higher.
- Memory: 512 MB is enough for the first version.

Required environment variables:

```text
DASHSCOPE_API_KEY=
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
OPENAI_MODEL=qwen-plus
FEISHU_APP_ID=
FEISHU_APP_SECRET=
BOT_OPEN_ID=
KNOWLEDGE_SOURCE_URLS=
FEISHU_VERIFICATION_TOKEN=unused
```

## Template Files

Copy `assets/feishu-qa-bot-template` into the user's project folder. Then fill env vars and deploy.

The template already includes:

- Feishu event parsing and mention filtering.
- Feishu challenge fast response.
- Wiki/docx/doc/folder loading.
- Knowledge cache.
- Local retrieval.
- DashScope Qwen via OpenAI-compatible chat completions.
- Material/document request link replies.
- Reply `uuid` deduplication.
- Node test coverage for handler and bot logic.

## Live Test Script Shape

Use Feishu APIs or lark-cli to send real messages to the test group:

```text
@机器人 公司考勤是怎么样的
@机器人 火星基地午餐补贴是多少
@机器人 给我劳动合同
不@机器人的普通消息
```

Expected results:

- The first gets a knowledge-based answer.
- The second says the knowledge base has no clear answer.
- The third returns document links.
- The fourth is ignored.

## Security Notes

- Never include real API keys, app secrets, or access keys in the skill, committed files, or final answer.
- Redact deploy output because Serverless Devs can echo environment variables.
- After a user pastes secrets in chat, recommend rotating them after the bot is stable.
- Keep `FEISHU_VERIFICATION_TOKEN=unused` only if the deployed callback is otherwise protected by obscurity and Feishu app ownership. Enable real token verification if the user provides a token and updates the Feishu console to match.


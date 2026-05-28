# Aliyun Function Compute deployment

Use this when Feishu callback verification times out against overseas/serverless hosts.

## Required environment variables

```text
OPENAI_API_KEY=<secret>
FEISHU_APP_ID=cli_aa9d674eedba1bdd
FEISHU_APP_SECRET=<secret>
BOT_OPEN_ID=ou_9787aa3d09d2dc2148de1b9d0707b081
KNOWLEDGE_SOURCE_URLS=https://vcnh0ynuo3yd.feishu.cn/wiki/G5vLwatTWisiuGkrVITcgompnod?fromScene=spaceOverview,https://vcnh0ynuo3yd.feishu.cn/drive/folder/Pe45fe0GolwNNKdZ3GlcwKuwnqb
OPENAI_MODEL=gpt-4.1-mini
FEISHU_VERIFICATION_TOKEN=
```

## Deploy

1. Configure Serverless Devs access:

```powershell
s config add --AccessKeyID <AccessKeyID> --AccessKeySecret <AccessKeySecret>
```

2. Load environment variables and deploy:

```powershell
$env:FEISHU_APP_SECRET="<secret>"
s deploy --use-local -y
```

3. Configure the Feishu event callback URL in the developer console:

```text
https://<aliyun-http-trigger-domain>/feishu/events
```

The callback endpoint returns Feishu `challenge` requests before loading the Q&A code path.

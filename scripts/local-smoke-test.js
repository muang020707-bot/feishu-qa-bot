"use strict";

const bot = require("../src/feishu-qa-bot");

async function main() {
  const result = await bot.handleFeishuEvent(
    {
      event: {
        message: {
          message_id: "om_local_test",
          content: JSON.stringify({ text: "@_user_1 公司考勤是怎么样的" }),
          mentions: [{ key: "@_user_1", name: "牧火人事助手", id: { open_id: "ou_bot" } }]
        }
      }
    },
    {
      botOpenId: "ou_bot",
      knowledgeSourceUrls: "local",
      openaiApiKey: "local"
    },
    {
      tenantAccessToken: "local",
      loadKnowledgeDocuments: async () => [
        {
          title: "员工手册",
          url: "local",
          content: "考勤制度：工作时间为 9:00-18:00。上下班需要打卡。全勤奖 300 元/月。"
        }
      ],
      askOpenAI: async (_question, chunks) => (chunks.length ? "工作时间为 9:00-18:00，上下班需要打卡。" : bot.NO_ANSWER),
      replyToFeishuMessage: async (_messageId, text) => {
        console.log(text);
      }
    }
  );
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

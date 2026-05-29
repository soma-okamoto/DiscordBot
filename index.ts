import { Client, GatewayIntentBits, Message, TextChannel } from 'discord.js';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';

import 'dotenv/config'; // これを追加！

// ==========================================
// 1. カギの設定（環境変数から取得）
// ==========================================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const FORUM_CHANNEL_ID = process.env.FORUM_CHANNEL_ID || '';

if (!DISCORD_TOKEN || !GEMINI_API_KEY || !FORUM_CHANNEL_ID) {
    console.error("エラー: 必要な環境変数が設定されていません。");
    process.exit(1);
}
// ==========================================
// ==========================================

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.once('clientReady', () => {
    console.log(`ログイン完了: ${client.user?.tag} がオンラインになりました！`);
});

client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;

    const pdfAttachment = message.attachments.find(a => a.name.endsWith('.pdf'));
    if (pdfAttachment) {
        const textChannel = message.channel as TextChannel;
        const statusMsg = await textChannel.send("PDFを受け取りました.GeminiのAPIで解析しています...");

        try {
            // PDFデータをダウンロード
            const response = await fetch(pdfAttachment.url);
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            
            // ▼ pdf-parseの処理を全削除し、設定のみ定義 ▼
            const model = genAI.getGenerativeModel({ 
                model: 'gemini-2.5-flash',
                generationConfig: {
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: SchemaType.OBJECT as SchemaType.OBJECT,
                        properties: {
                            thread_title: {
                                type: SchemaType.STRING as SchemaType.STRING,
                                description: "Discordのスレッド用タイトル。'[何系] 簡潔な日本語要約'という形式。30文字以内。"
                            },
                            official_title: {
                                type: SchemaType.STRING as SchemaType.STRING,
                                description: "論文の正式な英語タイトル（重複チェックに使用します）"
                            },
                            summary: {
                                type: SchemaType.STRING as SchemaType.STRING,
                                description: "論文の概要。日本語で分かりやすく400文字程度で要約してください。"
                            }
                        },
                        required: ["thread_title", "official_title", "summary"]
                    },
                }
            });
            
            // ▼ Geminiに「PDFデータそのもの」を直接渡す！ ▼
            const prompt = "以下の論文PDFから情報を抽出し、指定されたフォーマットのJSONで出力してください。\n\n";
            const aiResult = await model.generateContent([
                prompt,
                {
                    inlineData: {
                        data: buffer.toString("base64"),
                        mimeType: "application/pdf"
                    }
                }
            ]);
            
            const paperData = JSON.parse(aiResult.response.text());

            const forumChannel = await client.channels.fetch(FORUM_CHANNEL_ID);
            if (!forumChannel || !forumChannel.isThreadOnly()) {
                await statusMsg.edit("⚠️ エラー: 指定されたIDはフォーラムチャンネルではありません。");
                return;
            }

            await statusMsg.edit("🔍 過去のフォーラム投稿と重複していないか確認しています...");

            const { threads } = await forumChannel.threads.fetchActive();
            let isDuplicate = false;

            for (const [_, thread] of threads) {
                try {
                    const firstMsg = await thread.fetchStarterMessage();
                    if (firstMsg && firstMsg.content.toLowerCase().includes(paperData.official_title.toLowerCase())) {
                        isDuplicate = true;
                        break;
                    }
                } catch (e) {
                    continue; 
                }
            }

            if (isDuplicate) {
                await statusMsg.edit(`❌ 重複エラー: フォーラム上に「**${paperData.official_title}**」の投稿がすでに存在するため、追加をスキップしました。`);
                return;
            }

            const appliedTags: string[] = [];
            const fullTextForTag = `${paperData.thread_title} ${paperData.summary}`;
            
            forumChannel.availableTags.forEach(tag => {
                if (fullTextForTag.includes(tag.name)) {
                    appliedTags.push(tag.id);
                }
            });
            
            if (appliedTags.length === 0 && forumChannel.availableTags.length > 0) {
                const defaultTag = forumChannel.availableTags[0];
                if (defaultTag && defaultTag.id) {
                    appliedTags.push(defaultTag.id);
                }
            }

            const contentText = `**【論文正式名】**\n${paperData.official_title}\n\n**【概要】**\n${paperData.summary}\n\n**【URL】**\n（必要に応じて手動追加）`;

            await forumChannel.threads.create({
                name: paperData.thread_title,
                message: {
                    content: contentText,
                    files: [{ attachment: buffer, name: pdfAttachment.name }]
                },
                appliedTags: appliedTags
            });

            await statusMsg.edit(`✅ フォーラムへの自動投稿が完了しました！\nタイトル: **${paperData.thread_title}**`);

        } catch (error) {
            console.error("エラー発生:", error);
            await statusMsg.edit(`❌ エラーが発生しました: ${error}`);
        }
    }
});

client.login(DISCORD_TOKEN);

// --- 無料枠で動かすためのダミーWebサーバー ---
import { createServer } from 'node:http';
createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot is running!');
}).listen(process.env.PORT || 3000);

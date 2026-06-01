import { Client, GatewayIntentBits, Message, TextChannel } from 'discord.js';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';

import 'dotenv/config'; 

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

client.on('messageCreate', async (message: Message) => {//Discordの発言したら起動
    
    if (message.author.bot) return;//Botの発言だったスキップ

    if (message.content.startsWith('\\bot ')) {
        // '\bot ' の後の文字列をキーワードとして抽出（小文字に変換して検索しやすくする）
        const keyword = message.content.slice(5).trim().toLowerCase();
        
        if (!keyword) {
            await message.reply("検索キーワードを指定してください。（例: `\\bot ロボット`）");
            return;
        }

        const statusMsg = await message.reply(`🔍 フォーラム内から「**${keyword}**」を検索しています...`);

        try {
            const forumChannel = await client.channels.fetch(FORUM_CHANNEL_ID);
            if (!forumChannel || !forumChannel.isThreadOnly()) {
                await statusMsg.edit("⚠️ エラー: フォーラムチャンネルが見つかりません。");
                return;
            }

            // フォーラム内のスレッドを取得（アーカイブされていないアクティブなもの）
            const { threads } = await forumChannel.threads.fetchActive();
            let results: string[] = [];

            for (const [_, thread] of threads) {
                // 1. スレッドのタイトルにキーワードが含まれているかチェック
                if (thread.name.toLowerCase().includes(keyword)) {
                    results.push(`・[${thread.name}](<https://discord.com/channels/${message.guildId}/${thread.id}>)`);
                    continue; // タイトルで見つかったら次のスレッドへ
                }
                
                // 2. タイトルになければ、スレッドの最初のメッセージ（要約テキスト）をチェック
                try {
                    const firstMsg = await thread.fetchStarterMessage();
                    if (firstMsg && firstMsg.content.toLowerCase().includes(keyword)) {
                        results.push(`・[${thread.name}](<https://discord.com/channels/${message.guildId}/${thread.id}>)`);
                    }
                } catch (e) {
                    continue;
                }
            }

            // 検索結果の表示
            if (results.length > 0) {
                // Discordの文字数制限に配慮し、最大10件まで表示
                const topResults = results.slice(0, 10);
                let replyText = `✅ 「**${keyword}**」の関連論文（${results.length}件）:\n${topResults.join('\n')}`;
                
                if (results.length > 10) {
                    replyText += `\n*...他 ${results.length - 10} 件*`;
                }
                await statusMsg.edit(replyText);
            } else {
                await statusMsg.edit(`❌ 「**${keyword}**」に一致する論文は見つかりませんでした。`);
            }

        } catch (error) {
            console.error("検索エラー:", error);
            await statusMsg.edit("❌ 検索中にエラーが発生しました。");
        }
        
        // 検索コマンドを実行した場合は、ここで処理を終了する（下のPDF処理には進まない）
        return; 
    }

    
    // 変更点1: findではなくfilterを使って、メッセージ内の「すべてのPDF」を配列として取得する
    const pdfAttachments = Array.from(message.attachments.values()).filter(a => a.name.endsWith('.pdf'));
    
    // PDFが1つ以上ある場合のみ処理を開始
    if (pdfAttachments.length > 0) {
        const textChannel = message.channel as TextChannel;
        const statusMsg = await textChannel.send(`📄 ${pdfAttachments.length}件のPDFを受け取りました！順番に解析を開始します...`);

        // 変更点2: forループを使って、PDFを1つずつ順番に処理する
        for (let i = 0; i < pdfAttachments.length; i++) {
            const pdfAttachment = pdfAttachments[i];
                        
            // ▼▼ この1行を追加（TypeScriptを安心させる） ▼▼
            if (!pdfAttachment) continue;
            
            const currentIndex = i + 1;

            try {
                // 現在どのファイルを処理しているか進捗を更新
                await statusMsg.edit(`⏳ [${currentIndex}/${pdfAttachments.length}] 「${pdfAttachment.name}」をAIで解析中...`);

                const response = await fetch(pdfAttachment.url);
                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                
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
                                publishDate: {
                                    type: SchemaType.STRING as SchemaType.STRING,
                                    description: "論文の公開日付（YYYY-MM-DD形式）"
                                },
                                summary: {
                                    type: SchemaType.STRING as SchemaType.STRING,
                                    description: "論文の概要。日本語で分かりやすく400文字程度で要約してください。"
                                }

                            },
                            required: ["thread_title", "official_title", "summary", "publishDate"]
                        },
                    }
                });
                
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
                    // 変更点3: return（強制終了）ではなく、continue（スキップして次のPDFへ）にする
                    await textChannel.send(`⚠️ エラー: 指定されたIDはフォーラムチャンネルではありません。（対象: ${pdfAttachment.name}）`);
                    continue; 
                }

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
                    await textChannel.send(`❌ スキップ: 「**${paperData.official_title}**」はすでに投稿されています。（対象: ${pdfAttachment.name}）`);
                    continue; // 重複していてもループを止めずに次へ
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

                const contentText = `**【論文正式名】**\n${paperData.official_title}\n\n**【公開日付】**\n${paperData.publishDate}\n\n**【概要】**\n${paperData.summary}\n\n**【URL】**\n（必要に応じて手動追加）`;

                await forumChannel.threads.create({
                    name: paperData.thread_title,
                    message: {
                        content: contentText,
                        files: [{ attachment: buffer, name: pdfAttachment.name }]
                    },
                    appliedTags: appliedTags
                });

                // 成功したファイルごとに完了メッセージを送信
                await textChannel.send(`✅ 投稿完了: **${paperData.thread_title}**`);

            } catch (error) {
                console.error(`エラー発生 (${pdfAttachment.name}):`, error);
                await textChannel.send(`❌ エラーが発生しました（対象: ${pdfAttachment.name}）: ${error}`);
            }
        }
        
        // 全部のループが終わったら最終ステータスを更新
        await statusMsg.edit(`🎉 すべてのPDF（全${pdfAttachments.length}件）の処理が完了しました！`);
    }
});

client.login(DISCORD_TOKEN);

// --- 無料枠で動かすためのダミーWebサーバー ---
import { createServer } from 'node:http';
createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot is running!');
}).listen(process.env.PORT || 3000);
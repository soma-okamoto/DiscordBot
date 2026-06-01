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

    //////////////////////////////////////////////////////////////////
    if (message.content.startsWith('\\bot ')) {
        const query = message.content.slice(5).trim();
        
        if (!query) {
            await message.reply("検索したい内容や要望を教えてください。（例: `\\bot 遠隔操作をやりやすくする技術はない？`）");
            return;
        }

        const statusMsg = await message.reply(` AIが「**${query}**」に役立ちそうな論文を思考・検索しています...`);

        try {
            const forumChannel = await client.channels.fetch(FORUM_CHANNEL_ID);
            if (!forumChannel || !forumChannel.isThreadOnly()) {
                await statusMsg.edit("⚠️ エラー: フォーラムチャンネルが見つかりません。");
                return;
            }

// 1. フォーラム内のスレッド（論文）の「ID」「タイトル」「投稿文字列の塊」のリストを作る
            const { threads } = await forumChannel.threads.fetchActive();
            let paperList: any[] = [];
            
            for (const [_, thread] of threads) {
                try {
                    // スレッド内の最新メッセージを最大10件取得
                    const messages = await thread.messages.fetch({ limit: 10 });
                    
                    // メッセージのテキストだけを抽出し、1つの長い文字列に結合する
                    const threadText = messages
                        .reverse()
                        .map(m => m.content)
                        .filter(content => content.trim() !== '') // 空文字や画像のみの投稿を除外
                        .join('\n---\n') // メッセージ間の区切り
                        .substring(0, 3000); // 1スレッドあたり最大3000文字でカット

                    paperList.push({ 
                        id: thread.id, 
                        title: thread.name,
                        discussion: threadText || "テキストなし" 
                    });
                } catch (e) {
                    // 取得エラーが起きてもスレッド自体はリストに入れる
                    paperList.push({ id: thread.id, title: thread.name });
                }
            }


            if (paperList.length === 0) {
                await statusMsg.edit("フォーラムにまだ論文が登録されていません。");
                return;
            }

            // 2. Geminiにリストと要望を渡して、合致するものを考えさせる
            const searchModel = genAI.getGenerativeModel({ 
                model: 'gemini-2.5-flash',
                generationConfig: {
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: SchemaType.OBJECT as SchemaType.OBJECT,
                        properties: {
                            matches: {
                                type: SchemaType.ARRAY as SchemaType.ARRAY,
                                items: {
                                    type: SchemaType.OBJECT as SchemaType.OBJECT,
                                    properties: {
                                        id: { type: SchemaType.STRING as SchemaType.STRING },
                                        reason: { 
                                            type: SchemaType.STRING as SchemaType.STRING,
                                            description: "なぜこの論文がユーザーの要望に役立つのか、推薦理由を日本語で1〜2文で説明してください。"
                                        }
                                    },
                                    required: ["id", "reason"]
                                }
                            }
                        },
                        required: ["matches"]
                    }
                }
            });

           const prompt = `
            ユーザーから以下の要望や質問がありました。
            ユーザーの要望: 「${query}」

            以下の論文リストの中から、この要望の解決や関連知識として役立ちそうな論文を【該当するものすべて】選んでください。
            キーワードが完全に一致していなくても、意味や文脈が合致していれば推薦してください。
            全く関連するものがない場合は、matches の中身を空にして返してください。

            データベースの論文リスト:
            ${JSON.stringify(paperList)}
            `;

            const aiResult = await searchModel.generateContent(prompt);
            const searchData = JSON.parse(aiResult.response.text());

            // 3. AIの回答をもとに、Discordへ返信するテキストを作る
            if (searchData.matches && searchData.matches.length > 0) {
                let currentText = `✅ 「**${query}**」について、AIが該当する論文をすべてピックアップしました！\n\n`;
                let messageQueue: string[] = []; // 分割送信用の配列
                
                searchData.matches.forEach((match: { id: string; reason: string }) => {
                    const thread = threads.get(match.id);
                    if (thread) {
                        const entry = `**[${thread.name}](<https://discord.com/channels/${message.guildId}/${thread.id}>)**\n💡 **推薦理由:** ${match.reason}\n\n`;
                        
                        // ▼ 変更点2：Discordの2000文字制限対策（1900文字を超えそうなら分割する）
                        if (currentText.length + entry.length > 1900) {
                            messageQueue.push(currentText); // 今の塊を配列に保存
                            currentText = entry;            // 新しい塊を作り始める
                        } else {
                            currentText += entry;
                        }
                    }
                });
                
                // 最後の余ったテキストを配列に追加
                if (currentText.length > 0) {
                    messageQueue.push(currentText);
                }
                
                // 分割したメッセージを順番にDiscordへ送信
                await statusMsg.edit(messageQueue[0]); // 1つ目は「検索中...」のメッセージを上書き
                for (let i = 1; i < messageQueue.length; i++) {
                    await message.reply(messageQueue[i]); // 2つ目以降は返信として連続投稿
                }
                
            } else {
                await statusMsg.edit(`❌ 「**${query}**」に役立ちそうな論文は、現在のデータベースには見つかりませんでした。`);
            }

        } catch (error) {
            console.error("検索エラー:", error);
            await statusMsg.edit("❌ 検索中にエラーが発生しました。ログを確認してください。");
        }
        
        return; // 検索処理が終わったらここで終了
        
//////////////////////////////////////////////////////////
    
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
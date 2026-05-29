# 最新のNode.js環境をベースにする
FROM node:24-slim

# 作業ディレクトリの設定
WORKDIR /app

# パッケージ設定ファイルをコピーしてライブラリをインストール
COPY package*.json ./
RUN npm install

# ソースコードをすべてコピー
COPY . .

# TypeScriptをビルド
RUN npx tsc

# ボットを起動
CMD ["node", "dist/index.js"]
##重要## buildはrootのnpm scriptで行うこと（npm run api:docker:build）

# ECRのPublic Repositoryのイメージをベースとする
# ImageのPullでエラーになる場合は、以下のコマンドを実行すること（要AWS CLI）
# ```
# aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws
# ```

# buildステージ
FROM public.ecr.aws/docker/library/node:20.9-bullseye as build

# npm workspacesを利用しているため、rootフォルダを起点にコピー等を行う
COPY ./package*.json ./
# COPY ./packages/common/ ./packages/common/
COPY ./packages/api/ ./packages/api/

# # 脆弱性対応のため最新版にアップグレード
# RUN npm i -g npm@8.19.4

# buildの実行
RUN npm ci
RUN npm run api:build

# applicationのステージ
FROM public.ecr.aws/docker/library/node:20.9-bullseye-slim

WORKDIR "/srv/app"
ENV PORT=3000

# npm workspaceを利用しているため、rootフォルダを起点にコピー等を行う
# buildの生成物をapplicationのイメージにCOPY
COPY package*.json ./
COPY --from=build ./packages/api/dist/ ./packages/api/dist/
COPY --from=build ./packages/api/prisma/ ./packages/api/prisma/
COPY --from=build ./packages/api/package.json ./packages/api/package.json 
# COPY --from=build ./packages/common/ ./packages/common/ 

# # 脆弱性対応のため最新版にアップグレード
# RUN npm i -g npm@8.19.4

# opensslのインストール（Prisma実行のため）
RUN apt-get update
RUN apt-get -y install openssl

# DevDepencenciesを除いてinstall
RUN npm ci 
RUN npm run api:db:generate

USER node
EXPOSE 3000 3001
CMD ["npm", "run", "api:start:prod"]
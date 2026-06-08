# 使用 Node.js 18 Alpine 基础镜像
FROM node:18-alpine

# 安装 better-sqlite3 编译所需的构建工具
# 原因：better-sqlite3 是原生模块，需要 node-gyp 编译
RUN apk add --no-cache python3 make g++

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖（包括 better-sqlite3 编译）
RUN npm ci --only=production

# 复制应用代码
COPY . .

# 创建数据目录（SQLite 数据库存储位置）
RUN mkdir -p /app/data

# 暴露端口
EXPOSE 30001

# 启动应用
CMD ["node", "src/server.js"]

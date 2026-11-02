FROM node:22-slim
WORKDIR /app
COPY package.json server.js ./
ENV PORT=8080 DB=/data/data.db
EXPOSE 8080
CMD ["node", "--no-warnings", "server.js"]

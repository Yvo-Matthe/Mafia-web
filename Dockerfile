FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DB_FILE=/data/mafia.db PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 8080
CMD ["npm", "start"]

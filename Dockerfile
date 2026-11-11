FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY index.js bot.js db.js roll.js render.js ./
COPY fonts ./fonts
ENV NODE_ENV=production DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
CMD ["node", "--no-warnings", "index.js"]

# Node 22, not 20: supabase-js eagerly builds a Realtime client that needs a
# global WebSocket, which Node 20 does not have. We never use realtime, but
# createClient initialises it anyway and throws on boot.
FROM node:22-alpine

# ffmpeg + ffprobe from Alpine's repo: no custom build, no GPL codec surprises
# beyond what the distro already ships.
RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["node", "index.js"]

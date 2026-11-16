# Stufe 1: Client bauen (Vite, three.js und cannon-es werden ins Bundle gepackt)
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY public public
COPY src src
RUN npm run build

# Stufe 2: schlankes Laufzeit-Image – nur der Relay-Server (einzige Abhängigkeit: ws) und dist/
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server server
COPY --from=build /app/dist dist
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8787/ || exit 1
CMD ["node", "server/server.js"]

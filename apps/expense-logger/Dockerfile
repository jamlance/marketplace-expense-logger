# Multi-stage build for Expense Logger.
FROM node:20-alpine AS builder
WORKDIR /work
RUN apk add --no-cache git python3 make g++
RUN npm install -g pnpm@9
COPY package.json pnpm-workspace.yaml ./
COPY packages/core ./packages/core
COPY apps/expense-logger ./apps/expense-logger
RUN pnpm install --no-frozen-lockfile
WORKDIR /work/apps/expense-logger
RUN pnpm exec vite build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache git
COPY --from=builder /work/package.json /work/pnpm-workspace.yaml ./
COPY --from=builder /work/node_modules ./node_modules
COPY --from=builder /work/packages ./packages
COPY --from=builder /work/apps/expense-logger/package.json ./apps/expense-logger/package.json
COPY --from=builder /work/apps/expense-logger/node_modules ./apps/expense-logger/node_modules
COPY --from=builder /work/apps/expense-logger/dist ./apps/expense-logger/dist
COPY apps/expense-logger/server.js ./apps/expense-logger/server.js
EXPOSE 3000
ENV PORT=3000 HOST=0.0.0.0
WORKDIR /app/apps/expense-logger
CMD ["node", "server.js"]

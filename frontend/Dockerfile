FROM node:22-alpine
WORKDIR /usr/src/app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
EXPOSE 5173
CMD ["pnpm", "run", "dev"]
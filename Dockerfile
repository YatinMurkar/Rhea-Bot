FROM node:20-slim

WORKDIR /app

# Install CA certificates and OpenSSL - required for MongoDB Atlas TLS connections
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json tsconfig.json ./
RUN npm install

COPY . .

# Many cloud platforms inject their own PORT environment variable
EXPOSE 3000

CMD ["npx", "ts-node", "--transpile-only", "index.ts"]

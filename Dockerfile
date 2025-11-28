#FROM node:24-alpine
FROM ghcr.io/puppeteer/puppeteer:latest

# Set environment variables for Chromium
ENV XDG_CONFIG_HOME=/tmp/.chromium
ENV XDG_CACHE_HOME=/tmp/.chromium

WORKDIR /app

COPY package.json ./
RUN npm install

COPY export.js .

EXPOSE 8000

CMD ["npm", "start"]
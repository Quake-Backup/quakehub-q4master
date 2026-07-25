FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY tools ./tools
COPY seeds.json ./
EXPOSE 27650/udp
CMD ["node", "src/index.js"]

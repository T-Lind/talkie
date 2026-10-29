# Team Talkie server image.
# Build the bundled server first:  npm run build:server
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY dist/server.js ./server.js

USER node
EXPOSE 8080
CMD ["node", "server.js"]

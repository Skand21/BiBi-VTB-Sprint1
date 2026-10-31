FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4173 BIBI_HOST=0.0.0.0
COPY --chown=node:node package.json server.mjs index.html ./
COPY --chown=node:node src ./src
COPY --chown=node:node lib ./lib
COPY --chown=node:node assets ./assets
USER node
ENV BIBI_DATA_DIR=/tmp/bibi-data
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:4173/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]

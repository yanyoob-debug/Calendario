FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DB_PATH=/app/data/agenda.sqlite
USER node
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/auth/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

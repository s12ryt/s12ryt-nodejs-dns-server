FROM node:20-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:20-bookworm-slim
RUN groupadd --gid 10001 s12 \
    && useradd --uid 10001 --gid s12 --home-dir /app --shell /usr/sbin/nologin s12
WORKDIR /app
COPY --from=dependencies --chown=s12:s12 /app/node_modules ./node_modules
COPY --chown=s12:s12 package.json index.js ./
COPY --chown=s12:s12 src ./src
RUN mkdir -p /app/data && chown s12:s12 /app/data
USER s12
VOLUME ["/app/data"]
EXPOSE 5354/udp 5354/tcp 8053/tcp 8080/tcp 8081/tcp 9090/tcp
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8081/api/bootstrap').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "index.js"]

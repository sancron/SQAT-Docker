FROM denoland/deno:2.9.5

WORKDIR /app
COPY --chown=deno:deno deno.json ./
COPY --chown=deno:deno src ./src
RUN deno cache src/server.ts
USER deno
EXPOSE 8080/tcp
CMD ["run", "--allow-net", "--allow-env", "src/server.ts"]


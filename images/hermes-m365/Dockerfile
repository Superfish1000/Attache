# Hermes agent + Microsoft 365 MCP server baked in (install once, per-user
# state stays on each agent's mounted data dir).
#
#   docker build -t hermes-m365 images/hermes-m365
#
# Then point a container definition's image at `hermes-m365`. Upgrading the
# MCP server = bump the pin, rebuild, Regenerate agents — token caches live
# in the agents' data dirs, so nobody re-logs-in.
#
# Old Docker daemons (pre-20.10.10): `docker build` fails with exit 134 —
# the builder's seccomp profile blocks clone3 and npm aborts. Fallback:
#   docker run --name m365build --security-opt seccomp=unconfined \
#     --entrypoint sh nousresearch/hermes-agent:latest \
#     -c "npm install -g @softeria/ms-365-mcp-server@0.134.4"
#   docker commit --change 'ENTRYPOINT ["/init","/opt/hermes/docker/main-wrapper.sh"]' \
#     --change 'CMD []' m365build hermes-m365 && docker rm m365build
FROM nousresearch/hermes-agent:latest

# Pinned per deployment guide; node/npm ship with the hermes image.
RUN npm install -g @softeria/ms-365-mcp-server@0.134.4

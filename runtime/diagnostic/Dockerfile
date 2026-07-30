FROM alpine:3.22

COPY biunivers-diagnostic /usr/local/bin/biunivers-diagnostic
RUN chmod 0555 /usr/local/bin/biunivers-diagnostic

USER 65532:65532
ENTRYPOINT ["/usr/local/bin/biunivers-diagnostic"]

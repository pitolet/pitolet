FROM alpine:3.22

RUN apk add --no-cache openssh-client postgresql17-client restic

COPY backup.sh /usr/local/bin/pitolet-backup
RUN chmod 0755 /usr/local/bin/pitolet-backup

ENTRYPOINT ["/usr/local/bin/pitolet-backup"]

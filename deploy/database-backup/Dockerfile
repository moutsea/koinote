FROM postgres:16-alpine

RUN apk add --no-cache ca-certificates curl jq openssl tzdata

COPY backup.sh /usr/local/bin/koinote-database-backup
COPY entrypoint.sh /usr/local/bin/koinote-database-backup-loop
COPY healthcheck.sh /usr/local/bin/koinote-database-backup-health
COPY database-backup-certificate.pem /etc/koinote/database-backup-certificate.pem

RUN chmod 755 \
      /usr/local/bin/koinote-database-backup \
      /usr/local/bin/koinote-database-backup-loop \
      /usr/local/bin/koinote-database-backup-health \
    && chmod 444 /etc/koinote/database-backup-certificate.pem \
    && mkdir -p /var/lib/koinote-backup

ENTRYPOINT ["/usr/local/bin/koinote-database-backup-loop"]

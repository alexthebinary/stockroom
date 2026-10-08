# pg_dump / pg_restore matching the database, plus rclone for Cloudflare R2.
FROM postgres:16-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends rclone curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY backup.sh restore-db.sh /usr/local/bin/
ENTRYPOINT ["/usr/local/bin/backup.sh"]

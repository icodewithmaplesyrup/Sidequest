#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════
#  setup-debian.sh
#  One-shot Debian 12 (Bookworm) server setup for Sidequest.
#  Run as root on a fresh server.
#
#  Usage:  sudo bash scripts/setup-debian.sh
# ════════════════════════════════════════════════════════════
set -euo pipefail

APP_USER="sidequest"
APP_DIR="/opt/sidequest"
UPLOAD_DIR="/var/sidequest/uploads"
LOG_DIR="/var/log/sidequest"
DOMAIN="${DOMAIN:-}"   # set via env or fill in below

echo "══════════════════════════════════════════"
echo " Sidequest — Debian Server Setup"
echo "══════════════════════════════════════════"

# ── 1. System packages ────────────────────────────────────
apt-get update -qq
apt-get install -y --no-install-recommends \
  curl gnupg2 ca-certificates \
  nginx \
  postgresql postgresql-contrib postgis \
  redis-server \
  ufw \
  logrotate \
  git \
  build-essential

# ── 2. Node.js 20 LTS ─────────────────────────────────────
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "Node: $(node -v), npm: $(npm -v)"

# ── 3. PM2 ────────────────────────────────────────────────
npm install -g pm2

# ── 4. App user & directories ─────────────────────────────
id -u "$APP_USER" &>/dev/null || useradd -r -s /usr/sbin/nologin -m "$APP_USER"

mkdir -p "$APP_DIR" "$UPLOAD_DIR/videos" "$UPLOAD_DIR/thumbnails" "$LOG_DIR"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR" "$UPLOAD_DIR" "$LOG_DIR"

# ── 5. PostgreSQL ─────────────────────────────────────────
echo "Setting up PostgreSQL…"
DB_PASS=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)

sudo -u postgres psql <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='sidequest') THEN
    CREATE ROLE sidequest WITH LOGIN PASSWORD '${DB_PASS}';
  END IF;
END \$\$;

CREATE DATABASE sidequest OWNER sidequest;
-- Enable postgis on the DB
\c sidequest
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS postgis;
SQL

echo "DATABASE_URL=postgresql://sidequest:${DB_PASS}@localhost:5432/sidequest" >> /tmp/sidequest.env
echo "Postgres password saved to /tmp/sidequest.env — move this to ${APP_DIR}/.env"

# ── 6. Redis (bind localhost only) ────────────────────────
sed -i 's/^bind 127.0.0.1 ::1/bind 127.0.0.1/' /etc/redis/redis.conf
systemctl enable redis-server
systemctl restart redis-server

# ── 7. UFW firewall ───────────────────────────────────────
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# ── 8. Nginx reverse proxy ────────────────────────────────
cat > /etc/nginx/sites-available/sidequest <<'NGINX'
# Sidequest API reverse proxy
# Replace yourdomain.com before enabling SSL

upstream sidequest_api {
    server 127.0.0.1:3000;
    keepalive 32;
}

# HTTP → HTTPS redirect (uncomment after certbot)
# server {
#   listen 80;
#   server_name yourdomain.com;
#   return 301 https://$host$request_uri;
# }

server {
    listen 80;
    server_name _;   # replace with yourdomain.com once DNS is set

    # Upload size limit (match MAX_VIDEO_SIZE_MB)
    client_max_body_size 110m;

    # Media files served directly by nginx (faster than node)
    location /media/ {
        alias /var/sidequest/uploads/;
        expires 7d;
        add_header Cache-Control "public, immutable";
        add_header X-Content-Type-Options nosniff;
        # Only allow video and image types
        location ~* \.(mp4|webm|mov|jpg|jpeg|png|gif)$ { }
        location / { return 403; }
    }

    location / {
        proxy_pass         http://sidequest_api;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade         $http_upgrade;
        proxy_set_header   Connection      "upgrade";
        proxy_set_header   Host            $host;
        proxy_set_header   X-Real-IP       $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/sidequest /etc/nginx/sites-enabled/sidequest
rm -f /etc/nginx/sites-enabled/default

nginx -t && systemctl enable nginx && systemctl reload nginx

# ── 9. Log rotation ───────────────────────────────────────
cat > /etc/logrotate.d/sidequest <<'LOGROTATE'
/var/log/sidequest/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    sharedscripts
    postrotate
        pm2 reloadLogs
    endscript
}
LOGROTATE

# ── 10. PM2 ecosystem file ────────────────────────────────
cat > "$APP_DIR/ecosystem.config.js" <<'PM2'
module.exports = {
  apps: [{
    name:       'sidequest',
    script:     'server.js',
    cwd:        '/opt/sidequest',
    user:       'sidequest',
    instances:  'max',          // one per CPU core
    exec_mode:  'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
    env_file:   '/opt/sidequest/.env',
    error_file: '/var/log/sidequest/error.log',
    out_file:   '/var/log/sidequest/out.log',
    merge_logs: true,
    max_memory_restart: '512M',
  }],
};
PM2

chown "$APP_USER":"$APP_USER" "$APP_DIR/ecosystem.config.js"

# ── 11. PM2 startup on boot ───────────────────────────────
env PATH=$PATH:/usr/bin pm2 startup systemd -u "$APP_USER" --hp /home/"$APP_USER" || true

# ── 12. Disk usage warning cron ──────────────────────────
# 256 GB SSD — warn at 80% usage
cat > /etc/cron.d/sidequest-disk <<'CRON'
0 * * * * root df -h /var/sidequest/uploads | awk 'NR==2 {gsub(/%/,"",$5); if($5>80) print "WARN: Upload disk " $5 "% full"}' | logger -t sidequest-disk
CRON

echo ""
echo "══════════════════════════════════════════"
echo " Setup complete!"
echo "══════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Copy your code to $APP_DIR"
echo "  2. cp /tmp/sidequest.env $APP_DIR/.env"
echo "  3. Fill remaining .env values (JWT_SECRET, GOOGLE_CLIENT_ID, etc.)"
echo "  4. cd $APP_DIR && npm install --omit=dev"
echo "  5. node db/migrate.js   (runs schema.sql)"
echo "  6. pm2 start ecosystem.config.js"
echo "  7. pm2 save"
echo ""
echo "  For SSL (requires a real domain):"
echo "  apt-get install certbot python3-certbot-nginx"
echo "  certbot --nginx -d yourdomain.com"
echo ""
echo "  Upload dir: $UPLOAD_DIR"
echo "  DB password in: /tmp/sidequest.env (delete after copying!)"

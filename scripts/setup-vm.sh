#!/usr/bin/env bash
# setup-vm.sh — run ONCE as root (or with sudo) on a fresh Ubuntu 22.04 VM
# Usage: sudo bash scripts/setup-vm.sh <your-domain.com> <deploy-user>
#
# ATENÇÃO: se o bot-lash-designer for rodar na MESMA VM do bot-barbeiro
# (VM já provisionada), NÃO rode este script — ele criaria um site nginx
# 'bot' na porta 443 que conflita com o setup existente. Em vez disso,
# instale o arquivo nginx-lash-designer.conf (já escuta na porta 8444).
set -euo pipefail

DOMAIN="${1:?Usage: $0 <domain> <deploy-user>}"
DEPLOY_USER="${2:?Usage: $0 <domain> <deploy-user>}"

echo "=== [1/7] System update ==="
apt-get update -y && apt-get upgrade -y

echo "=== [2/7] Firewall (ufw) ==="
apt-get install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP (Let's Encrypt challenge)
ufw allow 443/tcp   # HTTPS
# Block 3000 and 3001 from outside — bot and WAHA are internal only
ufw --force enable
ufw status verbose

echo "=== [3/7] SSH hardening ==="
# Disable password auth — key-only login
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?X11Forwarding.*/X11Forwarding no/' /etc/ssh/sshd_config
# Max auth attempts
grep -q '^MaxAuthTries' /etc/ssh/sshd_config \
  && sed -i 's/^MaxAuthTries.*/MaxAuthTries 3/' /etc/ssh/sshd_config \
  || echo 'MaxAuthTries 3' >> /etc/ssh/sshd_config
systemctl reload sshd

echo "=== [4/7] Fail2ban (brute-force protection) ==="
apt-get install -y fail2ban
cat > /etc/fail2ban/jail.local <<'EOF'
[sshd]
enabled  = true
port     = ssh
maxretry = 5
bantime  = 3600
findtime = 600

[nginx-http-auth]
enabled  = true
port     = http,https
maxretry = 10
bantime  = 3600
EOF
systemctl enable fail2ban
systemctl restart fail2ban

echo "=== [5/7] Docker ==="
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
usermod -aG docker "$DEPLOY_USER"

echo "=== [6/7] Node.js 20 + PM2 ==="
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
npm install -g pm2
pm2 startup systemd -u "$DEPLOY_USER" --hp "/home/$DEPLOY_USER"

echo "=== [7/7] Nginx + Certbot (Let's Encrypt) ==="
apt-get install -y nginx certbot python3-certbot-nginx

# Basic nginx config (HTTP only — certbot will add HTTPS)
cat > /etc/nginx/sites-available/bot <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    # Let's Encrypt challenge
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}
EOF

ln -sf /etc/nginx/sites-available/bot /etc/nginx/sites-enabled/bot
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# Issue certificate
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
  --email "business.shooty@gmail.com" --redirect

# Write final HTTPS config (certbot modifies the file, we enhance it)
cat > /etc/nginx/sites-available/bot <<EOF
# Rate limiting zones
limit_req_zone \$binary_remote_addr zone=webhook:10m rate=30r/m;
limit_req_zone \$binary_remote_addr zone=admin:10m    rate=60r/m;
limit_req_zone \$binary_remote_addr zone=general:10m  rate=120r/m;

server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    server_name $DOMAIN;

    # TLS — managed by Certbot
    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    # Security headers
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options    "nosniff"                                      always;
    add_header X-Frame-Options           "DENY"                                         always;
    add_header X-XSS-Protection          "1; mode=block"                                always;
    add_header Referrer-Policy           "strict-origin-when-cross-origin"              always;
    add_header Permissions-Policy        "geolocation=(), microphone=(), camera=()"     always;
    add_header Content-Security-Policy   "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';" always;

    # Hide server version
    server_tokens off;

    # Webhook — only allow from localhost (WAHA is internal)
    location /webhook/ {
        allow 127.0.0.1;
        deny all;
        limit_req zone=webhook burst=10 nodelay;
        proxy_pass         http://127.0.0.1:3003;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 30s;
    }

    # Admin dashboard
    location /admin {
        limit_req zone=admin burst=20 nodelay;
        proxy_pass         http://127.0.0.1:3003;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 30s;
    }

    # Health check + static
    location / {
        limit_req zone=general burst=30 nodelay;
        proxy_pass         http://127.0.0.1:3003;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 30s;
    }
}
EOF

nginx -t && systemctl reload nginx

echo ""
echo "✅ VM setup complete!"
echo "   Domain:  https://$DOMAIN"
echo "   Next:    cd ~/bot && cp .env.example .env && nano .env"
echo "            bash scripts/deploy.sh"

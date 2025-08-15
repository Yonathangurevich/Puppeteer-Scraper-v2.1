FROM ghcr.io/flaresolverr/flaresolverr:latest

# Environment variables for Railway
ENV LOG_LEVEL=info
ENV LOG_HTML=false
ENV CAPTCHA_SOLVER=none
ENV TZ=UTC
ENV LANG=en_US.UTF-8

# Performance optimizations
ENV BROWSER_TIMEOUT=40000
ENV MAX_TIMEOUT=60000
ENV TEST_URL=https://www.google.com
ENV PORT=8191
ENV HOST=0.0.0.0

# Chrome flags for better performance
ENV DRIVER_ARGUMENTS="--disable-gpu --no-sandbox --disable-dev-shm-usage --disable-setuid-sandbox --window-size=1920,1080 --disable-web-security --disable-features=VizDisplayCompositor --disable-blink-features=AutomationControlled"

# Expose port
EXPOSE 8191

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:8191/health || exit 1

# Custom FlareSolverr with Node.js wrapper
FROM python:3.11-slim

# Install Node.js
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Chrome dependencies
RUN apt-get update && apt-get install -y \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libwayland-client0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install FlareSolverr
RUN pip install --no-cache-dir flaresolverr

# Copy Node.js app files
COPY package*.json ./
RUN npm install

COPY server.js ./

# Environment variables
ENV LOG_LEVEL=info
ENV LOG_HTML=false
ENV CAPTCHA_SOLVER=none
ENV BROWSER_TIMEOUT=40000
ENV MAX_TIMEOUT=60000
ENV PORT=8191

EXPOSE 8191

# Run the Node.js wrapper which will manage FlareSolverr
CMD ["node", "server.js"]

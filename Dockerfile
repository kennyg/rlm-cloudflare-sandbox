FROM docker.io/cloudflare/sandbox:0.6.7

# Install Python
RUN apt-get update && apt-get install -y python3 python3-pip && rm -rf /var/lib/apt/lists/*

# Required during local development
EXPOSE 8080

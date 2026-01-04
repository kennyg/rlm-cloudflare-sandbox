FROM docker.io/cloudflare/sandbox:0.6.7

# Install Python
RUN apt-get update && apt-get install -y python3 && rm -rf /var/lib/apt/lists/*

# Required during local development to access exposed ports
EXPOSE 8080

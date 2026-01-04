FROM python:3.11-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python packages commonly used in RLM
RUN pip install --no-cache-dir \
    numpy>=1.26.0 \
    pandas>=2.1.0 \
    scipy>=1.11.0 \
    sympy>=1.12 \
    requests>=2.31.0 \
    httpx>=0.25.0 \
    pyyaml>=6.0 \
    tqdm>=4.66.0 \
    python-dateutil>=2.8.2 \
    dill>=0.3.7

# Create workspace directory
WORKDIR /workspace

# Default command
CMD ["python3"]

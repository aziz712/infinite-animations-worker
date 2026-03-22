FROM node:20-slim

# Install ffmpeg + ffprobe (required for video assembly)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg espeak-ng && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Verify installation
RUN ffmpeg -version && ffprobe -version

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY server.js ./

# Expose port
EXPOSE 3000

# Start the worker
CMD ["node", "server.js"]

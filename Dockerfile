FROM n8nio/n8n:latest

USER root

# Install ffmpeg
RUN apt-get update && apt-get install -y ffmpeg

# Verify installation
RUN ffmpeg -version

USER node

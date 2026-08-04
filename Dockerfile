FROM python:3.11-slim

WORKDIR /app

# Install dependencies first (layer cache)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy bot code
COPY bot.py .

# Persistent data directory (mount as a volume in Railway)
RUN mkdir -p /data
ENV DATA_DIR=/data

EXPOSE 8080

CMD ["python", "bot.py"]

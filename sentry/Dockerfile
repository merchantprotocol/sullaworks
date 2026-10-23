FROM python:3.12-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends nmap arp-scan iproute2 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir zeroconf==0.136.2
WORKDIR /app
COPY sentry.py .
ENV PYTHONUNBUFFERED=1
# Needs host networking plus NET_RAW/NET_ADMIN to see the LAN (see docker-compose.yml).
CMD ["python", "sentry.py"]

FROM python:3.12-slim

WORKDIR /app

# Install openslide C-library
RUN apt-get update && apt-get install -y \
    openslide-tools \
    libopenslide-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application
COPY . .

# Expose the port the app runs on
EXPOSE 5050

# Run the application
CMD ["python", "app.py"]

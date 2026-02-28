FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    openslide-tools \
    libopenslide-dev \
    && rm -rf /var/lib/apt/lists/*

# Look inside the folder for requirements
COPY wsi-viewer/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy all the python code from inside the folder
COPY wsi-viewer/ .

EXPOSE 5050

CMD ["python", "app.py"]

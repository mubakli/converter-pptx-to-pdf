FROM node:20-alpine

# LibreOffice and required fonts installation
RUN apk add --no-cache libreoffice \
    font-droid-nonlatin \
    font-droid \
    font-noto \
    font-liberation \
    ttf-dejavu

# Set working directory
WORKDIR /app

# Copy package descriptors 
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build Next.js
RUN npm run build

# Crucial for Docker: Allow connections from outside the container
ENV HOSTNAME="0.0.0.0"
ENV PORT=8080
EXPOSE 8080

# Start server
CMD ["npm", "start"]

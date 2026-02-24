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

# Install dependencies (ignoring scripts & strict overrides)
RUN npm install

# Copy source code
COPY . .

# Build Next.js
RUN npm run build

# Expose port
EXPOSE 3000

# Start server
CMD ["npm", "start"]
